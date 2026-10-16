import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { createN8nEngine } from '../src/analyzer/n8n.js';
import { createAnalyzer } from '../src/analyzer/index.js';
import { fixedClock, TODAY } from './helpers.js';

const SECRET = 'n8n-shared-secret-123456';
const answer = { category: 'affiliate', secondary_categories: [], urgency: 'normal', language: 'ar', summary_en: 'Affiliate commissions unpaid for two months.', customer_need: 'Get affiliate commissions paid', reasons: ['Asks about missing commissions'], contains_instructions_to_ai: false, confidence: 0.88 };
let n8n, url, mode = 'ok';
const received = [];

// A stand-in for the n8n workflow: header auth, then { output } like the Structured Output Parser.
before(async () => {
  n8n = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-triage-secret'] !== SECRET) { res.statusCode = 403; return res.end(JSON.stringify({ message: 'Authorization data is wrong!' })); }
      if (mode === 'ai-error') { res.statusCode = 502; return res.end(JSON.stringify({ error: 'OpenAI quota exceeded' })); }
      res.end(JSON.stringify({ output: answer }));
    });
  });
  await new Promise((r) => n8n.listen(0, r));
  url = `http://localhost:${n8n.address().port}/webhook/inbox-triage-classify`;
});
after(() => n8n.close());

const ctx = { receivedAt: '2026-10-12T08:00:00Z', now: TODAY };

test('n8n engine: sends instructions + message with the secret header, reads { output }', async () => {
  mode = 'ok';
  const a = await createAnalyzer({ ai: createN8nEngine({ url, secret: SECRET }) }).analyze({ body: 'مرحبا، لم أستلم عمولاتي' }, ctx);
  assert.equal(a.engine, 'ai');
  assert.equal(a.team, 'billing');
  assert.equal(a.summary, 'Affiliate commissions unpaid for two months.');
  const last = received.at(-1);
  assert.equal(last.headers['x-triage-secret'], SECRET);
  assert.match(last.body.system, /triage inbound customer messages/);
  assert.match(last.body.prompt, /<customer_message>\nمرحبا/);
});

test('n8n engine: an AI failure in n8n falls back to the rules', async () => {
  mode = 'ai-error';
  const a = await createAnalyzer({ ai: createN8nEngine({ url, secret: SECRET }) }).analyze({ body: 'How do I add a coupon?' }, ctx);
  assert.equal(a.engine, 'rules');
  assert.match(a.engineError, /502.*quota/);
  mode = 'ok';
});

test('settings: connect n8n (tested first), secret never returned, then disconnect', async () => {
  mode = 'ok';
  const app = await createApp({ env: {}, clock: fixedClock(), aiClientFactory: async () => { throw new Error('not used'); } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const wrong = await call('/api/settings/n8n', 'POST', { url, secret: 'wrong-secret-but-long-enough' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /refused the secret/);

    const ok = await call('/api/settings/n8n', 'POST', { url, secret: SECRET });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.provider, 'n8n');
    assert.equal(ok.body.engine, 'AI (n8n workflow) + rules');
    assert.deepEqual(ok.body.n8n, { url, secretSet: true, header: 'X-Triage-Secret' });

    const again = await call('/api/settings/n8n', 'POST', { url });
    assert.equal(again.status, 200, 'the saved secret is reused when the field is left empty');

    const ingest = await call('/api/messages', 'POST', { from: 'noor@noorbeauty.ae', message: 'مرحبا، لم أستلم عمولاتي كأفلييت منذ شهرين' });
    assert.equal(ingest.body.analysis.engine, 'ai');
    for (const path of ['/api/settings', '/api/meta']) assert.ok(!JSON.stringify((await call(path)).body).includes(SECRET), `${path} never returns the secret`);

    const off = await call('/api/settings/n8n', 'DELETE');
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.provider, 'anthropic');
  } finally { app.close(); }
});

test('settings: bad n8n URL is refused before any call', async () => {
  const app = await createApp({ env: {}, clock: fixedClock() });
  await new Promise((r) => app.server.listen(0, r));
  const res = await fetch(`http://localhost:${app.server.address().port}/api/settings/n8n`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'ftp://nope', secret: SECRET }) });
  assert.equal(res.status, 400);
  app.close();
});
