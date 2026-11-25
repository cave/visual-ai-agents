// Reads Claude Code transcripts under ~/.claude/projects. Read-only: nothing here writes to ~/.claude.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

// file path -> { stamp, data }, so a refresh only re-reads transcripts that changed.
const fileCache = new Map();
let lastScan = { parsed: 0, cached: 0, ms: 0 };

async function listTranscripts(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTranscripts(full)));
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return t ? t.text : '';
  }
  return '';
}

function isRealPrompt(text) {
  const t = text.trim();
  return t && !t.startsWith('<') && !t.startsWith('[Request interrupted');
}

async function parseFile(file) {
  const parts = path.relative(ROOT, file).split(path.sep);
  const projectKey = parts[0];
  const isSubagentFile = parts.includes('subagents');
  let agentType = null;
  if (isSubagentFile) {
    try {
      agentType = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || null;
    } catch {}
  }

  const turns = new Map(); // dedupe key -> turn
  const sessions = {}; // sessionId -> partial metadata
  const meta = (id) => (sessions[id] ||= {});

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap substring checks first; JSON.parse only the lines we need.
    if (line.includes('"usage"') && line.includes('"type":"assistant"')) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const m = d.message;
      if (d.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') continue;
      const u = m.usage;
      const cw = u.cache_creation_input_tokens || 0;
      const cw1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
      const cw5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens || 0 : cw;
      const turn = {
        key: `${m.id}|${d.requestId}`,
        ts: d.timestamp,
        projectKey,
        cwd: d.cwd || null,
        sessionId: (isSubagentFile ? parts[1] : d.sessionId) || parts[1] || path.basename(file, '.jsonl'),
        subagent: isSubagentFile || !!d.isSidechain,
        agentType: isSubagentFile ? agentType || 'subagent' : d.isSidechain ? 'subagent' : 'main',
        branch: d.gitBranch || null,
        model: m.model,
        speed: u.speed || 'standard',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite5m: cw5m,
        cacheWrite1h: cw1h,
        cacheRead: u.cache_read_input_tokens || 0,
        webSearches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
        tools: Array.isArray(m.content) ? m.content.filter((c) => c && c.type === 'tool_use').map((c) => c.name) : [],
      };
      // One API response is logged once per content block with the same usage; keep the fullest record
      // and merge the tool calls that were split across those records.
      const prev = turns.get(turn.key);
      if (prev) {
        const tools = prev.tools.concat(turn.tools);
        if (turn.output > prev.output) turns.set(turn.key, { ...turn, tools });
        else prev.tools = tools;
      } else turns.set(turn.key, turn);
      continue;
    }
    if (line.includes('"type":"custom-title"')) {
      try { const d = JSON.parse(line); if (d.customTitle) meta(d.sessionId).customTitle = d.customTitle; } catch {}
    } else if (line.includes('"type":"ai-title"')) {
      try { const d = JSON.parse(line); if (d.aiTitle) meta(d.sessionId).aiTitle = d.aiTitle; } catch {}
    } else if (line.includes('"type":"last-prompt"')) {
      try { const d = JSON.parse(line); if (d.lastPrompt) meta(d.sessionId).lastPrompt = d.lastPrompt; } catch {}
    } else if (line.includes('"type":"cost-state"')) {
      try {
        const d = JSON.parse(line);
        // Written when a Claude Code process exits; it only covers that run (since startTime), not earlier resumed runs.
        const s = meta(d.sessionId);
        const cost = Number(d.totalCostUSD) || 0;
        if (cost >= (s.reportedCostUSD || 0)) {
          s.reportedCostUSD = cost;
          s.reportedSinceMs = Number(d.startTime) || 0;
        }
      } catch {}
    } else if (!isSubagentFile && line.includes('"type":"user"')) {
      try {
        const d = JSON.parse(line);
        if (d.type !== 'user' || d.isMeta || !d.message) continue;
        const s = meta(d.sessionId);
        if (s.firstPrompt) continue;
        const text = promptText(d.message.content);
        if (isRealPrompt(text)) s.firstPrompt = text;
      } catch {}
    }
  }
  return { turns: [...turns.values()], sessions };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

// Returns every unique API turn plus merged per-session metadata.
async function scan() {
  const started = Date.now();
  const files = await listTranscripts(ROOT);
  let parsed = 0;
  let cached = 0;
  const datas = await mapLimit(files, 8, async (file) => {
    let st;
    try { st = await fsp.stat(file); } catch { return null; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = fileCache.get(file);
    if (hit && hit.stamp === stamp) { cached++; return hit.data; }
    const data = await parseFile(file);
    fileCache.set(file, { stamp, data });
    parsed++;
    return data;
  });
  for (const f of fileCache.keys()) if (!files.includes(f)) fileCache.delete(f);

  const turns = new Map();
  const sessions = {};
  for (const data of datas) {
    if (!data) continue;
    for (const t of data.turns) {
      const prev = turns.get(t.key);
      if (!prev || t.output > prev.output) turns.set(t.key, t);
    }
    for (const [id, s] of Object.entries(data.sessions)) {
      const into = (sessions[id] ||= {});
      for (const [k, v] of Object.entries(s)) {
        if (k === 'reportedSinceMs') continue;
        if (k === 'reportedCostUSD') {
          if (v >= (into[k] || 0)) Object.assign(into, { reportedCostUSD: v, reportedSinceMs: s.reportedSinceMs });
        } else if (k === 'firstPrompt') into[k] ||= v;
        else into[k] = v;
      }
    }
  }
  lastScan = { files: files.length, parsed, cached, ms: Date.now() - started };
  return { turns: [...turns.values()], sessions, scan: lastScan };
}

// "/Users/x/webprojects/foo" -> "-Users-x-webprojects-foo", the way Claude Code names project folders.
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

module.exports = { scan, encodeCwd, ROOT };
