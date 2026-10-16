// HTTP API + live updates (Server-Sent Events) + static UI. No framework:
// node:http is enough for a handful of routes and keeps the tool dependency-free.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, loadTeams, createClock } from './config.js';
import { openDb } from './db.js';
import { createAnalyzer } from './analyzer/index.js';
import { createAnthropicClient } from './analyzer/ai.js';
import { createAiSettings } from './ai-settings.js';
import { createNotifier } from './notifier.js';
import { createTriage } from './triage.js';
import { parseCsv, mapColumns } from './parse.js';
import { TEAMS, URGENCIES, STATUSES, CATEGORIES, SLA_HOURS } from './taxonomy.js';

const MAX_BODY = 5 * 1024 * 1024;
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// `ai` injects an engine directly (tests); otherwise the engine comes from
// Settings / environment. `aiClientFactory` replaces the Anthropic client (tests).
export async function createApp({ dbPath = ':memory:', env = process.env, ai, aiClientFactory = createAnthropicClient, clock = createClock(env.APP_NOW), teams = loadTeams(), fetchImpl } = {}) {
  const db = openDb(dbPath);
  const sseClients = new Set();
  const broadcast = (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  const analyzer = createAnalyzer({ ai: ai ?? null });
  const aiSettings = createAiSettings({ db, env, analyzer, clock, clientFactory: aiClientFactory });
  if (ai === undefined) await aiSettings.apply();
  const appUrl = env.APP_URL || `http://localhost:${env.PORT || 3000}`;
  const notifier = createNotifier({ db, teams, clock, broadcast, appUrl, env, ...(fetchImpl && { fetchImpl }) });
  const triage = createTriage({ db, analyzer, notifier, clock, teams, broadcast });

  const meta = () => ({
    now: new Date(clock.now()).toISOString(),
    simulatedClock: clock.simulated,
    engine: analyzer.engine,
    slack: Boolean(env.SLACK_WEBHOOK_URL || Object.keys(env).some((k) => k.startsWith('SLACK_WEBHOOK_URL_'))),
    teams: TEAMS.map((t) => ({ ...t, ...teams[t.id] })),
    urgencies: URGENCIES,
    statuses: STATUSES,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([id, c]) => [id, { label: c.label, team: c.team }])),
    sla: SLA_HOURS,
  });

  const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const tokenOk = (req) => !env.INGEST_TOKEN || sameSecret(req.headers['x-ingest-token'], env.INGEST_TOKEN);
  // Settings hold a paid API key: only from the machine running the tool,
  // or with ADMIN_TOKEN once the tool is deployed.
  const adminOk = (req) => (env.ADMIN_TOKEN
    ? sameSecret(req.headers['x-admin-token'], env.ADMIN_TOKEN)
    : ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress));
  const adminRefused = () => (env.ADMIN_TOKEN ? 'Wrong or missing admin token.'
    : 'Settings can only be changed on the computer running the tool (or set ADMIN_TOKEN).');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const idMatch = p.match(/^\/api\/conversations\/(\d+)(\/notes)?$/);

    if (req.method === 'GET' && p === '/api/meta') return send(200, meta());
    if (req.method === 'GET' && p === '/api/settings') return send(200, aiSettings.status());
    if (p.startsWith('/api/settings/')) {
      if (!adminOk(req)) return send(403, { error: adminRefused() });
      try {
        if (req.method === 'POST' && p === '/api/settings/key') return send(200, await aiSettings.saveKey((await readJson(req)).apiKey));
        if (req.method === 'DELETE' && p === '/api/settings/key') return send(200, await aiSettings.removeKey());
        if (req.method === 'GET' && p === '/api/settings/models') return send(200, await aiSettings.models());
        if (req.method === 'POST' && p === '/api/settings/model') return send(200, await aiSettings.saveModel((await readJson(req)).model));
      } catch (err) {
        if (!err.status) throw err;
        return send(err.status, { error: err.message });
      }
      return send(404, { error: 'Not found' });
    }
    if (req.method === 'GET' && p === '/api/stats') return send(200, triage.stats());
    if (req.method === 'GET' && p === '/api/notifications') return send(200, triage.listNotifications());
    if (req.method === 'GET' && p === '/api/conversations') return send(200, triage.listConversations(Object.fromEntries(url.searchParams)));
    if (req.method === 'GET' && idMatch && !idMatch[2]) {
      const conv = triage.getConversation(Number(idMatch[1]));
      return conv ? send(200, conv) : send(404, { error: 'Conversation not found' });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // Webhook for contact forms, email parsers (Mailgun/Postmark inbound) and live chat.
    if (req.method === 'POST' && p === '/api/messages') {
      if (!tokenOk(req)) return send(401, { error: 'Invalid or missing X-Ingest-Token' });
      const input = await readJson(req);
      const result = await triage.ingest(input);
      return send(result.status === 'created' ? 201 : result.status === 'duplicate' ? 200 : 422, result);
    }
    // CSV upload from the agent UI (raw text body). Like the rest of the agent
    // API it is meant to sit behind the company SSO; the token protects the
    // public webhook above.
    if (req.method === 'POST' && p === '/api/import') {
      const text = await readBody(req);
      const records = parseCsv(text).map(mapColumns);
      if (!records.length) return send(422, { error: 'No rows found. Expected a CSV with a header line.' });
      return send(200, await triage.importRecords(records));
    }
    if (req.method === 'PATCH' && idMatch && !idMatch[2]) {
      const { actor, ...changes } = await readJson(req);
      const allowed = Object.fromEntries(Object.entries(changes).filter(([k]) => ['team', 'urgency', 'assignee', 'status', 'reason'].includes(k)));
      const result = await triage.updateConversation(Number(idMatch[1]), allowed, actor);
      return result.error ? send(result.status, { error: result.error }) : send(200, result.conversation);
    }
    if (req.method === 'POST' && idMatch?.[2]) {
      const { actor, text } = await readJson(req);
      const result = triage.addNote(Number(idMatch[1]), text, actor);
      return result.error ? send(result.status, { error: result.error }) : send(201, result.conversation);
    }
    if (p.startsWith('/api/')) return send(404, { error: 'Not found' });

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(p, res);
    return send(405, { error: 'Method not allowed' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : err.message }));
    });
  });

  return { server, db, triage, analyzer, close: () => { for (const r of sseClients) r.end(); server.close(); db.close(); } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    const data = JSON.parse(text || '{}');
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw Object.assign(new Error('Body must be a JSON object'), { status: 400 });
  }
}

function serveStatic(p, res) {
  const publicDir = path.join(ROOT, 'public');
  const file = path.normalize(path.join(publicDir, p === '/' ? 'index.html' : p));
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// `npm start`: open the database, import the backlog on first run, listen.
async function main() {
  const env = process.env;
  const dbPath = env.DB_PATH || path.join(ROOT, 'data', 'inbox.db');
  const app = await createApp({ dbPath, env });
  const empty = app.db.get('SELECT COUNT(*) AS n FROM messages').n === 0;
  const csvPath = env.BACKLOG_CSV || path.join(ROOT, 'data', 'requests-backlog.csv');
  if (empty && env.AUTO_IMPORT !== 'false' && fs.existsSync(csvPath)) {
    const result = await app.triage.importRecords(parseCsv(fs.readFileSync(csvPath, 'utf8')).map(mapColumns));
    console.log(`[import] ${path.basename(csvPath)}: ${result.created} imported, ${result.duplicate} duplicates, ${result.rejected} rejected`);
  }
  const port = Number(env.PORT || 3000);
  app.server.listen(port, () => {
    console.log(`Inbox Triage running on http://localhost:${port}`);
    console.log(`Analysis engine: ${app.analyzer.engine}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
