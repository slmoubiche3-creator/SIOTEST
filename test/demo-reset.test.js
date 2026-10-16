import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { fixedClock } from './helpers.js';

// An app on a database file (like `npm start`), with the demo backlog imported.
async function start(t, { env = {}, backlogCsv, dbPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const slack = [];
  const fetchImpl = async (url, opts) => { slack.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; };
  const app = await createApp({ dbPath: dbPath ?? path.join(dir, 'inbox.db'), env, clock: fixedClock(), fetchImpl, ...(backlogCsv && { backlogCsv }) });
  let open = true;
  const close = () => { if (open) { open = false; app.close(); } };
  t.after(close);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, base, call, slack, close };
}

// Some agent work on top of the backlog: an assignment, a note, a new message.
async function work(call) {
  const sarah = (await call('/api/conversations')).body.find((c) => c.sender_label === 'Sarah Martin');
  await call(`/api/conversations/${sarah.id}`, { method: 'PATCH', body: { actor: 'Julien', assignee: 'Julien' } });
  await call(`/api/conversations/${sarah.id}/notes`, { method: 'POST', body: { actor: 'Julien', text: 'Asked for a DNS screenshot' } });
  await call('/api/messages', { method: 'POST', body: { from: 'Nina <nina@example.com>', message: 'My account was hacked!' } });
  return sarah.id;
}

test('the backlog is imported on first start only; loading pages never resets anything', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'inbox.db');
  const first = await start(t, { dbPath });
  assert.equal((await first.app.importIfEmpty()).created, 30);
  const id = await work(first.call);
  for (const p of ['/', '/app.js', '/api/meta', '/api/stats', '/api/conversations', '/api/notifications']) await fetch(first.base + p);
  assert.equal((await first.call(`/api/conversations/${id}`)).body.assignee, 'Julien', 'page loads change nothing');
  first.close();

  const second = await start(t, { dbPath });
  assert.equal(await second.app.importIfEmpty(), null, 'a restart does not import again');
  const sarah = (await second.call(`/api/conversations/${id}`)).body;
  assert.equal(sarah.assignee, 'Julien');
  assert.ok(sarah.events.some((e) => e.type === 'note'));
  assert.equal((await second.call('/api/conversations?status=all')).body.length, 27);
});

test('reset demo data: back to the backlog, AI settings kept, no Slack ping, one live "reset" event', async (t) => {
  const { app, base, call, slack } = await start(t, { env: { SLACK_WEBHOOK_URL: 'https://hooks.example/x' } });
  await app.importIfEmpty();
  const id = await work(call);
  app.db.run(`INSERT INTO settings (key, value) VALUES ('ai_model', 'some-model')`);
  const pingsBefore = slack.length;

  // Listen to live updates like an open page.
  const live = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: live.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const readUntilReset = (async () => {
    while (!seen.includes('event: reset')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
  })();

  const res = await call('/api/demo/reset', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { created: 30, duplicate: 0, rejected: 0, errors: [] });
  await readUntilReset;
  live.abort();
  assert.match(seen, /event: reset\ndata: \{"created":30/);
  assert.ok(!seen.includes('event: notification'), 'no toast per alert while re-importing');

  const all = (await call('/api/conversations?status=all')).body;
  assert.equal(all.length, 26, 'the extra conversation is gone');
  assert.ok(all.every((c) => !c.assignee && c.status === 'new'));
  assert.equal(Math.min(...all.map((c) => c.id)), 1, 'ids start again at 1');
  const sarah = all.find((c) => c.sender_label === 'Sarah Martin');
  assert.ok((await call(`/api/conversations/${sarah.id}`)).body.events.every((e) => e.actor === 'system'), 'notes and agent history are gone');
  assert.equal(sarah.id, id);
  const alerts = (await call('/api/notifications')).body;
  assert.equal(alerts.length, 7);
  assert.ok(alerts.every((n) => !n.channels.slack || n.channels.slack === 'not sent (demo reset)'));
  assert.equal(slack.length, pingsBefore, 'Slack is not pinged again');
  assert.equal(app.db.get(`SELECT value FROM settings WHERE key = 'ai_model'`).value, 'some-model', 'AI settings are kept');
  assert.equal(app.db.all('SELECT * FROM incidents').length, 1);

  // After the reset, new messages alert Slack again.
  await call('/api/messages', { method: 'POST', body: { from: 'Omar <omar@example.com>', message: 'Someone hacked my account and changed my password!' } });
  assert.equal(slack.length, pingsBefore + 1);
});

test('reset demo data is protected like Settings', async (t) => {
  const { app, call } = await start(t, { env: { ADMIN_TOKEN: 'admin-secret' } });
  await app.importIfEmpty();
  const refused = await call('/api/demo/reset', { method: 'POST' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /admin token/);
  const ok = await call('/api/demo/reset', { method: 'POST', headers: { 'x-admin-token': 'admin-secret' } });
  assert.equal(ok.status, 200);
});

test('a missing demo file is refused and leaves the data untouched', async (t) => {
  const { app, call } = await start(t, { backlogCsv: '/nonexistent/requests-backlog.csv' });
  await app.triage.ingest({ from: 'a@b.co', message: 'How do I add a coupon?' });
  const res = await call('/api/demo/reset', { method: 'POST' });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /not found or empty/);
  assert.equal((await call('/api/conversations')).body.length, 1);
});
