import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { createApp } from '../src/server.js';
import { fixedClock } from './helpers.js';

// The intake workflow (n8n/inbox-triage-intake.json) run by a small stand-in
// for n8n: its own Code nodes and expressions run as n8n runs them ($input,
// $json, this.helpers), and its HTTP Request node becomes a fetch to a real
// Inbox Triage with the X-Ingest-Token header (a Header Auth credential in n8n).
const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n', 'inbox-triage-intake.json'), 'utf8'));
const nodes = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const next = (name, output = 0) => workflow.connections[name].main[output][0].node;
const TOKEN = 'ingest-token-for-tests-123';

const AsyncFunction = (async () => {}).constructor;
const evaluate = (expression, $json) => new Function('$json', `return (${expression.replace(/^=\{\{|\}\}$/g, '')});`)($json);
function runCode(name, items) {
  const helpers = { getBinaryDataBuffer: async (i, key) => Buffer.from(items[i].binary[key].data, 'base64') };
  return new AsyncFunction('$input', nodes[name].parameters.jsCode).call({ helpers }, { first: () => items[0], all: () => items });
}

async function runWorkflow(webhookItem, { token = TOKEN } = {}) {
  const messages = await runCode(next('Receive Customer Messages'), [webhookItem]);
  const check = nodes['Any Messages?'].parameters.conditions.conditions[0];
  const hasMessages = !evaluate(check.leftValue, messages[0].json);
  const reply = nodes[next('Any Messages?', hasMessages ? 0 : 1)];
  if (!hasMessages) return { status: reply.parameters.options.responseCode, body: JSON.parse(evaluate(reply.parameters.responseBody, messages[0].json)) };
  const http = nodes['Send To Inbox Triage'].parameters;
  const responses = [];
  for (const m of messages) { // batch size 1: one message at a time, in order
    const res = await fetch(appBase + new URL(http.url).pathname, { method: http.method, headers: { 'content-type': 'application/json', 'x-ingest-token': token }, body: evaluate(http.jsonBody, m.json) });
    responses.push({ json: { statusCode: res.status, statusMessage: res.statusText, headers: {}, body: await res.json() } });
  }
  const [summary] = await runCode(next('Send To Inbox Triage'), responses);
  const respond = nodes[next('Count Results')].parameters;
  return { status: evaluate(respond.options.responseCode, summary.json), body: JSON.parse(evaluate(respond.responseBody, summary.json)) };
}

// What the n8n Webhook node outputs (raw body on): a JSON body, or a CSV in binary data.
const jsonRequest = (body) => ({ json: { headers: { 'content-type': 'application/json' }, params: {}, query: {}, body } });
const csvRequest = (text) => ({ json: { headers: { 'content-type': 'text/csv' }, params: {}, query: {}, body: {} },
  binary: { data: { data: Buffer.from(text).toString('base64'), mimeType: 'text/csv' } } });

// The workflow's URL points to your Inbox Triage; here, to a local one.
let app, appBase;
before(async () => {
  app = await createApp({ env: { INGEST_TOKEN: TOKEN }, ai: null, clock: fixedClock() });
  await new Promise((r) => app.server.listen(0, r));
  appBase = `http://localhost:${app.server.address().port}`;
});
after(() => app.close());

test('intake workflow: webhook with Header Auth, one request per message to /api/messages, no secret in the file', () => {
  const hook = nodes['Receive Customer Messages'].parameters;
  assert.deepEqual([hook.httpMethod, hook.authentication, hook.responseMode, hook.options.rawBody], ['POST', 'headerAuth', 'responseNode', true]);
  const http = nodes['Send To Inbox Triage'];
  assert.match(http.parameters.url, /\/api\/messages$/);
  assert.deepEqual([http.parameters.authentication, http.parameters.genericAuthType], ['genericCredentialType', 'httpHeaderAuth']);
  assert.equal(http.parameters.options.batching.batch.batchSize, 1);
  assert.equal(http.parameters.options.response.response.neverError, true);
  assert.equal(http.onError, 'continueRegularOutput');
  assert.ok(workflow.nodes.every((n) => !n.credentials), 'credentials are chosen in n8n, never stored in the file');
});

test('one JSON message is created and analysed', async () => {
  const res = await runWorkflow(jsonRequest({ source: 'chat', from: 'Nina <nina@example.com>', message: 'My account was hacked, someone changed my email!' }));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.received, res.body.created], [1, 1]);
  assert.deepEqual([res.body.results[0].team, res.body.results[0].urgency], ['security_legal', 'critical']);
});

test('a CSV file (the backlog): 30 messages created in order; sent again, 30 duplicates', async () => {
  const csv = fs.readFileSync(path.join(ROOT, 'data', 'requests-backlog.csv'), 'utf8');
  const first = await runWorkflow(csvRequest(csv));
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.received, first.body.created, first.body.failed], [30, 30, 0]);
  const again = await runWorkflow(csvRequest(csv));
  assert.equal(again.body.duplicate, 30);
  const sarah = app.triage.listConversations().find((c) => c.sender_label === 'Sarah Martin');
  assert.equal(sarah.message_count, 3, 'messages from the same customer are grouped');
  assert.equal(app.db.all('SELECT * FROM incidents').length, 1, 'the Stripe incident is detected');
});

test('a JSON list with other column names, a { name, address } sender, and an empty message', async () => {
  const res = await runWorkflow(jsonRequest({ messages: [
    { Date: '2026-10-12 08:30', Channel: 'form', Sender: 'Omar <omar@example.com>', Text: 'How do I add a coupon to my order form?' },
    { created_at: '2026-10-12 08:40', from: { name: 'Ola', address: 'ola@example.com' }, body: 'Mon DKIM reste non vérifié depuis 3 jours' },
    { from: 'lea@example.com', message: '   ' },
  ] }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.outcome), ['created', 'created', 'rejected']);
  assert.equal(res.body.results[1].team, 'deliverability');
  assert.match(res.body.results[2].error, /empty/);
  const ola = app.triage.listConversations().find((c) => c.customer_email === 'ola@example.com');
  assert.equal(ola.sender_label, 'Ola');
});

test('{ "csv": "..." } inside JSON works too', async () => {
  const res = await runWorkflow(jsonRequest({ csv: 'received_at,from,message\n2026-10-12 08:55,kim@example.com,"Comment créer un code promo, svp ?"\n' }));
  assert.deepEqual([res.status, res.body.created], [200, 1]);
});

test('a wrong token fails every message with a clear answer; nothing usable is a 400', async () => {
  const wrong = await runWorkflow(jsonRequest({ from: 'x@example.com', message: 'Hello, how do I export my contacts?' }), { token: 'wrong' });
  assert.equal(wrong.status, 502);
  assert.equal(wrong.body.failed, 1);
  assert.match(wrong.body.results[0].error, /X-Ingest-Token/);
  const empty = await runWorkflow(jsonRequest({}));
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /No message found/);
  assert.equal((await runWorkflow(csvRequest('received_at,from,message\n'))).status, 400, 'a CSV with only a header');
});
