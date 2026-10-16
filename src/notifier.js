// Alerts the right people: the team's on-call and lead, in the app (live)
// and in Slack when a webhook is configured. Every alert is stored so the
// team can see what was sent and whether delivery worked.
import { teamName } from './taxonomy.js';
import { redactSecrets } from './redact.js';

export function createNotifier({ db, teams, clock, broadcast = () => {}, appUrl = 'http://localhost:3000', env = process.env, fetchImpl = fetch }) {
  async function notify({ kind, team, conversationId = null, incidentId = null, title, body, extraRecipients = [], slack = true }) {
    const t = teams[team] ?? {};
    const recipients = [...new Set([t.oncall, t.lead, ...extraRecipients].filter(Boolean))];
    const safeBody = redactSecrets(body);
    const channels = { in_app: 'sent' };
    const webhook = env[`SLACK_WEBHOOK_URL_${team.toUpperCase()}`] || env.SLACK_WEBHOOK_URL;
    if (slack && webhook) {
      const link = conversationId ? `${appUrl}/#/c/${conversationId}` : appUrl;
      const text = [
        `${kind.startsWith('incident') ? ':rotating_light:' : ':red_circle:'} *${title}*`,
        safeBody,
        `Team: *${teamName(team)}* ${t.slack ?? ''} · cc ${recipients.map((r) => `@${r}`).join(' ')}`,
        `<${link}|Open in Inbox Triage>`,
      ].join('\n');
      try {
        const res = await fetchImpl(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(5000),
        });
        channels.slack = res.ok ? 'sent' : `failed (HTTP ${res.status})`;
      } catch (err) {
        channels.slack = `failed (${err.message})`;
      }
    } else if (slack) {
      channels.slack = 'not configured';
    }
    const at = new Date(clock.now()).toISOString();
    const { lastInsertRowid } = db.run(
      'INSERT INTO notifications (at, kind, team, conversation_id, incident_id, recipients, title, body, channels) VALUES (?,?,?,?,?,?,?,?,?)',
      at, kind, team, conversationId, incidentId, recipients, title, safeBody, channels,
    );
    const record = { id: Number(lastInsertRowid), at, kind, team, conversation_id: conversationId, incident_id: incidentId, recipients, title, body: safeBody, channels };
    broadcast('notification', record);
    return record;
  }
  return { notify };
}
