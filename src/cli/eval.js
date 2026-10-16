// Measures the analyzer against human labels.
//   npm run eval                      -> backlog (labels in test/fixtures/backlog-expected.json)
//   npm run eval -- data/holdout.csv  -> any CSV with expected_team / expected_urgency columns
// Uses the AI engine too when ANTHROPIC_API_KEY and AI_MODEL are set (this costs API credits).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { parseCsv, mapColumns, parseDate } from '../parse.js';
import { createAnalyzer } from '../analyzer/index.js';
import { aiEngineFromEnv } from '../analyzer/ai.js';

const file = process.argv[2] ?? path.join(ROOT, 'data', 'requests-backlog.csv');
const rows = parseCsv(fs.readFileSync(file, 'utf8'));
const labelsFile = path.join(ROOT, 'test', 'fixtures', 'backlog-expected.json');
const labels = rows[0]?.expected_team
  ? rows.map((r) => ({ team: r.expected_team, urgency: r.expected_urgency, language: r.expected_language }))
  : JSON.parse(fs.readFileSync(labelsFile, 'utf8')).rows;

const now = Date.parse(process.env.APP_NOW ?? '2026-10-12T09:00:00Z');
const analyzer = createAnalyzer({ ai: await aiEngineFromEnv() });
const score = { team: 0, urgency: 0, language: 0 };
const misses = [];
for (const [i, row] of rows.entries()) {
  const rec = mapColumns(row);
  const receivedAt = parseDate(rec.received_at, new Date(now))?.iso ?? new Date(now).toISOString();
  const a = await analyzer.analyze({ body: rec.message, subject: rec.subject }, { receivedAt, now });
  const want = labels[i];
  for (const key of ['team', 'urgency', 'language']) {
    if (!want[key]) continue;
    if (a[key] === want[key]) score[key] += 1;
    else misses.push(`row ${i + 2} ${key}: got ${a[key]}, expected ${want[key]} | ${rec.message.slice(0, 70)}`);
  }
}
const pct = (n) => `${n}/${rows.length} (${Math.round((n / rows.length) * 100)}%)`;
console.log(`File: ${path.relative(ROOT, file)} · engine: ${analyzer.engine}`);
console.log(`Team     ${pct(score.team)}\nUrgency  ${pct(score.urgency)}\nLanguage ${pct(score.language)}`);
if (misses.length) console.log(`\nMisses:\n${misses.join('\n')}`);
