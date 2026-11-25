/* global Chart */
'use strict';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'claude-usage:v1';
const TYPES = [
  { key: 'input', label: 'Input', slot: 1 },
  { key: 'output', label: 'Output', slot: 2 },
  { key: 'cacheWrite', label: 'Cache write', slot: 3 },
  { key: 'cacheRead', label: 'Cache read', slot: 4 },
];
const TOP_PROJECTS = 6;

let DATA = null;
let projectColor = {}; // project key -> slot index (fixed by all-time cost, so filters never repaint)
let topProjects = [];
const charts = {};

const state = Object.assign(
  { range: '30', from: '', to: '', project: '', model: '', thread: 'all', measure: 'cost', session: '', search: '', theme: '' },
  readStore()
);
state.session = '';
state.search = '';

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveStore() {
  try {
    const { range, from, to, project, model, thread, measure, theme } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ range, from, to, project, model, thread, measure, theme }));
  } catch {}
}

/* ---------- formatting ---------- */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const slotColor = (i) => css(`--s${i}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtUSD(v, precise) {
  if (!v) return '$0';
  if (precise || v < 10) return '$' + v.toFixed(v < 1 ? 3 : 2);
  if (v < 1000) return '$' + v.toFixed(0);
  if (v < 1e6) return '$' + (v / 1e3).toFixed(v < 1e4 ? 2 : 1) + 'K';
  return '$' + (v / 1e6).toFixed(2) + 'M';
}
function fmtTok(v) {
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return (v / 1e3).toFixed(v < 1e4 ? 1 : 0) + 'K';
  if (v < 1e9) return (v / 1e6).toFixed(v < 1e7 ? 2 : 1) + 'M';
  return (v / 1e9).toFixed(2) + 'B';
}
const fmtMeasure = (v) => (state.measure === 'cost' ? fmtUSD(v) : fmtTok(v));
const fmtPct = (v) => (v >= 0.1 ? (v * 100).toFixed(0) : (v * 100).toFixed(1)) + '%';
const tokensOf = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;
const valueOf = (t) => (state.measure === 'cost' ? t.cost : tokensOf(t));
const typeValue = (t, key) => (state.measure === 'cost' ? t.costParts[key] : t[key]);

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDay(day, n) {
  const d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDay(d);
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function projectName(key) {
  const name = DATA.projects[key] || key;
  return name === '~' ? '~ (home folder)' : name.replace(/^~\//, '');
}
function shortLabel(s, max = 24) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function shortModel(m) {
  return m.replace(/^claude-/, '');
}

/* ---------- data ---------- */
async function load(isRefresh) {
  $('sub').textContent = isRefresh ? 'Re-reading changed transcripts…' : 'Reading ~/.claude/projects…';
  $('refresh').disabled = true;
  try {
    const demo = new URLSearchParams(location.search).has('demo') ? '?demo=1' : ''; // made-up data, see lib/demo.js
    if (demo) document.querySelector('.top-actions a').href = '/office?demo=1';
    const res = await fetch('/api/usage' + demo);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    DATA = await res.json();
  } catch (err) {
    $('sub').textContent = 'Could not read usage data: ' + err.message;
    $('refresh').disabled = false;
    return;
  }
  $('refresh').disabled = false;
  for (const t of DATA.turns) t.day = localDay(t.ts);

  const totals = {};
  for (const t of DATA.turns) totals[t.project] = (totals[t.project] || 0) + t.cost;
  topProjects = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, TOP_PROJECTS);
  projectColor = Object.fromEntries(topProjects.map((p, i) => [p, i + 1]));

  fillSelect($('project'), 'All projects', Object.keys(totals).sort((a, b) => totals[b] - totals[a]), projectName);
  const models = {};
  for (const t of DATA.turns) models[t.model] = (models[t.model] || 0) + t.cost;
  fillSelect($('model'), 'All models', Object.keys(models).sort((a, b) => models[b] - models[a]), shortModel);

  const unpriced = Object.entries(DATA.unpriced);
  $('warn').hidden = !unpriced.length;
  if (unpriced.length) {
    $('warn').textContent = 'No price for: ' + unpriced.map(([m, n]) => `${m} (${n} turns)`).join(', ') +
      '. These turns count toward tokens but show $0. Add the model to pricing.json and refresh.';
  }
  render();
}

function fillSelect(sel, allLabel, values, label) {
  const keep = sel.id === 'project' ? state.project : state.model;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
  sel.value = values.includes(keep) ? keep : '';
  if (sel.value !== keep) state[sel.id] = '';
}

function dateBounds() {
  const days = DATA.turns.map((t) => t.day);
  const first = days[0] || localDay(Date.now());
  const today = localDay(Date.now());
  if (state.range === 'custom') return { from: state.from || first, to: state.to || today };
  if (state.range === 'all') return { from: first, to: today };
  return { from: shiftDay(today, -(Number(state.range) - 1)), to: today };
}

function filtered({ ignoreProject } = {}) {
  const { from, to } = dateBounds();
  return DATA.turns.filter(
    (t) =>
      t.day >= from &&
      t.day <= to &&
      (ignoreProject || !state.project || t.project === state.project) &&
      (!state.model || t.model === state.model) &&
      (state.thread === 'all' || (state.thread === 'sub' ? t.subagent : !t.subagent))
  );
}

function sumBy(turns, keyFn) {
  const out = new Map();
  for (const t of turns) {
    const k = keyFn(t);
    const o = out.get(k) || { value: 0, cost: 0, tokens: 0, turns: 0, parts: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, list: [] };
    o.value += valueOf(t);
    o.cost += t.cost;
    o.tokens += tokensOf(t);
    o.turns++;
    for (const ty of TYPES) o.parts[ty.key] += typeValue(t, ty.key);
    o.list.push(t);
    out.set(k, o);
  }
  return out;
}

/* ---------- render ---------- */
function render() {
  if (!DATA) return;
  syncControls();
  const turns = filtered();
  const { from, to } = dateBounds();
  const nDays = Math.round((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 864e5) + 1;
  $('sub').textContent = `${fmtDate(from + 'T12:00:00')} – ${fmtDate(to + 'T12:00:00')} · ${turns.length.toLocaleString()} API turns` +
    (state.project ? ` · ${projectName(state.project)}` : '');

  renderKpis(turns, nDays);
  renderDaily(turns, from, to);
  renderProjects();
  renderBreakdowns(turns);
  renderSessions(turns);
  renderSessionDetail();
  renderTools(turns);
  renderFoot();
  saveStore();
}

function syncControls() {
  for (const b of $('range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === state.range));
  for (const b of $('measure').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === state.measure));
  const { from, to } = dateBounds();
  $('from').value = from;
  $('to').value = to;
  $('project').value = state.project;
  $('model').value = state.model;
  $('thread').value = state.thread;
}

function renderKpis(turns, nDays) {
  let cost = 0, tokens = 0, cr = 0, cw = 0, inp = 0;
  const sessions = new Set();
  for (const t of turns) {
    cost += t.cost; tokens += tokensOf(t); cr += t.cacheRead; cw += t.cacheWrite; inp += t.input;
    sessions.add(t.session);
  }
  const byProject = sumBy(filtered({ ignoreProject: true }), (t) => t.project);
  const allValue = [...byProject.values()].reduce((s, o) => s + o.value, 0);
  const top = [...byProject.entries()].sort((a, b) => b[1].value - a[1].value)[0];
  const isCost = state.measure === 'cost';
  const tiles = [
    { hero: true, label: isCost ? 'Estimated cost (API prices)' : 'Total tokens', value: isCost ? fmtUSD(cost) : fmtTok(tokens),
      note: isCost ? `${fmtUSD(cost / nDays)} per day on average` : `${fmtTok(tokens / nDays)} per day on average` },
    { label: isCost ? 'Total tokens' : 'Estimated cost', value: isCost ? fmtTok(tokens) : fmtUSD(cost),
      note: tokens ? `${fmtPct(cr / tokens)} of tokens are cache reads` : '' },
    { label: 'Sessions', value: sessions.size.toLocaleString(), note: `${turns.length.toLocaleString()} API turns` },
    { label: 'Cache hit rate', value: inp + cr + cw ? fmtPct(cr / (inp + cr + cw)) : '–', note: 'Share of input served from cache' },
    { label: state.project ? 'Share of all projects' : 'Top project',
      value: state.project ? (allValue ? fmtPct((byProject.get(state.project)?.value || 0) / allValue) : '–') : top ? fmtPct(top[1].value / allValue) : '–',
      note: state.project ? projectName(state.project) : top ? projectName(top[0]) : '' },
  ];
  $('kpis').innerHTML = tiles
    .map((k) => `<div class="kpi${k.hero ? ' hero' : ''}"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div><div class="note">${esc(k.note)}</div></div>`)
    .join('');
}

function baseOptions(extra = {}) {
  const grid = css('--grid'), muted = css('--muted'), ink = css('--ink'), surface = css('--surface'), border = css('--border');
  return Object.assign(
    {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: surface, titleColor: ink, bodyColor: ink, borderColor: border, borderWidth: 1,
          padding: 10, boxPadding: 4, usePointStyle: true, titleFont: { weight: '600' },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: muted, font: { size: 11 } } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: muted, font: { size: 11 }, callback: (v) => fmtMeasure(v) } },
      },
    },
    extra
  );
}

function makeChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), config);
  return charts[id];
}

function renderDaily(turns, from, to) {
  const days = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(d);
  const keys = state.project ? [state.project] : [...topProjects, '__other'];
  const series = Object.fromEntries(keys.map((k) => [k, new Map()]));
  for (const t of turns) {
    const k = series[t.project] ? t.project : '__other';
    if (!series[k]) continue;
    series[k].set(t.day, (series[k].get(t.day) || 0) + valueOf(t));
  }
  const surface = css('--surface');
  const datasets = keys
    .map((k) => ({
      label: k === '__other' ? 'Other projects' : projectName(k),
      data: days.map((d) => series[k].get(d) || 0),
      backgroundColor: k === '__other' || !projectColor[k] ? css('--other') : slotColor(projectColor[k]),
      borderColor: surface,
      borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
      borderSkipped: 'bottom',
      maxBarThickness: 24,
    }))
    .filter((ds) => ds.data.some((v) => v > 0));

  $('daily-title').textContent = state.measure === 'cost' ? 'Daily estimated cost by project' : 'Daily tokens by project';
  $('daily-legend').innerHTML = datasets.length > 1
    ? datasets.map((ds) => `<span><i style="background:${ds.backgroundColor}"></i>${esc(ds.label)}</span>`).join('')
    : '';
  const opts = baseOptions();
  opts.scales.x.stacked = true;
  opts.scales.y.stacked = true;
  opts.scales.x.ticks.maxRotation = 0;
  opts.scales.x.ticks.autoSkipPadding = 12;
  opts.interaction = { mode: 'index', intersect: false };
  opts.plugins.tooltip.itemSort = (a, b) => b.raw - a.raw;
  opts.plugins.tooltip.filter = (item) => item.raw > 0;
  opts.plugins.tooltip.callbacks = {
    title: (items) => new Date(days[items[0].dataIndex] + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    label: (item) => ` ${item.dataset.label}: ${fmtMeasure(item.raw)}`,
    footer: (items) => 'Total: ' + fmtMeasure(items.reduce((s, i) => s + i.raw, 0)),
  };
  makeChart('daily', { type: 'bar', data: { labels: days.map((d) => fmtDate(d + 'T12:00:00')), datasets }, options: opts });
}

function splitBar(parts) {
  const total = TYPES.reduce((s, ty) => s + parts[ty.key], 0) || 1;
  return `<div class="split" title="${TYPES.map((ty) => `${ty.label}: ${fmtMeasure(parts[ty.key])}`).join(' · ')}">` +
    TYPES.filter((ty) => parts[ty.key] / total > 0.004)
      .map((ty) => `<div style="flex:${parts[ty.key] / total};background:${slotColor(ty.slot)}"></div>`).join('') +
    '</div>';
}

function renderProjects() {
  const turns = filtered({ ignoreProject: true });
  const groups = [...sumBy(turns, (t) => t.project).entries()].sort((a, b) => b[1].value - a[1].value);
  const total = groups.reduce((s, [, o]) => s + o.value, 0) || 1;
  $('split-legend').innerHTML = TYPES.map((ty) => `<span><i style="background:${slotColor(ty.slot)}"></i>${ty.label}</span>`).join('');
  const isCost = state.measure === 'cost';
  const rows = groups.map(([key, o]) => {
    const sessions = new Set(o.list.map((t) => t.session)).size;
    const sub = o.list.filter((t) => t.subagent).reduce((s, t) => s + valueOf(t), 0);
    const last = o.list[o.list.length - 1].ts;
    const color = projectColor[key] ? slotColor(projectColor[key]) : css('--other');
    return `<tr data-project="${esc(key)}" tabindex="0" class="${state.project === key ? 'active' : ''}">
      <td><span class="name"><span class="sw" style="background:${color}"></span>${esc(projectName(key))}</span></td>
      <td class="num"><b>${fmtMeasure(o.value)}</b></td>
      <td class="bar-cell"><div class="share"><div style="width:${(o.value / total) * 100}%"></div></div></td>
      <td class="num">${fmtPct(o.value / total)}</td>
      <td>${splitBar(o.parts)}</td>
      <td class="num">${isCost ? fmtTok(o.tokens) : fmtUSD(o.cost)}</td>
      <td class="num">${sessions}</td>
      <td class="num">${o.turns.toLocaleString()}</td>
      <td class="num">${o.value ? fmtPct(sub / o.value) : '–'}</td>
      <td class="num muted">${fmtDate(last)}</td>
    </tr>`;
  });
  $('projects').innerHTML = `<thead><tr><th>Project</th><th class="num">${isCost ? 'Est. cost' : 'Tokens'}</th><th></th><th class="num">Share</th>
    <th>${isCost ? 'Cost' : 'Token'} split</th><th class="num">${isCost ? 'Tokens' : 'Est. cost'}</th><th class="num">Sessions</th>
    <th class="num">Turns</th><th class="num">Subagents</th><th class="num">Last active</th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="10" class="muted">No usage in this range.</td></tr>'}</tbody>`;
}

// Value at the tip of each bar. The formatter stays in a closure: Chart.js would call a function placed in options.
const endLabels = (format) => ({
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = css('--ink-2');
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    const meta = chart.getDatasetMeta(0);
    meta.data.forEach((bar, i) => {
      const v = chart.data.datasets[0].data[i];
      ctx.fillText(format(v), bar.x + 6, bar.y);
    });
    ctx.restore();
  },
});

function hbar(id, entries, colors) {
  const wrap = $(id + '-wrap');
  wrap.style.height = Math.max(120, entries.length * 34 + 30) + 'px';
  const opts = baseOptions({ indexAxis: 'y' });
  const max = Math.max(...entries.map((e) => e[1]), 0);
  opts.scales.x = { display: false, max: max * 1.28, grid: { display: false } };
  opts.scales.y = { grid: { display: false }, border: { display: false }, ticks: { color: css('--ink'), font: { size: 12 } } };
  opts.plugins.tooltip.callbacks = { label: (item) => ` ${fmtMeasure(item.raw)}` };
  makeChart(id, {
    type: 'bar',
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => e[1]), backgroundColor: colors || css('--accent'), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 20 }],
    },
    options: opts,
    plugins: [endLabels(fmtMeasure)],
  });
}

function renderBreakdowns(turns) {
  const byModel = [...sumBy(turns, (t) => shortModel(t.model) + (t.speed === 'fast' ? ' (fast)' : '')).entries()]
    .map(([k, o]) => [k, o.value]).sort((a, b) => b[1] - a[1]);
  hbar('by-model', byModel);

  const typeTotals = TYPES.map((ty) => [ty.label, turns.reduce((s, t) => s + typeValue(t, ty.key), 0)]);
  hbar('by-type', typeTotals, TYPES.map((ty) => slotColor(ty.slot)));

  const byAgent = [...sumBy(turns, (t) => (t.subagent ? shortLabel(t.agentType.replace(/^[\w-]+:/, '')) : 'Main thread')).entries()]
    .map(([k, o]) => [k, o.value]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  hbar('by-agent', byAgent);
}

function sessionGroups(turns) {
  return [...sumBy(turns, (t) => t.session).entries()].map(([id, o]) => {
    const branches = {};
    let peak = 0;
    const models = new Set();
    for (const t of o.list) {
      if (t.branch) branches[t.branch] = (branches[t.branch] || 0) + 1;
      if (!t.subagent) peak = Math.max(peak, t.context);
      models.add(shortModel(t.model));
    }
    const meta = DATA.sessions[id] || {};
    return {
      id, ...o, meta, peak, models: [...models],
      title: meta.title || `Untitled session ${id.slice(0, 8)}`,
      project: o.list[0].project,
      branch: Object.entries(branches).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      start: o.list[0].ts,
      end: o.list[o.list.length - 1].ts,
    };
  });
}

function renderSessions(turns) {
  const q = state.search.toLowerCase();
  const all = sessionGroups(turns).sort((a, b) => b.value - a.value);
  const list = (q ? all.filter((s) => s.title.toLowerCase().includes(q) || projectName(s.project).toLowerCase().includes(q)) : all).slice(0, 40);
  const isCost = state.measure === 'cost';
  const rows = list.map((s) => `<tr data-session="${esc(s.id)}" tabindex="0" class="${state.session === s.id ? 'active' : ''}">
      <td><span class="title" title="${esc(s.title)}">${esc(s.title)}</span><span class="muted">${esc(projectName(s.project))}${s.branch ? ' · ' + esc(s.branch) : ''}</span></td>
      <td class="num muted">${fmtDate(s.start)}</td>
      <td class="num"><b>${fmtMeasure(s.value)}</b></td>
      <td class="num">${isCost ? fmtTok(s.tokens) : fmtUSD(s.cost)}</td>
      <td class="num">${s.turns.toLocaleString()}</td>
      <td class="num">${fmtMeasure(s.value / s.turns)}</td>
      <td class="num">${s.peak ? fmtTok(s.peak) : '–'}</td>
      <td class="muted">${esc(s.models.join(', '))}</td>
    </tr>`);
  $('sessions').innerHTML = `<thead><tr><th>Session</th><th class="num">Started</th><th class="num">${isCost ? 'Est. cost' : 'Tokens'}</th>
    <th class="num">${isCost ? 'Tokens' : 'Est. cost'}</th><th class="num">Turns</th><th class="num">Per turn</th><th class="num">Peak context</th><th>Models</th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="8" class="muted">No sessions match.</td></tr>'}</tbody>`;
}

function renderSessionDetail() {
  const box = $('session-detail');
  if (!state.session) { box.hidden = true; return; }
  const list = DATA.turns.filter((t) => t.session === state.session);
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  const s = sessionGroups(list)[0];
  $('sd-title').textContent = s.title;
  $('sd-meta').textContent = `${projectName(s.project)}${s.branch ? ' · ' + s.branch : ''} · ${new Date(s.start).toLocaleString()} → ${new Date(s.end).toLocaleString()} · all turns, ignoring filters`;
  const subCost = list.filter((t) => t.subagent).reduce((a, t) => a + t.cost, 0);
  const stats = [
    ['Est. cost', fmtUSD(s.cost)],
    ['Tokens', fmtTok(s.tokens)],
    ['Turns', s.turns.toLocaleString()],
    ['Peak context', fmtTok(s.peak)],
    ['Subagent share', s.cost ? fmtPct(subCost / s.cost) : '–'],
  ];
  if (s.meta.reportedCostUSD) {
    const since = s.meta.reportedSince && s.meta.reportedSince > s.start ? ` (since ${fmtDate(s.meta.reportedSince)})` : '';
    stats.push([`Claude Code's own figure${since}`, fmtUSD(s.meta.reportedCostUSD)]);
  }
  $('sd-stats').innerHTML = stats.map(([k, v]) => `<div><b>${esc(v)}</b>${esc(k)}</div>`).join('');

  const labels = list.map((_, i) => i + 1);
  const main = slotColor(1), sub = slotColor(2), surface = css('--surface');
  const ctxOpts = baseOptions();
  ctxOpts.scales.y.ticks.callback = (v) => fmtTok(v);
  ctxOpts.scales.x.ticks.maxTicksLimit = 12;
  ctxOpts.plugins.legend = { display: true, position: 'top', align: 'end', labels: { color: css('--ink-2'), usePointStyle: true, boxWidth: 8, boxHeight: 8, font: { size: 12 } } };
  ctxOpts.interaction = { mode: 'nearest', intersect: false, axis: 'x' };
  const tipTitle = (items) => {
    const t = list[items[0].dataIndex];
    return `Turn ${items[0].dataIndex + 1} · ${new Date(t.ts).toLocaleTimeString()}`;
  };
  const tipFooter = (items) => {
    const t = list[items[0].dataIndex];
    return [`${shortModel(t.model)}${t.subagent ? ' · ' + t.agentType : ''}`, `${fmtUSD(t.cost, true)} · out ${fmtTok(t.output)} · cache write ${fmtTok(t.cacheWrite)}`,
      t.tools.length ? 'Tools: ' + t.tools.join(', ') : ''].filter(Boolean);
  };
  ctxOpts.plugins.tooltip.callbacks = { title: tipTitle, label: (i) => ` ${i.dataset.label}: ${fmtTok(i.raw)}`, footer: tipFooter };
  makeChart('sd-context', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Main thread', data: list.map((t) => (t.subagent ? null : t.context)), borderColor: main, backgroundColor: main, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, spanGaps: true, tension: 0 },
        { label: 'Subagent', data: list.map((t) => (t.subagent ? t.context : null)), borderColor: surface, backgroundColor: sub, borderWidth: 2, pointRadius: 3.5, pointHoverRadius: 5, showLine: false },
      ].filter((ds) => ds.data.some((v) => v != null)),
    },
    options: ctxOpts,
  });

  const costOpts = baseOptions();
  costOpts.scales.y.ticks.callback = (v) => '$' + v.toFixed(2);
  costOpts.scales.x.ticks.maxTicksLimit = 12;
  costOpts.scales.x.stacked = true;
  costOpts.interaction = { mode: 'index', intersect: false };
  costOpts.plugins.legend = ctxOpts.plugins.legend;
  costOpts.plugins.tooltip.filter = (item) => item.raw != null;
  costOpts.plugins.tooltip.callbacks = { title: tipTitle, label: (i) => ` ${i.dataset.label}: ${fmtUSD(i.raw, true)}`, footer: tipFooter };
  $('sd-cost-title').textContent = 'Estimated cost per turn';
  makeChart('sd-cost', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Main thread', data: list.map((t) => (t.subagent ? null : t.cost)), backgroundColor: main, borderRadius: 2, maxBarThickness: 12 },
        { label: 'Subagent', data: list.map((t) => (t.subagent ? t.cost : null)), backgroundColor: sub, borderRadius: 2, maxBarThickness: 12 },
      ].filter((ds) => ds.data.some((v) => v != null)),
    },
    options: costOpts,
  });
}

function renderTools(turns) {
  const tools = new Map();
  for (const t of turns) {
    const names = t.tools.length ? t.tools : ['(text reply, no tool)'];
    const share = valueOf(t) / names.length;
    for (const n of names) {
      const o = tools.get(n) || { calls: 0, value: 0 };
      o.calls += t.tools.length ? 1 : 0;
      o.value += share;
      tools.set(n, o);
    }
    if (t.webSearches) {
      const o = tools.get('WebSearch (server)') || { calls: 0, value: 0 };
      o.calls += t.webSearches;
      tools.set('WebSearch (server)', o);
    }
  }
  const list = [...tools.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, 25);
  const total = [...tools.values()].reduce((s, o) => s + o.value, 0) || 1;
  $('tools').innerHTML = `<thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">${state.measure === 'cost' ? 'Est. cost' : 'Tokens'} of calling turns</th><th></th><th class="num">Share</th></tr></thead>
    <tbody>${list.map(([n, o]) => `<tr tabindex="-1"><td>${esc(n.replace(/^mcp__/, 'MCP: ').replace(/__/g, ' · '))}</td><td class="num">${o.calls ? o.calls.toLocaleString() : '–'}</td>
      <td class="num"><b>${fmtMeasure(o.value)}</b></td><td class="bar-cell"><div class="share"><div style="width:${(o.value / total) * 100}%"></div></div></td>
      <td class="num">${fmtPct(o.value / total)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No usage in this range.</td></tr>'}</tbody>`;
}

function renderFoot() {
  // Claude Code logs its own cost when a process exits, covering only that run, so compare like with like.
  const reportedSessions = Object.entries(DATA.sessions).filter(([, s]) => s.reportedCostUSD);
  let est = 0, reported = 0;
  for (const [, s] of reportedSessions) reported += s.reportedCostUSD;
  for (const t of DATA.turns) {
    const s = DATA.sessions[t.session];
    if (s && s.reportedCostUSD && (!s.reportedSince || t.ts >= s.reportedSince)) est += t.cost;
  }
  const check = reportedSessions.length
    ? ` Cross-check: across ${reportedSessions.length} sessions, Claude Code's own cost log says ${fmtUSD(reported)} for the turns this dashboard estimates at ${fmtUSD(est)}.`
    : '';
  $('foot').textContent = `Updated ${new Date(DATA.generatedAt).toLocaleTimeString()} from ${DATA.scan.files} transcripts in ~/.claude/projects ` +
    `(${DATA.scan.parsed} re-read, ${DATA.scan.cached} unchanged, ${DATA.scan.ms} ms). Costs are estimates at API list prices from pricing.json; ` +
    `on a Pro/Max plan they show relative weight, not your bill.${check}`;
}

/* ---------- events ---------- */
function bindSeg(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = b.dataset.v;
    render();
  });
}
bindSeg('range', 'range');
bindSeg('measure', 'measure');
for (const id of ['from', 'to']) {
  $(id).addEventListener('change', () => {
    const { from, to } = dateBounds();
    state.range = 'custom';
    state.from = id === 'from' ? $(id).value : from;
    state.to = id === 'to' ? $(id).value : to;
    render();
  });
}
for (const id of ['project', 'model', 'thread']) $(id).addEventListener('change', () => { state[id] = $(id).value; render(); });

function rowActivate(table, attr, fn) {
  const handler = (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest(`tr[data-${attr}]`);
    if (!tr) return;
    e.preventDefault();
    fn(tr.dataset[attr]);
  };
  $(table).addEventListener('click', handler);
  $(table).addEventListener('keydown', handler);
}
rowActivate('projects', 'project', (p) => { state.project = state.project === p ? '' : p; render(); });
rowActivate('sessions', 'session', (s) => {
  state.session = state.session === s ? '' : s;
  render();
  if (state.session) $('session-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('sd-close').addEventListener('click', () => { state.session = ''; render(); });
$('session-search').addEventListener('input', (e) => { state.search = e.target.value; renderSessions(filtered()); });
$('refresh').addEventListener('click', () => load(true));

function applyTheme() {
  if (state.theme) document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
  const dark = state.theme ? state.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme').textContent = dark ? 'Light mode' : 'Dark mode';
}
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = dark ? 'light' : 'dark';
  applyTheme();
  render();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!state.theme) { applyTheme(); render(); } });

applyTheme();
load(false);
