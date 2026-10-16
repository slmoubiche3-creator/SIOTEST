import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAM_IDS } from './taxonomy.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadTeams(file = path.join(ROOT, 'config', 'teams.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const teams = {};
  for (const id of TEAM_IDS) {
    const t = raw[id] ?? {};
    teams[id] = { lead: t.lead ?? null, oncall: t.oncall ?? null, members: t.members ?? [], slack: t.slack ?? null };
  }
  return teams;
}

// "Today" for the test is Monday 12 Oct 2026. The clock starts there and
// then ticks in real time, so SLA timers keep moving. APP_NOW=real uses the
// machine clock.
export function createClock(appNow = process.env.APP_NOW ?? '2026-10-12T09:00:00Z') {
  if (appNow === 'real') return { now: () => Date.now(), simulated: false };
  const base = Date.parse(appNow);
  if (Number.isNaN(base)) throw new Error(`Invalid APP_NOW: ${appNow}`);
  const started = Date.now();
  return { now: () => base + (Date.now() - started), simulated: true };
}
