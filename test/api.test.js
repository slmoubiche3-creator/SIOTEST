import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { fixedClock } from './helpers.js';

let app, base, slack;
const received = [];

before(async () => {
  // A local stand-in for Slack's incoming webhook.
  slack = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
  });
  await new Promise((r) => slack.listen(0, r));
  const env = { INGEST_TOKEN: 's3cret', SLACK_WEBHOOK_URL_SECURITY_LEGAL: `http://localhost:${slack.address().port}/hook` };
  app = await createApp({ env, ai: null, clock: fixedClock() });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => { app.close(); slack.close(); });

const call = (path, { method = 'GET', body, token = 's3cret', type = 'application/json' } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': type, ...(token && { 'x-ingest-token': token }) }, body: body && (typeof body === 'string' ? body : JSON.stringify(body)) });

test('webhook requires the shared token', async () => {
  const res = await call('/api/messages', { method: 'POST', body: { message: 'hi' }, token: 'wrong' });
  assert.equal(res.status, 401);
});

test('webhook: a hacked account becomes a critical Security conversation and pings Slack', async () => {
  const res = await call('/api/messages', { method: 'POST', body: { source: 'chat', from: 'Ahmed <ahmed@x.com>', message: 'My account was hacked last night, my password is hunter2, help!' } });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.analysis.team, 'security_legal');
  assert.equal(out.analysis.urgency, 'critical');
  assert.equal(received.length, 1);
  assert.match(received[0].text, /CRITICAL/);
  assert.ok(!received[0].text.includes('hunter2'), 'password redacted from Slack');
  const again = await call('/api/messages', { method: 'POST', body: { source: 'chat', from: 'Ahmed <ahmed@x.com>', message: 'My account was hacked last night, my password is hunter2, help!' } });
  assert.equal((await again.json()).status, 'duplicate');
});

test('bad input is rejected with a clear error', async () => {
  assert.equal((await call('/api/messages', { method: 'POST', body: { message: 'hi', email: 123, name: null } })).status, 201, 'non-string fields do not crash');
  assert.equal((await call('/api/messages', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await call('/api/messages', { method: 'POST', body: { message: '' } })).status, 422);
  assert.equal((await call('/api/import', { method: 'POST', body: '', type: 'text/csv' })).status, 422);
});

test('CSV import over HTTP, then team filter and PATCH', async () => {
  const csv = 'received_at,source,from,message\n2026-10-12 08:00,email,Lea <lea@x.fr>,"Comment créer un code promo ?"\n';
  const res = await call('/api/import', { method: 'POST', body: csv, type: 'text/csv' });
  assert.deepEqual(await res.json(), { created: 1, duplicate: 0, rejected: 0, errors: [] });
  const support = await (await call('/api/conversations?team=support')).json();
  const conv = support.find((c) => c.customer_email === 'lea@x.fr');
  assert.ok(conv);
  const missingActor = await call(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { status: 'resolved' } });
  assert.equal(missingActor.status, 400);
  const ok = await call(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { actor: 'Inès', assignee: 'Karim', status: 'waiting_customer' } });
  const updated = await ok.json();
  assert.equal(updated.assignee, 'Karim');
  assert.equal(updated.status, 'waiting_customer');
  const note = await call(`/api/conversations/${conv.id}/notes`, { method: 'POST', body: { actor: 'Karim', text: 'Sent the coupon tutorial' } });
  assert.equal(note.status, 201);
});

test('static files are served, path traversal is not', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const res = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(res.status, 404);
});

test('meta and stats endpoints', async () => {
  const meta = await (await call('/api/meta')).json();
  assert.equal(meta.teams.length, 7);
  assert.equal(meta.engine, 'rules');
  const stats = await (await call('/api/stats')).json();
  assert.ok(stats.byTeam.security_legal.critical >= 1);
});
