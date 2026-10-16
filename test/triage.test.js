import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTriage, backlogRecords, fixedClock, TODAY } from './helpers.js';

const importBacklog = async (opts) => { const t = makeTriage(opts); const res = await t.triage.importRecords(backlogRecords()); return { ...t, res }; };
const findBy = (triage, label) => triage.listConversations({ status: 'all' }).find((c) => c.sender_label.startsWith(label));

test('backlog import: 30 messages become 26 conversations; re-import is idempotent', async () => {
  const { triage, res } = await importBacklog();
  assert.deepEqual(res, { created: 30, duplicate: 0, rejected: 0, errors: [] });
  assert.equal(triage.listConversations({ status: 'all' }).length, 26);
  assert.equal((await triage.importRecords(backlogRecords())).duplicate, 30);
});

test('repeat contacts are grouped (case-insensitive email) and escalated', async () => {
  const { triage } = await importBacklog();
  const sarah = findBy(triage, 'Sarah Martin');
  assert.equal(sarah.message_count, 3);
  assert.equal(sarah.urgency, 'high');
  assert.equal(sarah.deadline_days_left, 3);
  assert.ok(sarah.flags.some((f) => f.type === 'repeat_contact'));
  const tom = findBy(triage, 'Tom Becker');
  assert.equal(tom.urgency, 'high');
  assert.equal(tom.team, 'support');
  assert.deepEqual(tom.secondary_teams, ['product']);
  assert.ok(!tom.flags.some((f) => f.type === 'no_rush'), 'stale "no rush" removed');
});

test('incident: 4 customers with failing Stripe checkout = one incident, one Slack ping', async () => {
  const { triage, db, slackCalls } = await importBacklog({ env: { SLACK_WEBHOOK_URL: 'https://hooks.example/x' } });
  const incidents = db.all('SELECT * FROM incidents');
  assert.equal(incidents.length, 1);
  assert.match(incidents[0].title, /Stripe payments failing \(3 customers/);
  assert.equal(triage.listConversations({ incident: incidents[0].id }).length, 4);
  const kinds = triage.listNotifications().map((n) => n.kind).sort();
  assert.deepEqual(kinds, ['critical', 'critical', 'critical', 'critical', 'critical_followup', 'incident', 'incident_update']);
  assert.equal(slackCalls.length, 6, 'incident_update stays in the app');
  const incidentPing = slackCalls.find((c) => c.body.text.includes('Possible incident'));
  assert.match(incidentPing.body.text, /#tech-oncall/);
  assert.match(incidentPing.body.text, /@Julien @Mehdi @Inès/);
});

test('alerts go to the owning team on-call and lead', async () => {
  const { triage } = await importBacklog();
  const ceo = triage.listNotifications().find((n) => n.body.includes('CEO'));
  assert.equal(ceo.team, 'security_legal');
  assert.deepEqual(ceo.recipients, ['Antoine', 'Yasmine']);
  const followup = triage.listNotifications().find((n) => n.kind === 'critical_followup');
  assert.match(followup.title, /nobody owns/);
});

test('missing / invalid senders are flagged, not dropped', async () => {
  const { triage } = await importBacklog();
  const flags = triage.listConversations().flatMap((c) => c.flags.map((f) => f.type));
  assert.ok(flags.includes('no_sender'));
  assert.ok(flags.includes('invalid_sender'));
});

test('agent workflow: assign, answer, customer replies (SLA restarts), resolve', async () => {
  let now = TODAY;
  const clock = { now: () => now, simulated: true };
  const { triage } = makeTriage({ clock });
  const { conversationId: id } = await triage.ingest({ from: 'Leo <leo@x.de>', message: 'Wie kann ich einen Drip-Content-Zeitplan einstellen?' });

  assert.equal((await triage.updateConversation(id, { assignee: 'Mehdi' }, 'Inès')).status, 400, 'Mehdi is not in Support');
  let c = (await triage.updateConversation(id, { assignee: 'Léa' }, 'Inès')).conversation;
  assert.equal(c.status, 'in_progress', 'assigning starts the work');

  now += 3600000;
  c = (await triage.updateConversation(id, { status: 'waiting_customer' }, 'Léa')).conversation;
  assert.equal(c.sla.state, 'met');

  now += 3600000;
  await triage.ingest({ from: 'leo@x.de', message: 'Danke, aber es funktioniert nicht.' });
  c = triage.getConversation(id);
  assert.equal(c.status, 'in_progress');
  assert.equal(c.message_count, 2);
  assert.equal(c.sla_started_at, new Date(now).toISOString());

  c = (await triage.updateConversation(id, { status: 'resolved' }, 'Léa')).conversation;
  assert.ok(c.resolved_at);
  const types = c.events.map((e) => e.type);
  assert.deepEqual(types.filter((t) => t !== 'message_received'), ['created', 'assigned', 'status_changed', 'status_changed', 'status_changed', 'status_changed']);
});

test('moving a critical conversation alerts the new team; manual team choice survives new messages', async () => {
  const { triage } = makeTriage();
  const { conversationId: id } = await triage.ingest({ from: 'a@b.co', message: 'Someone logged into my account and changed my payout email!' });
  const res = await triage.updateConversation(id, { team: 'billing', reason: 'payout freeze first' }, 'Yasmine');
  assert.equal(res.conversation.team, 'billing');
  assert.ok(triage.listNotifications().some((n) => n.team === 'billing' && n.kind === 'critical'));
  await triage.ingest({ from: 'a@b.co', message: 'Still no answer about my hacked account!' });
  assert.equal(triage.getConversation(id).team, 'billing');
  assert.equal(triage.stats().routing.rerouted, 1);
});

test('rejects empty messages; unreadable dates fall back to arrival time with a note', async () => {
  const { triage } = makeTriage({ clock: fixedClock() });
  assert.equal((await triage.ingest({ message: '   ' })).status, 'rejected');
  const r = await triage.ingest({ received_at: 'last tuesday', from: 'z@z.io', message: 'How do I export my contacts?' });
  const m = triage.getConversation(r.conversationId).messages[0];
  assert.equal(m.received_at, new Date(TODAY).toISOString());
  assert.match(m.date_notes[0], /could not read/);
});

test('incident needs 3 different customers within 3 hours', async () => {
  const stripe = (from, at) => ({ received_at: at, from, message: 'Checkout broken, customers get payment failed with Stripe.' });
  // Same sender without a valid email, three times: one customer, no incident.
  const a = makeTriage();
  for (const at of ['2026-10-12 06:00', '2026-10-12 06:10', '2026-10-12 06:20']) await a.triage.ingest(stripe('not-an-email', at));
  assert.equal(a.db.get('SELECT COUNT(*) AS n FROM incidents').n, 0);
  // Three customers spread over 6 hours: never 3 in the same 3-hour window.
  const b = makeTriage();
  await b.triage.ingest(stripe('a@x.io', '2026-10-12 00:00'));
  await b.triage.ingest(stripe('c@x.io', '2026-10-12 06:00'));
  await b.triage.ingest(stripe('b@x.io', '2026-10-12 03:00'));
  assert.equal(b.db.get('SELECT COUNT(*) AS n FROM incidents').n, 0);
  // Three customers within an hour: incident.
  const c = makeTriage();
  for (const [who, at] of [['a@x.io', '2026-10-12 06:00'], ['b@x.io', '2026-10-12 06:20'], ['c@x.io', '2026-10-12 06:40']]) await c.triage.ingest(stripe(who, at));
  assert.equal(c.db.get('SELECT COUNT(*) AS n FROM incidents').n, 1);
});
