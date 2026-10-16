import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTriage, backlogRecords } from './helpers.js';
import { openDb } from '../src/db.js';

const importBacklog = async () => { const t = makeTriage(); await t.triage.importRecords(backlogRecords()); return t; };
const types = (c) => c.flags.map((f) => f.type);

test('Needs review: the 7 backlog conversations with a doubt, each with its reason; spam stays out', async () => {
  const { triage } = await importBacklog();
  const review = triage.listConversations({ review: '1' });
  assert.deepEqual(review.map((c) => c.sender_label).sort(), [
    'Ben Carter', 'Jonas Weber', 'Karim Benali', 'Olivier Lambert', 'Sarah Martin', 'Unknown sender (no address)', 'lina.haddad.com (invalid address)',
  ]);
  assert.equal(triage.stats().needsReview, 7);
  const by = (label) => review.find((c) => c.sender_label.startsWith(label));
  assert.ok(types(by('Unknown sender')).includes('no_sender'));
  assert.ok(types(by('lina.haddad.com')).includes('invalid_sender'));
  assert.ok(types(by('Karim')).includes('prompt_injection'));
  assert.match(by('Olivier').flags.find((f) => f.type === 'date_guessed').label, /year missing.*"Oct 9"/);
  assert.match(by('Ben Carter').flags.find((f) => f.type === 'date_guessed').label, /read as DD\/MM/);
  const spam = triage.listConversations().find((c) => c.sender_label.includes('bestcryptodeals'));
  assert.ok(types(spam).includes('date_guessed') && !spam.needs_review, 'spam with a guessed date is not worth a review');
});

test('a date is only "guessed" when it really was', async () => {
  const { triage } = makeTriage();
  const flagsOf = async (received_at, from) => types(triage.getConversation((await triage.ingest({ received_at, from, message: 'How do I export my contacts?' })).conversationId));
  assert.ok(!(await flagsOf('2026-10-11', 'a@x.io')).includes('date_guessed'), 'a date without a time is not a guess');
  assert.ok(!(await flagsOf(undefined, 'b@x.io')).includes('date_guessed'), 'no date on a webhook = arrival time, not a guess');
  assert.ok((await flagsOf('last tuesday', 'c@x.io')).includes('date_guessed'));
  assert.ok((await flagsOf('02/13/2026', 'd@x.io')).includes('date_guessed'), 'read as MM/DD');
  assert.ok(!(await flagsOf('13/02/2026', 'f@x.io')).includes('date_guessed'), '13/02 can only be DD/MM');
  assert.ok((await flagsOf('03/02/2026', 'e@x.io')).includes('date_guessed'), 'day and month could be swapped');
});

test('"Mark as checked" removes it from review; a new doubtful message brings it back', async () => {
  const { triage } = makeTriage();
  const { conversationId: id } = await triage.ingest({ from: 'lina.haddad.com', message: 'Can you help us move our Kartra funnels?' });
  const { conversationId: other } = await triage.ingest({ received_at: 'Oct 9', from: 'ola@x.io', message: 'How do I add a coupon?' });
  assert.ok(triage.getConversation(id).needs_review);

  assert.equal((await triage.updateConversation(other, { reviewed: true }, '')).status, 400, 'actor required');
  const checked = (await triage.updateConversation(other, { reviewed: true }, 'Inès')).conversation;
  assert.equal(checked.needs_review, false);
  assert.equal(checked.reviewed_by, 'Inès');
  assert.deepEqual([checked.events.at(-1).actor, checked.events.at(-1).type], ['Inès', 'reviewed']);
  assert.deepEqual(triage.listConversations({ review: '1' }).map((c) => c.id), [id]);

  await triage.ingest({ received_at: '2026-10-12 08:00', from: 'ola@x.io', message: 'Thanks, found it.' });
  assert.equal(triage.getConversation(other).needs_review, false, 'a clear new message keeps it checked');
  await triage.ingest({ received_at: 'Oct 10', from: 'ola@x.io', message: 'One more question about coupons.' });
  assert.equal(triage.getConversation(other).needs_review, true, 'a new guessed date needs a new check');
});

test('banner data: open incidents count their open conversations; repeat contacts carry their count', async () => {
  const { triage } = await importBacklog();
  const [incident] = triage.stats().incidents;
  assert.equal(incident.conversations, 4);
  assert.equal(incident.open_conversations, 4);
  const stripe = triage.listConversations({ incident: incident.id });
  await triage.updateConversation(stripe[0].id, { status: 'resolved' }, 'Julien');
  assert.equal(triage.stats().incidents[0].open_conversations, 3);
  const sarah = triage.listConversations().find((c) => c.sender_label === 'Sarah Martin');
  assert.equal(sarah.flags.find((f) => f.type === 'repeat_contact').count, 3);
});

test('an older database file gets the new columns when opened', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  openDb(file).close();
  const old = new DatabaseSync(file);
  old.exec('ALTER TABLE conversations DROP COLUMN reviewed_at; ALTER TABLE conversations DROP COLUMN reviewed_by;');
  old.close();
  const db = openDb(file);
  const columns = db.all('PRAGMA table_info(conversations)').map((c) => c.name);
  db.close();
  assert.ok(columns.includes('reviewed_at') && columns.includes('reviewed_by'));
});
