// Local Claude Code usage dashboard. Run: node server.js  ->  http://localhost:4747
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { scan, encodeCwd } = require('./lib/scan');
const { loadPricing, normalizeModel, costParts } = require('./lib/pricing');
const office = require('./lib/office');
const demo = require('./lib/demo');

const PORT = Number(process.env.PORT) || 4747;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const HOME = os.homedir();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let inflight = null; // share one scan between concurrent requests

function displayPath(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// Claude Code folder name -> readable path. Prefer a cwd that encodes back to the folder name exactly.
function projectNames(turns) {
  const cwds = {};
  for (const t of turns) {
    if (!t.cwd) continue;
    const c = (cwds[t.projectKey] ||= {});
    c[t.cwd] = (c[t.cwd] || 0) + 1;
  }
  const names = {};
  for (const [key, counts] of Object.entries(cwds)) {
    const exact = Object.keys(counts).find((cwd) => encodeCwd(cwd) === key);
    const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    names[key] = displayPath(exact || common);
  }
  return names;
}

async function buildUsage(useDemo) {
  const pricing = loadPricing();
  const { turns, sessions, scan: scanInfo } = useDemo ? demo.demoScan() : await scan();
  const names = projectNames(turns);
  const unpriced = {};
  const rows = turns.map((t) => {
    const context = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
    const parts = costParts(pricing, { ...t, context });
    if (!parts) unpriced[t.model] = (unpriced[t.model] || 0) + 1;
    return {
      ts: t.ts,
      project: t.projectKey,
      session: t.sessionId,
      subagent: t.subagent,
      agentType: t.agentType,
      branch: t.branch,
      model: normalizeModel(t.model),
      speed: t.speed,
      input: t.input,
      output: t.output,
      cacheWrite: t.cacheWrite5m + t.cacheWrite1h,
      cacheRead: t.cacheRead,
      context,
      webSearches: t.webSearches,
      tools: t.tools,
      cost: parts ? parts.input + parts.output + parts.cacheWrite + parts.cacheRead : 0,
      costParts: parts || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      priced: !!parts,
    };
  });
  rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const sessionMeta = {};
  for (const [id, s] of Object.entries(sessions)) {
    const title = s.customTitle || s.aiTitle || s.firstPrompt || s.lastPrompt || null;
    sessionMeta[id] = {
      title: title ? title.replace(/\s+/g, ' ').slice(0, 140) : null,
      lastPrompt: s.lastPrompt ? s.lastPrompt.slice(0, 200) : null,
      reportedCostUSD: s.reportedCostUSD || null,
      reportedSince: s.reportedSinceMs ? new Date(s.reportedSinceMs).toISOString() : null,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    scan: scanInfo,
    projects: names,
    sessions: sessionMeta,
    unpriced,
    turns: rows,
  };
}

function send(req, res, status, type, body) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// The office actions touch real processes, so they only accept calls made by this app's own page:
// the custom header cannot be sent cross-site, and the Host check stops DNS-rebinding tricks.
function fromOwnPage(req) {
  const hosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  const origin = req.headers.origin;
  return hosts.includes(req.headers.host) && req.headers['x-office'] === '1' && (!origin || hosts.some((h) => origin === `http://${h}`));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const useDemo = url.searchParams.has('demo'); // made-up data, see lib/demo.js
  if (url.pathname === '/api/office') {
    try {
      send(req, res, 200, 'application/json', JSON.stringify(useDemo ? demo.demoOffice() : await office.snapshot()));
    } catch (err) {
      console.error(err);
      send(req, res, 500, 'application/json', JSON.stringify({ error: String(err && err.message) }));
    }
    return;
  }
  if (url.pathname === '/api/office/focus' || url.pathname === '/api/office/quit') {
    if (req.method !== 'POST' || !fromOwnPage(req)) return send(req, res, 403, 'application/json', '{"ok":false,"reason":"forbidden"}');
    const body = await readJson(req);
    const act = url.pathname.endsWith('quit') ? office.quit : office.focus;
    const result = await act(body && body.pid);
    if (act === office.quit) console.log(`office: quit pid ${body && body.pid} -> ${JSON.stringify(result)}`);
    return send(req, res, 200, 'application/json', JSON.stringify(result));
  }
  if (url.pathname === '/api/usage') {
    try {
      const data = useDemo ? await buildUsage(true) : await (inflight ||= buildUsage().finally(() => (inflight = null)));
      console.log(`scan: ${data.scan.files} files, ${data.scan.parsed} parsed, ${data.scan.cached} cached, ${data.scan.ms}ms`);
      send(req, res, 200, 'application/json', JSON.stringify(data));
    } catch (err) {
      console.error(err);
      send(req, res, 500, 'application/json', JSON.stringify({ error: String(err && err.message) }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/office' ? 'office.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(req, res, 403, 'text/plain', 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(req, res, 404, 'text/plain', 'Not found');
    send(req, res, 200, TYPES[path.extname(file)] || 'application/octet-stream', buf);
  });
});

server.listen(PORT, HOST, () => console.log(`Claude usage dashboard: http://localhost:${PORT}`));
