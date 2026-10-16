import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fixedClock } from './helpers.js';

const GOOD_KEY = 'sk-test-0123456789abcdefghijklmnop';
const MODELS = [
  { id: 'small-model', display_name: 'Small', created_at: '2026-01-01T00:00:00Z' },
  { id: 'big-model', display_name: 'Big', created_at: '2026-06-01T00:00:00Z' },
];
const answer = { category: 'how_to', secondary_categories: [], urgency: 'normal', language: 'en', summary_en: 'Coupon question.', customer_need: 'Create a coupon', reasons: ['How-to'], contains_instructions_to_ai: false, confidence: 0.9 };

// Fake Anthropic client: accepts GOOD_KEY only, lists MODELS, classifies.
function fakeFactory(calls) {
  return async (apiKey) => ({
    models: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          calls.push(['list', apiKey]);
          if (apiKey && apiKey !== GOOD_KEY) throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
          yield* MODELS;
        },
      }),
    },
    beta: { messages: { create: async (req) => { calls.push(['create', req.model]); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }; } } },
  });
}

async function start(env = {}) {
  const calls = [];
  const app = await createApp({ env, clock: fixedClock(), aiClientFactory: fakeFactory(calls) });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, calls };
}

test('settings: add a key, pick a model, the AI engine switches on; the key is never sent back', async () => {
  const { app, call, calls } = await start();
  try {
    let s = await call('/api/settings');
    assert.equal(s.body.enabled, false);
    assert.equal(s.body.keySource, null);

    const bad = await call('/api/settings/key', { method: 'POST', body: { apiKey: 'sk-wrong-0123456789abcdefghijk' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /refused this API key/);

    const saved = await call('/api/settings/key', { method: 'POST', body: { apiKey: GOOD_KEY } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.models.map((m) => m.id), ['big-model', 'small-model'], 'newest first');
    assert.equal(saved.body.status.enabled, false, 'no model chosen yet');

    const chosen = await call('/api/settings/model', { method: 'POST', body: { model: 'small-model' } });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.enabled, true);
    assert.equal(chosen.body.engine, 'AI (small-model) + rules');
    assert.ok(calls.some(([kind, m]) => kind === 'create' && m === 'small-model'), 'model tested before switching on');

    const ingest = await call('/api/messages', { method: 'POST', body: { from: 'a@b.co', message: 'How do I add a coupon?' } });
    assert.equal(ingest.body.analysis.engine, 'ai');

    for (const path of ['/api/settings', '/api/meta', '/api/settings/models']) {
      assert.ok(!JSON.stringify((await call(path)).body).includes(GOOD_KEY), `${path} never returns the key`);
    }

    s = await call('/api/settings/key', { method: 'DELETE' });
    assert.equal(s.body.enabled, false);
  } finally { app.close(); }
});

test('settings survive a restart (same database file)', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'inbox.db');
  const make = async () => {
    const app = await createApp({ dbPath, env: {}, clock: fixedClock(), aiClientFactory: fakeFactory([]) });
    await new Promise((r) => app.server.listen(0, r));
    return { app, base: `http://localhost:${app.server.address().port}` };
  };
  const first = await make();
  await fetch(`${first.base}/api/settings/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: GOOD_KEY }) });
  await fetch(`${first.base}/api/settings/model`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'big-model' }) });
  first.app.close();
  const second = await make();
  const s = await (await fetch(`${second.base}/api/settings`)).json();
  assert.equal(s.engine, 'AI (big-model) + rules');
  second.app.close();
});

test('settings need the admin token when one is set', async () => {
  const { app, call } = await start({ ADMIN_TOKEN: 'admin-secret' });
  try {
    assert.equal((await call('/api/settings/key', { method: 'POST', body: { apiKey: GOOD_KEY } })).status, 403);
    const ok = await call('/api/settings/key', { method: 'POST', body: { apiKey: GOOD_KEY }, headers: { 'x-admin-token': 'admin-secret' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('/api/settings')).body.needsAdminToken, true);
  } finally { app.close(); }
});

test('a key from the environment wins and cannot be changed from the UI', async () => {
  const { app, call } = await start({ ANTHROPIC_API_KEY: GOOD_KEY, AI_MODEL: 'big-model' });
  try {
    const s = (await call('/api/settings')).body;
    assert.equal(s.keySource, 'environment');
    assert.equal(s.engine, 'AI (big-model) + rules');
    assert.equal((await call('/api/settings/key', { method: 'POST', body: { apiKey: GOOD_KEY } })).status, 409);
  } finally { app.close(); }
});
