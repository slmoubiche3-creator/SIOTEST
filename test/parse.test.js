import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, mapColumns, parseDate, parseSender } from '../src/parse.js';

const NOW = new Date('2026-10-12T09:00:00Z');

test('CSV: quotes, commas, escaped quotes, newlines, BOM, CRLF', () => {
  const rows = parseCsv('﻿received_at,from,message\r\n2026-10-05,"A, B <a@b.co>","He said ""hi""\nthen left"\r\n\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, 'A, B <a@b.co>');
  assert.equal(rows[0].message, 'He said "hi"\nthen left');
});

test('CSV: column aliases from other tools are mapped', () => {
  const [row] = parseCsv('Date,Channel,Email,Name,Body,ID\n2026-10-05,chat,x@y.com,Xavier,Hello,42').map(mapColumns);
  assert.deepEqual([row.received_at, row.source, row.email, row.name, row.message, row.external_id], ['2026-10-05', 'chat', 'x@y.com', 'Xavier', 'Hello', '42']);
});

test('dates: every format found in the backlog', () => {
  const cases = {
    '2026-10-05 09:12': ['2026-10-05T09:12:00.000Z', 'minute'],
    '06/10/2026 10:40': ['2026-10-06T10:40:00.000Z', 'minute'],
    'Oct 5 2026': ['2026-10-05T00:00:00.000Z', 'day'],
    '03/10/2026': ['2026-10-03T00:00:00.000Z', 'day'],
    'Oct 9': ['2026-10-09T00:00:00.000Z', 'day'],
    '11/10/2026 19:31': ['2026-10-11T19:31:00.000Z', 'minute'],
    '2026-10-06': ['2026-10-06T00:00:00.000Z', 'day'],
  };
  for (const [raw, [iso, precision]] of Object.entries(cases)) {
    const d = parseDate(raw, NOW);
    assert.equal(d.iso, iso, raw);
    assert.equal(d.precision, precision, raw);
  }
  assert.match(parseDate('Oct 9', NOW).notes.join(), /year missing/);
});

test('dates: MM/DD only when DD/MM is impossible, garbage returns null', () => {
  assert.equal(parseDate('10/25/2026', NOW).iso, '2026-10-25T00:00:00.000Z');
  assert.equal(parseDate('31/02/2026', NOW), null);
  assert.equal(parseDate('yesterday-ish', NOW), null);
  assert.equal(parseDate('', NOW), null);
});

test('dates: a missing year never lands in the future', () => {
  assert.equal(parseDate('Dec 20', NOW).iso, '2025-12-20T00:00:00.000Z');
});

test('senders: name+email, bare email, empty, invalid, case-insensitive', () => {
  assert.deepEqual(parseSender('Sarah Martin <SARAH.MARTIN@gmail.com>'), { name: 'Sarah Martin', email: 'sarah.martin@gmail.com', issue: null });
  assert.deepEqual(parseSender('info@bestcryptodeals.biz'), { name: null, email: 'info@bestcryptodeals.biz', issue: null });
  assert.equal(parseSender('').issue, 'missing');
  assert.deepEqual(parseSender('lina.haddad.com'), { name: null, email: null, issue: 'invalid', rawAddress: 'lina.haddad.com' });
});
