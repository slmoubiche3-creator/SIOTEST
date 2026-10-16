import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadTeams } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createAnalyzer } from '../src/analyzer/index.js';
import { createNotifier } from '../src/notifier.js';
import { createTriage } from '../src/triage.js';
import { parseCsv, mapColumns } from '../src/parse.js';

export const TODAY = Date.parse('2026-10-12T09:00:00Z');
export const fixedClock = (t = TODAY) => ({ now: () => t, simulated: true });
export const backlogRecords = () => parseCsv(fs.readFileSync(path.join(ROOT, 'data', 'requests-backlog.csv'), 'utf8')).map(mapColumns);

// A triage service on an in-memory database, with captured Slack calls.
export function makeTriage({ ai = null, env = {}, clock = fixedClock() } = {}) {
  const db = openDb(':memory:');
  const slackCalls = [];
  const fetchImpl = async (url, opts) => { slackCalls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  const teams = loadTeams();
  const notifier = createNotifier({ db, teams, clock, env, fetchImpl });
  const triage = createTriage({ db, analyzer: createAnalyzer({ ai }), notifier, clock, teams });
  return { db, triage, slackCalls };
}
