// The triage service: receives messages, groups them into conversations,
// keeps urgency/SLA up to date, detects incidents and triggers alerts.
import crypto from 'node:crypto';
import { parseDate, parseSender } from './parse.js';
import { CATEGORIES, LOW_ONLY, REVIEW_FLAGS, SLA_HOURS, STATUSES, TEAM_IDS, URGENCIES, maxUrgency, urgencyRank, teamName } from './taxonomy.js';
import { daysUntil } from './analyzer/deadline.js';
import { redactSecrets } from './redact.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
// A new message joins the customer's open conversation if it arrives within this window.
const GROUP_WINDOW = 30 * DAY;
// Same problem, same provider, from this many different customers within the window = incident.
const INCIDENT_MIN_CUSTOMERS = 3;
const INCIDENT_WINDOW = 3 * HOUR;
const INCIDENT_CATEGORIES = new Set(['payment_gateway', 'outage', 'deliverability', 'domain', 'bug', 'account_access']);
const INCIDENT_WORDING = {
  payment_gateway: 'payments failing',
  outage: 'pages down',
  deliverability: 'email delivery problems',
  domain: 'domain / SSL problems',
  bug: 'the same bug',
  account_access: 'login problems',
};

const iso = (ms) => new Date(ms).toISOString();
const URGENCY_ORDER = `CASE urgency WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END`;

export function slaInfo(conv, now) {
  if (conv.status === 'waiting_customer' || conv.status === 'resolved') return { state: 'met', dueAt: null, minutesLeft: null };
  const windowMs = SLA_HOURS[conv.urgency] * HOUR;
  const due = Date.parse(conv.sla_started_at) + windowMs;
  const left = due - now;
  const state = left < 0 ? 'overdue' : left < windowMs * 0.25 ? 'due_soon' : 'ok';
  return { state, dueAt: iso(due), minutesLeft: Math.round(left / 60000) };
}

const isNoise = (conv) => conv.flags.some((f) => f.type === 'spam' || f.type === 'test');
// "Needs review": a doubt a person should check, not yet marked as checked.
// Spam and test messages are left out: their details do not matter.
export const needsReview = (conv) => !conv.reviewed_at && !isNoise(conv) && conv.flags.some((f) => REVIEW_FLAGS.includes(f.type));

export function createTriage({ db, analyzer, notifier, clock, teams, broadcast = () => {} }) {
  const nowIso = () => iso(clock.now());
  const event = (conversationId, actor, type, data = {}) =>
    db.run('INSERT INTO events (conversation_id, at, actor, type, data) VALUES (?,?,?,?,?)', conversationId, nowIso(), actor, type, data);

  // ---------- ingestion ----------

  async function ingest(input) {
    const body = String(input.message ?? input.body ?? '').trim();
    if (!body) return { status: 'rejected', error: 'Message body is empty' };
    const now = clock.now();
    const date = parseDate(input.received_at, new Date(now));
    const receivedAt = date?.iso ?? iso(now);
    const dateNotes = date ? date.notes : [input.received_at ? `could not read "${input.received_at}", used arrival time` : 'no date given, used arrival time'];
    const sender = parseSender(input.from ?? '', input.email ?? '', input.name ?? '');
    const externalId = String(input.external_id ?? '').trim()
      || crypto.createHash('sha256').update([input.received_at, input.from, input.email, body].join('|')).digest('hex').slice(0, 20);
    if (db.get('SELECT id FROM messages WHERE external_id = ?', externalId)) return { status: 'duplicate', externalId };

    const analysis = await analyzer.analyze({ body, subject: input.subject, source: input.source }, { receivedAt, now });
    const flags = [...analysis.flags];
    if (sender.issue === 'missing') flags.push({ type: 'no_sender', label: 'No sender address: we cannot reply' });
    if (sender.issue === 'invalid') flags.push({ type: 'invalid_sender', label: `"${sender.rawAddress}" is not a valid email: we cannot reply` });
    // A missing time is not a guess; no date at all on a webhook means "now".
    const guesses = dateNotes.filter((n) => n !== 'no time given' && !n.startsWith('no date given'));
    if (guesses.length) flags.push({ type: 'date_guessed', label: `Date guessed (${guesses.join(', ')}): written "${input.received_at}"` });

    // Re-check after the async analysis: a concurrent request may have stored it.
    if (db.get('SELECT id FROM messages WHERE external_id = ?', externalId)) return { status: 'duplicate', externalId };
    const { conv, before, messageId } = db.transaction(() => {
      let conv = sender.email
        ? db.get(`SELECT * FROM conversations WHERE customer_key = ? AND status != 'resolved' AND last_received_at >= ?
                  ORDER BY last_received_at DESC LIMIT 1`, sender.email, iso(Date.parse(receivedAt) - GROUP_WINDOW))
        : null;
      const before = conv ? { urgency: conv.urgency, messageCount: conv.message_count } : null;
      if (!conv) {
        const { lastInsertRowid } = db.run(
          `INSERT INTO conversations (customer_key, customer_name, customer_email, team, category, urgency, language, summary, need,
             sla_started_at, first_received_at, last_received_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          sender.email, sender.name, sender.email, analysis.team, analysis.category, analysis.urgency, analysis.language,
          analysis.summary, analysis.need, receivedAt, receivedAt, receivedAt, nowIso(), nowIso(),
        );
        conv = { id: Number(lastInsertRowid) };
        event(conv.id, 'system', 'created', { team: analysis.team, urgency: analysis.urgency });
      } else if (conv.status === 'waiting_customer') {
        // The customer answered: the ball is back in our court, the SLA restarts.
        db.run(`UPDATE conversations SET status = 'in_progress', sla_started_at = ?, responded_at = NULL WHERE id = ?`, receivedAt, conv.id);
        event(conv.id, 'system', 'status_changed', { from: 'waiting_customer', to: 'in_progress', why: 'customer replied' });
      }
      const { lastInsertRowid } = db.run(
        `INSERT INTO messages (external_id, conversation_id, source, received_at, received_at_raw, date_notes, from_raw,
           customer_name, customer_email, sender_issue, subject, body, category, team, urgency, language, summary, need,
           reasons, flags, confidence, deadline_at, deadline_phrase, secondary_teams, incident_term, engine, engine_error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        externalId, conv.id, input.source || null, receivedAt, input.received_at ?? null, dateNotes, input.from ?? null,
        sender.name, sender.email, sender.issue, input.subject || null, body, analysis.category, analysis.team, analysis.urgency,
        analysis.language, redactSecrets(analysis.summary), analysis.need, analysis.reasons, flags, analysis.confidence,
        analysis.deadline?.at ?? null, analysis.deadline?.phrase ?? null, analysis.secondaryTeams, analysis.incidentTerm,
        analysis.engine, analysis.engineError ?? null, nowIso(),
      );
      event(conv.id, 'system', 'message_received', { messageId: Number(lastInsertRowid), source: input.source || null });
      // A new doubtful message sends a checked conversation back to review.
      if (before && flags.some((f) => REVIEW_FLAGS.includes(f.type))) {
        db.run('UPDATE conversations SET reviewed_at = NULL, reviewed_by = NULL WHERE id = ?', conv.id);
      }
      refreshConversation(conv.id);
      return { conv: getConversationRow(conv.id), before, messageId: Number(lastInsertRowid) };
    });

    const incident = detectIncident(messageId);
    await alertIfNeeded(conv.id, before, incident);
    broadcast('conversation', { id: conv.id });
    return { status: 'created', conversationId: conv.id, messageId, analysis: { ...analysis, flags } };
  }

  // Bulk import: oldest first, so conversations and incidents build up in
  // the order things really happened.
  async function importRecords(records) {
    const sorted = records
      .map((r, i) => ({ r, i, t: Date.parse(parseDate(r.received_at, new Date(clock.now()))?.iso ?? '') || Infinity }))
      .sort((a, b) => a.t - b.t || a.i - b.i);
    const summary = { created: 0, duplicate: 0, rejected: 0, errors: [] };
    for (const { r, i } of sorted) {
      const res = await ingest(r);
      summary[res.status] += 1;
      if (res.status === 'rejected') summary.errors.push({ row: i + 2, error: res.error });
    }
    return summary;
  }

  // ---------- conversation state ----------

  const getConversationRow = (id) => db.get('SELECT * FROM conversations WHERE id = ?', id);

  // Recomputes everything derived from the messages. Manual choices
  // (team/urgency changed by an agent) are kept.
  function refreshConversation(id) {
    const conv = getConversationRow(id);
    const msgs = db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_at, id', id);
    if (!msgs.length) return;
    const now = clock.now();
    // The most urgent message leads the conversation; on ties the first one,
    // which usually states the problem best ("domain not connecting").
    const lead = msgs.reduce((best, m) => (urgencyRank(m.urgency) > urgencyRank(best.urgency) ? m : best));
    const latest = msgs[msgs.length - 1];
    const reasons = [...lead.reasons];
    const flags = [];
    for (const m of msgs) for (const f of m.flags) if (!flags.some((x) => x.type === f.type)) flags.push(f);

    let urgency = maxUrgency(...msgs.map((m) => m.urgency));
    const unanswered = msgs.filter((m) => m.received_at >= conv.sla_started_at).length;
    if (unanswered >= 2) {
      flags.push({ type: 'repeat_contact', count: unanswered, label: `Customer wrote ${unanswered} times without an answer` });
      if (!LOW_ONLY.has(lead.category) && urgencyRank(urgency) < urgencyRank('high')) {
        urgency = 'high';
        reasons.push(`Customer wrote ${unanswered} times without an answer`);
      }
    }
    if (conv.incident_id && urgency !== 'critical') {
      urgency = 'critical';
      reasons.push(`Part of incident #${conv.incident_id} reported by several customers`);
    }
    if (conv.urgency_locked) urgency = conv.urgency;
    // "No rush" from an earlier message is stale once the conversation escalated.
    if (urgency !== 'low') flags.splice(0, flags.length, ...flags.filter((f) => f.type !== 'no_rush'));
    const team = conv.team_locked ? conv.team : lead.team;
    const secondary = [...new Set(msgs.flatMap((m) => [m.team, ...m.secondary_teams]))].filter((t) => t !== team);

    // Deadline: the nearest one still ahead, otherwise the most recent missed one.
    const deadlines = msgs.filter((m) => m.deadline_at).map((m) => ({ at: m.deadline_at, phrase: m.deadline_phrase }));
    const upcoming = deadlines.filter((d) => daysUntil(d.at, now) >= 0).sort((a, b) => a.at.localeCompare(b.at));
    const deadline = upcoming[0] ?? deadlines.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;

    const named = [...msgs].reverse().find((m) => m.customer_name);
    const senderLabel = named?.customer_name || latest.customer_email
      || (latest.from_raw ? `${latest.from_raw} (invalid address)` : 'Unknown sender (no address)');
    db.run(
      `UPDATE conversations SET team = ?, category = ?, urgency = ?, language = ?, summary = ?, need = ?, secondary_teams = ?,
         flags = ?, reasons = ?, confidence = ?, engine = ?, deadline_at = ?, deadline_phrase = ?, first_received_at = ?,
         last_received_at = ?, message_count = ?, customer_name = COALESCE(?, customer_name), sender_label = ?, updated_at = ? WHERE id = ?`,
      team, conv.team_locked ? conv.category : lead.category, urgency, latest.language, lead.summary, lead.need, secondary,
      flags, reasons, lead.confidence, lead.engine, deadline?.at ?? null, deadline?.phrase ?? null, msgs[0].received_at,
      latest.received_at, msgs.length, named?.customer_name ?? null, senderLabel, nowIso(), id,
    );
  }

  // ---------- incidents ----------

  function detectIncident(messageId) {
    const m = db.get('SELECT * FROM messages WHERE id = ?', messageId);
    if (!INCIDENT_CATEGORIES.has(m.category) || !m.incident_term) return null;
    const key = `${m.category}:${m.incident_term}`;
    const t = Date.parse(m.received_at);
    const open = db.get(`SELECT * FROM incidents WHERE key = ? AND status = 'open' AND last_at >= ? ORDER BY id DESC LIMIT 1`,
      key, iso(t - INCIDENT_WINDOW));
    if (open) {
      attachToIncident(open.id, m.conversation_id);
      db.run('UPDATE incidents SET last_at = MAX(last_at, ?) WHERE id = ?', m.received_at, open.id);
      return { incident: db.get('SELECT * FROM incidents WHERE id = ?', open.id), created: false };
    }
    // Reports of the same problem around this message. A sender without a
    // valid email counts once per raw address (or per conversation if empty).
    const reports = db.all(
      `SELECT conversation_id, received_at, COALESCE(customer_email, NULLIF(from_raw, ''), 'conv:' || conversation_id) AS who
       FROM messages WHERE category = ? AND incident_term = ? AND received_at BETWEEN ? AND ? ORDER BY received_at`,
      m.category, m.incident_term, iso(t - INCIDENT_WINDOW), iso(t + INCIDENT_WINDOW),
    );
    // The 3-hour window containing this message with the most distinct customers.
    let best = [];
    const customersIn = (list) => new Set(list.map((r) => r.who)).size;
    for (const start of reports) {
      const s0 = Date.parse(start.received_at);
      if (s0 > t || s0 < t - INCIDENT_WINDOW) continue;
      const inWindow = reports.filter((r) => { const x = Date.parse(r.received_at); return x >= s0 && x <= s0 + INCIDENT_WINDOW; });
      if (customersIn(inWindow) > customersIn(best)) best = inWindow;
    }
    const customers = customersIn(best);
    if (customers < INCIDENT_MIN_CUSTOMERS) return null;
    const conversationIds = [...new Set(best.map((r) => r.conversation_id))];
    const firstAt = best[0].received_at;
    const lastAt = best.at(-1).received_at;
    const minutes = Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 60000);
    const term = m.incident_term.charAt(0).toUpperCase() + m.incident_term.slice(1);
    const title = `Possible incident: ${term} ${INCIDENT_WORDING[m.category]} (${customers} customers in ${minutes} min)`;
    const { lastInsertRowid } = db.run(
      'INSERT INTO incidents (key, category, term, team, title, first_at, last_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
      key, m.category, m.incident_term, CATEGORIES[m.category].team, title, firstAt, lastAt, nowIso(),
    );
    const incidentId = Number(lastInsertRowid);
    for (const id of conversationIds) attachToIncident(incidentId, id);
    return { incident: db.get('SELECT * FROM incidents WHERE id = ?', incidentId), created: true, conversationIds };
  }

  function attachToIncident(incidentId, conversationId) {
    const conv = getConversationRow(conversationId);
    if (conv.incident_id === incidentId) return;
    db.run('UPDATE conversations SET incident_id = ? WHERE id = ?', incidentId, conversationId);
    event(conversationId, 'system', 'incident_linked', { incidentId });
    refreshConversation(conversationId);
  }

  // ---------- alerts ----------

  async function alertIfNeeded(conversationId, before, incidentResult) {
    const conv = getConversationRow(conversationId);
    const markNotified = (id) => db.run('UPDATE conversations SET notified_critical_at = COALESCE(notified_critical_at, ?) WHERE id = ?', nowIso(), id);
    if (incidentResult?.created) {
      const { incident, conversationIds } = incidentResult;
      await notifier.notify({
        kind: 'incident', team: incident.team, incidentId: incident.id, conversationId,
        title: incident.title,
        body: `Several customers report the same problem. Conversations: ${conversationIds.map((id) => `#${id}`).join(', ')}. Fix it once and answer everyone with one shared message.`,
        extraRecipients: [teams.support?.lead].filter(Boolean),
      });
      conversationIds.forEach(markNotified);
      return;
    }
    if (conv.urgency !== 'critical') return;
    const label = conv.sender_label;
    if (!conv.notified_critical_at) {
      if (incidentResult) {
        // Already covered by an open incident: update in the app, no new Slack ping.
        await notifier.notify({
          kind: 'incident_update', team: conv.team, incidentId: incidentResult.incident.id, conversationId, slack: false,
          title: `Another customer hit by incident #${incidentResult.incident.id}`,
          body: `${label}: ${conv.summary}`,
        });
      } else {
        await notifier.notify({
          kind: 'critical', team: conv.team, conversationId,
          title: `CRITICAL · ${teamName(conv.team)} · ${CATEGORIES[conv.category].label}`,
          body: `${label}: ${conv.summary}\nWhy: ${conv.reasons.slice(0, 2).join('; ')}`,
        });
      }
      markNotified(conversationId);
    } else if (before && conv.message_count > before.messageCount && !conv.assignee) {
      await notifier.notify({
        kind: 'critical_followup', team: conv.team, conversationId,
        title: `Customer chased a CRITICAL conversation nobody owns yet (#${conversationId})`,
        body: `${label} wrote again: ${db.get('SELECT summary FROM messages WHERE conversation_id = ? ORDER BY received_at DESC, id DESC LIMIT 1', conversationId).summary}`,
      });
    }
  }

  // ---------- agent actions ----------

  async function updateConversation(id, changes, actor) {
    const conv = getConversationRow(id);
    if (!conv) return { error: 'Conversation not found', status: 404 };
    if (!actor) return { error: 'actor is required (who is making the change)', status: 400 };
    const sets = {};
    const pending = [];
    if ('team' in changes && changes.team !== conv.team) {
      if (!TEAM_IDS.includes(changes.team)) return { error: `Unknown team "${changes.team}"`, status: 400 };
      Object.assign(sets, { team: changes.team, team_locked: 1 });
      pending.push(['team_changed', { from: conv.team, to: changes.team, reason: changes.reason ?? null }]);
      if (conv.assignee && !teams[changes.team]?.members.includes(conv.assignee) && !('assignee' in changes)) {
        sets.assignee = null;
        pending.push(['unassigned', { from: conv.assignee, why: 'moved to another team' }]);
      }
    }
    if ('urgency' in changes && changes.urgency !== conv.urgency) {
      if (!URGENCIES.includes(changes.urgency)) return { error: `Unknown urgency "${changes.urgency}"`, status: 400 };
      Object.assign(sets, { urgency: changes.urgency, urgency_locked: 1 });
      pending.push(['urgency_changed', { from: conv.urgency, to: changes.urgency }]);
    }
    if ('assignee' in changes && (changes.assignee || null) !== conv.assignee) {
      const team = sets.team ?? conv.team;
      if (changes.assignee && !teams[team]?.members.includes(changes.assignee)) {
        return { error: `${changes.assignee} is not in the ${teamName(team)} team`, status: 400 };
      }
      sets.assignee = changes.assignee || null;
      pending.push([changes.assignee ? 'assigned' : 'unassigned', { from: conv.assignee, to: changes.assignee || null }]);
      if (changes.assignee && conv.status === 'new' && !('status' in changes)) changes = { ...changes, status: 'in_progress' };
    }
    if ('status' in changes && changes.status !== conv.status) {
      if (!STATUSES.includes(changes.status)) return { error: `Unknown status "${changes.status}"`, status: 400 };
      sets.status = changes.status;
      if (['waiting_customer', 'resolved'].includes(changes.status) && !conv.responded_at) sets.responded_at = nowIso();
      if (changes.status === 'resolved') sets.resolved_at = nowIso();
      if (conv.status === 'resolved') sets.resolved_at = null;
      if (conv.status === 'resolved' || conv.status === 'waiting_customer') {
        if (!['waiting_customer', 'resolved'].includes(changes.status)) Object.assign(sets, { responded_at: null, sla_started_at: nowIso() });
      }
      pending.push(['status_changed', { from: conv.status, to: changes.status }]);
    }
    if ('reviewed' in changes && Boolean(changes.reviewed) !== Boolean(conv.reviewed_at)) {
      Object.assign(sets, changes.reviewed ? { reviewed_at: nowIso(), reviewed_by: actor } : { reviewed_at: null, reviewed_by: null });
      pending.push([changes.reviewed ? 'reviewed' : 'review_reopened', {}]);
    }
    if (!pending.length) return { conversation: getConversation(id) };
    db.transaction(() => {
      const cols = Object.keys(sets);
      db.run(`UPDATE conversations SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => sets[c]), nowIso(), id);
      for (const [type, data] of pending) event(id, actor, type, data);
      if (sets.team) refreshConversation(id);
    });
    const after = getConversationRow(id);
    if (after.urgency === 'critical' && !after.notified_critical_at && after.status !== 'resolved') {
      await alertIfNeeded(id, null, null);
    } else if (sets.team && after.urgency === 'critical' && after.status !== 'resolved') {
      // The new team must know it now owns a critical conversation.
      await notifier.notify({
        kind: 'critical', team: after.team, conversationId: id,
        title: `CRITICAL conversation moved to ${teamName(after.team)} by ${actor}`,
        body: `${after.sender_label}: ${after.summary}`,
      });
    }
    broadcast('conversation', { id });
    return { conversation: getConversation(id) };
  }

  function addNote(id, text, actor) {
    if (!getConversationRow(id)) return { error: 'Conversation not found', status: 404 };
    if (!actor || !String(text ?? '').trim()) return { error: 'actor and text are required', status: 400 };
    event(id, actor, 'note', { text: String(text).trim().slice(0, 4000) });
    broadcast('conversation', { id });
    return { conversation: getConversation(id) };
  }

  // Demo reset: removes every conversation, message, alert, incident and
  // history entry. Settings (AI engine) are kept.
  function clearAll() {
    db.transaction(() => {
      for (const table of ['notifications', 'events', 'messages', 'conversations', 'incidents']) db.run(`DELETE FROM ${table}`);
    });
  }

  // ---------- reads ----------

  function decorate(conv, now = clock.now()) {
    return {
      ...conv,
      sla: slaInfo(conv, now),
      deadline_days_left: conv.deadline_at ? daysUntil(conv.deadline_at, now) : null,
      needs_review: needsReview(conv),
    };
  }

  function listConversations(filters = {}) {
    const where = [];
    const params = [];
    if (filters.team) { where.push(`(team = ? OR secondary_teams LIKE ?)`); params.push(filters.team, `%"${filters.team}"%`); }
    if (filters.status === 'open' || !filters.status) where.push(`status != 'resolved'`);
    else if (filters.status !== 'all') { where.push('status = ?'); params.push(filters.status); }
    if (filters.urgency) { where.push('urgency = ?'); params.push(filters.urgency); }
    if (filters.assignee === '__none') where.push('assignee IS NULL');
    else if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
    if (filters.language) { where.push('language = ?'); params.push(filters.language); }
    if (filters.incident) { where.push('incident_id = ?'); params.push(Number(filters.incident)); }
    if (filters.q) {
      const like = `%${filters.q}%`;
      where.push(`(customer_name LIKE ? OR customer_email LIKE ? OR summary LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.body LIKE ?))`);
      params.push(like, like, like, like);
    }
    const rows = db.all(
      `SELECT * FROM conversations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${URGENCY_ORDER} DESC, deadline_at IS NULL, deadline_at, sla_started_at`,
      ...params,
    );
    const now = clock.now();
    let list = rows.map((r) => decorate(r, now));
    if (filters.sla === 'overdue') list = list.filter((c) => c.sla.state === 'overdue');
    if (filters.review) list = list.filter((c) => c.needs_review);
    return list;
  }

  function getConversation(id) {
    const conv = getConversationRow(id);
    if (!conv) return null;
    return {
      ...decorate(conv),
      messages: db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_at, id', id),
      events: db.all('SELECT * FROM events WHERE conversation_id = ? ORDER BY id', id),
      incident: conv.incident_id ? db.get('SELECT * FROM incidents WHERE id = ?', conv.incident_id) : null,
    };
  }

  function stats() {
    const now = clock.now();
    const open = db.all(`SELECT * FROM conversations WHERE status != 'resolved'`).map((c) => decorate(c, now));
    const real = open.filter((c) => !isNoise(c));
    const byTeam = Object.fromEntries(TEAM_IDS.map((t) => {
      // Includes conversations shared with the team (second topic), like the team view.
      const mine = real.filter((c) => c.team === t || c.secondary_teams.includes(t));
      return [t, {
        open: mine.length,
        critical: mine.filter((c) => c.urgency === 'critical').length,
        overdue: mine.filter((c) => c.sla.state === 'overdue').length,
        unassigned: mine.filter((c) => !c.assignee).length,
      }];
    }));
    const total = db.get('SELECT COUNT(*) AS n FROM conversations').n;
    const rerouted = db.get(`SELECT COUNT(DISTINCT conversation_id) AS n FROM events WHERE type = 'team_changed'`).n;
    const byAssignee = {};
    for (const c of real) if (c.assignee) byAssignee[c.assignee] = (byAssignee[c.assignee] ?? 0) + 1;
    const languages = {};
    for (const c of real) languages[c.language] = (languages[c.language] ?? 0) + 1;
    return {
      now: iso(now),
      open: real.length,
      critical: real.filter((c) => c.urgency === 'critical').length,
      overdue: real.filter((c) => c.sla.state === 'overdue').length,
      unassigned: real.filter((c) => !c.assignee).length,
      repeatCustomers: real.filter((c) => c.flags.some((f) => f.type === 'repeat_contact')).length,
      deadlinesThisWeek: real.filter((c) => c.deadline_days_left !== null && c.deadline_days_left >= 0 && c.deadline_days_left <= 7).length,
      needsReview: real.filter((c) => c.needs_review).length,
      noise: open.length - real.length,
      byTeam,
      byAssignee,
      languages,
      routing: { total, rerouted, keptRate: total ? Number(((total - rerouted) / total).toFixed(2)) : null },
      incidents: db.all(`SELECT i.*, (SELECT COUNT(*) FROM conversations c WHERE c.incident_id = i.id) AS conversations,
          (SELECT COUNT(*) FROM conversations c WHERE c.incident_id = i.id AND c.status != 'resolved') AS open_conversations
        FROM incidents i WHERE i.status = 'open' ORDER BY i.last_at DESC`),
    };
  }

  const listNotifications = (limit = 50) => db.all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', limit);

  return { ingest, importRecords, updateConversation, addNote, clearAll, listConversations, getConversation, stats, listNotifications };
}
