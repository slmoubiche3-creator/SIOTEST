// Inbox Triage UI. Plain JS, no build step. All customer text is inserted
// with textContent (never innerHTML): messages are untrusted input.
import { createTour } from './tour.js';

const $ = (sel) => document.querySelector(sel);
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// replaceChildren() would print "null" for skipped optional parts.
const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));

const storage = {
  get(key) { try { return localStorage.getItem(`triage.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`triage.${key}`, value); } catch { /* private mode */ } },
};

const state = {
  meta: null, offset: 0, stats: null, list: [], base: [], notifications: [],
  seenAlerts: Number(storage.get('seenAlerts') || 0), me: storage.get('me') || '',
  drawerSig: null, drafts: new Map(), // unsent notes survive live refreshes
};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- formatting ----------

const nowMs = () => Date.now() + state.offset;
const URGENCY = {
  critical: { icon: '🔴', label: 'Critical' },
  high: { icon: '🟠', label: 'High' },
  normal: { icon: '⚪', label: 'Normal' },
  low: { icon: '·', label: 'Low' },
};
const STATUS_LABEL = { new: 'New', in_progress: 'In progress', waiting_customer: 'Waiting for customer', resolved: 'Resolved' };
const langNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
const langName = (code) => (code ? (langNames?.of(code) ?? code) : 'Unknown');
const teamName = (id) => state.meta?.teams.find((t) => t.id === id)?.name ?? id;

function fmtDuration(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  const d = Math.floor(hrs / 24);
  return `${d}d ${hrs % 24 ? `${hrs % 24}h` : ''}`.trim();
}
const fmtAgo = (isoStr) => (nowMs() - Date.parse(isoStr) < 60000 ? 'just now' : `${fmtDuration(nowMs() - Date.parse(isoStr))} ago`);
const fmtDate = (isoStr, withTime = true) => new Date(isoStr).toLocaleString('en-GB', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', ...(withTime && { hour: '2-digit', minute: '2-digit' }),
});

function urgencyBadge(u) {
  return h('span', { class: `badge ${u}`, title: `Urgency: ${URGENCY[u].label}` }, URGENCY[u].icon, URGENCY[u].label);
}
function slaView(c) {
  const sla = c.sla;
  if (sla.state === 'met') return h('span', { class: 'sla met' }, c.status === 'resolved' ? 'Resolved' : 'Answered');
  const left = Date.parse(sla.dueAt) - nowMs();
  const state_ = left < 0 ? 'overdue' : sla.state;
  const target = state.meta?.sla?.[c.urgency];
  return h('span', { class: `sla ${state_}`, title: `Reply target for ${c.urgency}: ${target}h` },
    left < 0 ? `Overdue ${fmtDuration(left)}` : `Reply in ${fmtDuration(left)}`);
}
function deadlineChip(c) {
  if (c.deadline_days_left === null || c.deadline_days_left === undefined) return null;
  const d = c.deadline_days_left;
  const text = d < 0 ? `Deadline missed (${-d}d ago)` : d === 0 ? 'Deadline today' : `Deadline in ${d}d`;
  return h('span', { class: `chip ${d <= 3 ? 'bad' : 'warn'}`, title: `Customer deadline: "${c.deadline_phrase}" (${fmtDate(c.deadline_at, false)})` }, '⏳ ', text);
}
const FLAG_CHIPS = {
  repeat_contact: (f) => ['bad', `↻ ${f.label.match(/\d+/)?.[0] ?? ''}× no answer`],
  prompt_injection: () => ['bad', '🛡 Tried to steer the AI'],
  credential_request: () => ['bad', '🛡 Asks for credentials'],
  no_sender: () => ['warn', '✉ No sender'],
  invalid_sender: () => ['warn', '✉ Invalid email'],
  self_declared_urgency: () => ['info', '"Urgent" claimed, no impact'],
  spam: () => ['info', 'Spam'],
  test: () => ['info', 'Test'],
  low_confidence: () => ['warn', '? Check routing'],
  engines_disagree: () => ['warn', '? AI and rules disagree'],
};
function flagChips(c) {
  return c.flags.filter((f) => FLAG_CHIPS[f.type]).map((f) => {
    const [kind, text] = FLAG_CHIPS[f.type](f);
    return h('span', { class: `chip ${kind}`, title: f.label }, text);
  });
}

// ---------- routing (hash) ----------

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const r = { view: 'all', team: null, incident: null, conv: null };
  let i = 0;
  if (parts[i] === 'team') { r.view = 'team'; r.team = parts[i + 1]; i += 2; }
  else if (parts[i] === 'mine') { r.view = 'mine'; i += 1; }
  else if (parts[i] === 'incident') { r.view = 'incident'; r.incident = parts[i + 1]; i += 2; }
  else if (parts[i] === 'all') i += 1;
  if (parts[i] === 'c') r.conv = Number(parts[i + 1]);
  return r;
}
function viewHash(r = parseHash()) {
  if (r.view === 'team') return `#/team/${r.team}`;
  if (r.view === 'mine') return '#/mine';
  if (r.view === 'incident') return `#/incident/${r.incident}`;
  return '#/all';
}
const openConversation = (id) => { location.hash = `${viewHash()}/c/${id}`; };

// ---------- data loading ----------

function viewParams(r = parseHash()) {
  const p = new URLSearchParams();
  if (r.view === 'team') p.set('team', r.team);
  if (r.view === 'mine') p.set('assignee', state.me || '__nobody__');
  if (r.view === 'incident') { p.set('incident', r.incident); p.set('status', 'all'); }
  return p;
}

async function refresh() {
  const r = parseHash();
  const base = viewParams(r);
  const filtered = new URLSearchParams(base);
  const q = $('#q').value.trim();
  if (q) filtered.set('q', q);
  if (r.view !== 'incident') filtered.set('status', $('#statusFilter').value);
  for (const [id, key] of [['#urgencyFilter', 'urgency'], ['#slaFilter', 'sla'], ['#assigneeFilter', 'assignee']]) {
    if ($(id).value && !(key === 'assignee' && r.view === 'mine')) filtered.set(key, $(id).value);
  }
  try {
    const [stats, list, baseList, notifications] = await Promise.all([
      api('/api/stats'), api(`/api/conversations?${filtered}`), api(`/api/conversations?${base}`), api('/api/notifications'),
    ]);
    Object.assign(state, { stats, list, base: baseList, notifications });
    render();
  } catch (err) {
    toast('Could not load data', err.message);
  }
}

let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); };

// ---------- rendering ----------

function render() {
  const r = parseHash();
  renderNav(r);
  renderTiles();
  renderList(r);
  renderAlertsCount();
  if (r.conv) renderDrawer(r.conv); else closeDrawer(false);
}

function renderNav(r) {
  const s = state.stats;
  const countEl = (open, crit) => h('span', { class: 'count' }, crit ? h('span', { class: 'crit', title: `${crit} critical` }, `🔴 ${crit}`) : null, String(open));
  $('#count-all').replaceChildren(countEl(s.open, s.critical));
  $('#count-mine').replaceChildren(state.me ? String(s.byAssignee[state.me] ?? 0) : '');
  $('#teamNav').replaceChildren(...state.meta.teams.map((t) => h('button', {
    class: 'nav-item', 'aria-current': String(r.view === 'team' && r.team === t.id), onclick: () => { location.hash = `#/team/${t.id}`; closeMenu(); },
  }, t.name, countEl(s.byTeam[t.id].open, s.byTeam[t.id].critical))));
  for (const btn of document.querySelectorAll('[data-view]')) btn.setAttribute('aria-current', String(btn.dataset.view === r.view));
  $('#incidentNav').replaceChildren(...(s.incidents.length
    ? s.incidents.map((i) => h('button', { class: 'nav-item', 'aria-current': String(r.view === 'incident' && r.incident === String(i.id)), onclick: () => { location.hash = `#/incident/${i.id}`; closeMenu(); } },
      h('span', {}, '⚡ ', i.title)))
    : [h('p', { class: 'muted small' }, 'None right now')]));
  const titles = { all: 'All teams', mine: state.me ? `My queue (${state.me})` : 'My queue: choose who you are (top right)' };
  const incident = s.incidents.find((i) => String(i.id) === r.incident);
  $('#viewTitle').textContent = r.view === 'team' ? `${teamName(r.team)} team`
    : r.view === 'incident' ? (incident ? `⚡ ${incident.title}` : `Incident #${r.incident}`) : titles[r.view];
}

function renderTiles() {
  const real = state.base.filter((c) => c.status !== 'resolved' && !c.flags.some((f) => f.type === 'spam' || f.type === 'test'));
  const n = (fn) => real.filter(fn).length;
  const critical = n((c) => c.urgency === 'critical');
  const overdue = n((c) => c.sla.state !== 'met' && Date.parse(c.sla.dueAt) < nowMs());
  const tiles = [
    { label: 'Open conversations', value: real.length, hint: `${state.base.length - real.length - state.base.filter((c) => c.status === 'resolved').length} spam/test hidden`, apply: () => resetFilters() },
    { label: 'Critical', value: critical, alarm: critical > 0, hint: 'reply target 1h', apply: () => setFilter('#urgencyFilter', 'critical') },
    { label: 'Past reply target', value: overdue, alarm: overdue > 0, hint: 'SLA overdue', apply: () => setFilter('#slaFilter', 'overdue') },
    { label: 'Unassigned', value: n((c) => !c.assignee), hint: 'nobody owns them', apply: () => setFilter('#assigneeFilter', '__none') },
    { label: 'Customers who wrote again', value: n((c) => c.flags.some((f) => f.type === 'repeat_contact')), hint: 'grouped, not duplicated' },
    { label: 'Deadlines soon or missed', value: n((c) => c.deadline_days_left !== null && c.deadline_days_left <= 7), hint: 'launch, renewal… within 7 days' },
  ];
  const routing = state.stats.routing;
  if (routing.total) tiles.push({ label: 'Auto-routing kept', value: `${Math.round(routing.keptRate * 100)}%`, hint: `${routing.rerouted} moved by agents` });
  $('#tiles').replaceChildren(...tiles.map((t) => h('button', { class: `tile${t.alarm ? ' alarm' : ''}`, onclick: t.apply ?? null, title: t.apply ? 'Click to filter' : null },
    h('div', { class: 'label' }, t.label), h('div', { class: 'value' }, String(t.value)), h('div', { class: 'hint' }, t.hint))));
}

function renderList(r) {
  const list = state.list;
  if (!list.length) {
    $('#list').replaceChildren(h('div', { class: 'empty' }, r.view === 'mine' && !state.me ? 'Choose who you are (top right) to see your queue.' : 'Nothing here. 🎉'));
    return;
  }
  $('#list').replaceChildren(...list.map((c) => {
    const secondary = c.secondary_teams.length ? h('div', { class: 'sub', title: 'Also concerns these teams' }, `+ ${c.secondary_teams.map(teamName).join(', ')}`) : null;
    return h('button', { class: `row${r.conv === c.id ? ' selected' : ''}`, onclick: () => openConversation(c.id), 'data-id': c.id },
      h('div', {}, urgencyBadge(c.urgency)),
      h('div', {},
        h('div', { class: 'cust', title: c.sender_label }, c.sender_label),
        h('div', { class: 'sub' }, `${c.message_count > 1 ? `${c.message_count} messages · ` : ''}${langName(c.language)} · ${fmtAgo(c.last_received_at)}`)),
      h('div', { class: 'summary' },
        h('div', { class: 'summary-text' }, c.summary),
        h('div', { class: 'chips' },
          c.incident_id ? h('span', { class: 'chip bad' }, `⚡ Incident #${c.incident_id}`) : null,
          deadlineChip(c), flagChips(c))),
      h('div', {}, h('div', {}, teamName(c.team)), secondary),
      h('div', {}, slaView(c)),
      h('div', {}, h('div', { class: c.assignee ? '' : 'muted' }, c.assignee ?? 'Unassigned'), h('div', { class: 'sub' }, STATUS_LABEL[c.status])));
  }));
}

function renderAlertsCount() {
  const unseen = state.notifications.filter((n) => n.id > state.seenAlerts).length;
  $('#alertsCount').textContent = String(unseen);
  $('#alertsBtn').classList.toggle('primary', unseen > 0);
}

// ---------- conversation drawer ----------

let drawerToken = 0;
async function renderDrawer(id) {
  const token = ++drawerToken;
  let c;
  try { c = await api(`/api/conversations/${id}`); } catch (err) { toast('Conversation not found', err.message); return; }
  if (token !== drawerToken) return;
  const drawer = $('#drawer');
  // Live refreshes only rebuild the panel when something really changed.
  const sig = `${c.id}|${c.updated_at}|${c.events.length}|${c.messages.length}|${state.me}`;
  if (!drawer.hidden && sig === state.drawerSig) return;
  state.drawerSig = sig;
  const typing = document.activeElement?.name === 'note';
  const scrollTop = drawer.hidden ? 0 : drawer.scrollTop;
  const canEdit = Boolean(state.me);
  const team = state.meta.teams.find((t) => t.id === c.team);
  const change = async (changes) => {
    try {
      await api(`/api/conversations/${c.id}`, { method: 'PATCH', body: JSON.stringify({ actor: state.me, ...changes }) });
      await refresh();
    } catch (err) {
      toast('Change refused', err.message);
      state.drawerSig = null; // show the real value again, not the refused one
      renderDrawer(c.id);
    }
  };
  const select = (label, value, options, onchange) => h('label', {}, label,
    h('select', { disabled: !canEdit, onchange: (e) => onchange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: v === (value ?? '') }, text))));

  const dangerFlags = c.flags.filter((f) => ['credential_request', 'prompt_injection'].includes(f.type));
  const warnFlags = c.flags.filter((f) => ['no_sender', 'invalid_sender', 'deadline_passed', 'low_confidence', 'engines_disagree', 'self_declared_urgency', 'repeat_contact'].includes(f.type));
  const engineErrors = [...new Set(c.messages.map((m) => m.engine_error).filter(Boolean))];

  fill(drawer,
    h('div', { class: 'drawer-head' },
      h('div', {},
        h('h2', {}, c.sender_label),
        h('div', { class: 'muted small' }, [c.customer_email, langName(c.language), `${c.message_count} message${c.message_count > 1 ? 's' : ''}`, `first contact ${fmtAgo(c.first_received_at)}`, `#${c.id}`].filter(Boolean).join(' · '))),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => { location.hash = viewHash(); } }, '✕')),
    h('div', { class: 'section chips', 'data-tour': 'head' }, urgencyBadge(c.urgency), slaView(c), h('span', { class: 'chip' }, STATUS_LABEL[c.status]), h('span', { class: 'chip' }, teamName(c.team)),
      c.incident ? h('a', { class: 'chip bad', href: `#/incident/${c.incident.id}` }, `⚡ Incident #${c.incident.id}`) : null, deadlineChip(c)),

    dangerFlags.length ? h('div', { class: 'section callout bad' }, h('strong', {}, '🛡 Security warning'), h('ul', {}, dangerFlags.map((f) => h('li', {}, f.label)))) : null,
    warnFlags.length ? h('div', { class: 'section callout warn' }, h('strong', {}, 'Heads-up'), h('ul', {}, warnFlags.map((f) => h('li', {}, f.label)))) : null,

    h('div', { class: 'section', 'data-tour': 'actions' }, h('h3', {}, 'Actions'),
      canEdit ? null : h('p', { class: 'callout warn' }, 'Choose who you are (top right) to assign or change status.'),
      h('div', { class: 'actions' },
        select('Assigned to', c.assignee, [['', 'Unassigned'], ...team.members.map((m) => [m, m])], (v) => change({ assignee: v || null })),
        select('Status', c.status, Object.entries(STATUS_LABEL), (v) => change({ status: v })),
        select('Team', c.team, state.meta.teams.map((t) => [t.id, t.name]), (v) => {
          const reason = prompt(`Why move this to ${teamName(v)}? (helps improve auto-routing)`);
          if (reason === null) { state.drawerSig = null; renderDrawer(c.id); return; } // cancelled
          change({ team: v, reason });
        }),
        select('Urgency', c.urgency, ['critical', 'high', 'normal', 'low'].map((u) => [u, URGENCY[u].label]), (v) => change({ urgency: v }))),
      h('div', { class: 'chips', style: 'margin-top:8px' },
        team.members.includes(state.me) && c.assignee !== state.me ? h('button', { class: 'btn primary', onclick: () => change({ assignee: state.me }) }, 'Assign to me') : null,
        c.status !== 'waiting_customer' && c.status !== 'resolved' ? h('button', { class: 'btn', disabled: !canEdit, onclick: () => change({ status: 'waiting_customer' }) }, 'Replied: wait for customer') : null,
        c.status !== 'resolved' ? h('button', { class: 'btn', disabled: !canEdit, onclick: () => change({ status: 'resolved' }) }, 'Resolve') : null)),

    h('div', { class: 'section', 'data-tour': 'why' }, h('h3', {}, 'Why this triage'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Topic'), h('dd', {}, state.meta.categories[c.category]?.label ?? c.category),
        h('dt', {}, 'Customer needs'), h('dd', {}, c.need),
        h('dt', {}, 'Team'), h('dd', {}, teamName(c.team), c.secondary_teams.length ? ` (also: ${c.secondary_teams.map(teamName).join(', ')})` : ''),
        c.deadline_at ? [h('dt', {}, 'Deadline'), h('dd', {}, `"${c.deadline_phrase}" → ${fmtDate(c.deadline_at, false)}`)] : null,
        h('dt', {}, 'Reasons'), h('dd', {}, h('ul', { style: 'margin:0;padding-left:18px' }, c.reasons.map((x) => h('li', {}, x)))),
        h('dt', {}, 'Confidence'), h('dd', {}, `${Math.round((c.confidence ?? 0) * 100)}% · engine: ${c.engine}`),
        engineErrors.length ? [h('dt', {}, 'AI errors'), h('dd', {}, engineErrors.join('; '))] : null)),

    c.incident ? h('div', { class: 'section callout bad' },
      h('strong', {}, `⚡ ${c.incident.title}`),
      h('p', { style: 'margin:4px 0' }, 'Same problem reported by several customers. Fix it once and answer everyone with one shared message.'),
      h('a', { href: `#/incident/${c.incident.id}` }, 'See all conversations in this incident')) : null,

    h('div', { class: 'section', 'data-tour': 'messages' }, h('h3', {}, `Messages (${c.messages.length})`),
      c.messages.map((m) => h('div', { class: 'msg' },
        h('div', { class: 'msg-head' },
          h('span', {}, fmtDate(m.received_at, !m.date_notes.includes('no time given'))),
          m.source ? h('span', { class: 'chip' }, m.source) : null,
          h('span', { class: 'chip' }, langName(m.language)),
          urgencyBadge(m.urgency),
          m.date_notes.filter((n) => n !== 'no time given').map((n) => h('span', { class: 'chip warn', title: `Raw date: ${m.received_at_raw}` }, `date: ${n}`))),
        h('div', { class: 'msg-body' }, m.body),
        m.engine === 'ai' ? h('div', { class: 'muted small', style: 'margin-top:6px' }, `AI summary: ${m.summary}`) : null))),

    h('div', { class: 'section', 'data-tour': 'history' }, h('h3', {}, 'History & notes'),
      h('ul', { class: 'timeline' }, c.events.map((e) => h('li', {}, h('span', { class: 'muted' }, `${fmtDate(e.at)} · ${e.actor} · `), describeEvent(e)))),
      h('form', { class: 'note-form', onsubmit: async (e) => {
        e.preventDefault();
        const text = e.target.elements.note.value.trim();
        if (!text) return;
        try {
          await api(`/api/conversations/${c.id}/notes`, { method: 'POST', body: JSON.stringify({ actor: state.me, text }) });
          state.drafts.delete(c.id);
          await refresh();
        }
        catch (err) { toast('Note not saved', err.message); }
      } },
      h('textarea', { name: 'note', placeholder: canEdit ? 'Internal note (not sent to the customer)' : 'Choose who you are to add notes', disabled: !canEdit, 'aria-label': 'Internal note', oninput: (e) => state.drafts.set(c.id, e.target.value) }),
      h('button', { class: 'btn', disabled: !canEdit }, 'Add'))),
  );
  drawer.hidden = false;
  drawer.dataset.conv = String(c.id);
  $('#scrim').hidden = false;
  drawer.scrollTop = scrollTop;
  const note = drawer.querySelector('textarea[name=note]');
  note.value = state.drafts.get(c.id) ?? '';
  if (typing) { note.focus(); note.setSelectionRange(note.value.length, note.value.length); }
}

function describeEvent(e) {
  const d = e.data;
  switch (e.type) {
    case 'created': return `Conversation created → ${teamName(d.team)}, ${d.urgency}`;
    case 'message_received': return `New message${d.source ? ` (${d.source})` : ''}`;
    case 'status_changed': return `Status: ${STATUS_LABEL[d.from]} → ${STATUS_LABEL[d.to]}${d.why ? ` (${d.why})` : ''}`;
    case 'assigned': return `Assigned to ${d.to}`;
    case 'unassigned': return `Unassigned${d.why ? ` (${d.why})` : ''}`;
    case 'team_changed': return `Team: ${teamName(d.from)} → ${teamName(d.to)}${d.reason ? ` · "${d.reason}"` : ''}`;
    case 'urgency_changed': return `Urgency: ${d.from} → ${d.to}`;
    case 'incident_linked': return `Linked to incident #${d.incidentId}`;
    case 'note': return h('span', {}, '📝 ', d.text);
    default: return e.type;
  }
}

function closeDrawer(updateHash = true) {
  $('#drawer').hidden = true;
  delete $('#drawer').dataset.conv;
  state.drawerSig = null;
  syncScrim();
  if (updateHash && parseHash().conv) location.hash = viewHash();
}

// ---------- alerts ----------

function openAlerts() {
  const list = state.notifications;
  fill($('#alertsDrawer'),
    h('div', { class: 'drawer-head' }, h('h2', {}, 'Alerts sent'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeAlerts }, '✕')),
    h('p', { class: 'muted small' }, 'Critical conversations and incidents alert the team on-call and lead, here and in Slack when a webhook is set.'),
    'Notification' in window && Notification.permission === 'default'
      ? h('button', { class: 'btn', onclick: () => Notification.requestPermission().then(openAlerts) }, 'Enable desktop alerts') : null,
    list.length ? list.map((n) => h('div', { class: 'notif', onclick: () => { closeAlerts(); if (n.conversation_id) openConversation(n.conversation_id); else if (n.incident_id) location.hash = `#/incident/${n.incident_id}`; } },
      h('div', { class: 't' }, n.title),
      h('div', { class: 'muted small' }, `${fmtAgo(n.at)} · ${teamName(n.team)} → ${n.recipients.join(', ') || 'team'}`),
      h('div', { class: 'msg-body small', style: 'margin-top:4px' }, n.body),
      h('div', { class: 'chips', style: 'margin-top:6px' }, Object.entries(n.channels).map(([ch, st]) => h('span', { class: `chip${st === 'sent' ? '' : ' warn'}` }, `${ch === 'in_app' ? 'In app' : 'Slack'}: ${st}`)))))
      : h('p', { class: 'muted' }, 'No alerts yet.'),
  );
  $('#alertsDrawer').hidden = false;
  $('#scrim').hidden = false;
  state.seenAlerts = Math.max(state.seenAlerts, ...list.map((n) => n.id), 0);
  storage.set('seenAlerts', String(state.seenAlerts));
  renderAlertsCount();
}
function closeAlerts() {
  $('#alertsDrawer').hidden = true;
  syncScrim();
}

// ---------- settings (AI engine) ----------

const settings = { status: null, models: [], busy: false, tab: null };

function renderEngineChip() {
  $('#engineChip').textContent = `Analysis: ${state.meta.engine}${state.meta.slack ? ' · Slack on' : ''}`;
}

async function openSettings() {
  try { settings.status = await api('/api/settings'); } catch (err) { toast('Settings unavailable', err.message); return; }
  settings.models = [];
  settings.tab = settings.status.provider;
  renderSettings();
  $('#settingsDrawer').hidden = false;
  $('#scrim').hidden = false;
  if (settings.status.keySource && !settings.status.needsAdminToken) loadModels();
}
function closeSettings() {
  $('#settingsDrawer').hidden = true;
  syncScrim();
}
// The dark backdrop stays while any side panel is open.
function syncScrim() {
  $('#scrim').hidden = ['#drawer', '#alertsDrawer', '#settingsDrawer'].every((sel) => $(sel).hidden);
}

// Settings changes need the admin token when the server asks for one.
async function adminApi(path, opts = {}) {
  const token = $('#settingsDrawer [name=admin]')?.value ?? '';
  return api(path, { ...opts, headers: { ...(opts.headers ?? {}), ...(settings.status.needsAdminToken ? { 'x-admin-token': token } : {}) } });
}
async function settingsAction(fn, success) {
  settings.busy = true;
  renderSettings();
  try {
    await fn();
    if (success) toast(success);
    state.meta = await api('/api/meta');
    renderEngineChip();
  } catch (err) {
    toast('Not saved', err.message);
  } finally {
    settings.busy = false;
    renderSettings();
  }
}
const loadModels = () => settingsAction(async () => { settings.models = await adminApi('/api/settings/models'); });

function renderSettings() {
  const s = settings.status;
  const busy = settings.busy;
  const keyForm = h('form', { class: 'setting-form', onsubmit: (e) => {
    e.preventDefault();
    const input = e.target.elements.apiKey;
    const apiKey = input.value;
    input.value = ''; // never keep the key in the page
    settingsAction(async () => {
      const res = await adminApi('/api/settings/key', { method: 'POST', body: JSON.stringify({ apiKey }) });
      settings.status = res.status;
      settings.models = res.models;
    }, 'API key saved');
  } },
  h('input', { type: 'password', name: 'apiKey', autocomplete: 'off', spellcheck: 'false', placeholder: s.keySource === 'settings' ? 'Paste a new key to replace it' : 'Paste your Anthropic API key', 'aria-label': 'Anthropic API key', required: true, disabled: busy }),
  h('button', { class: 'btn primary', disabled: busy }, 'Save key'));

  const modelPart = !s.keySource ? h('p', { class: 'muted' }, 'Add an API key first.')
    : !settings.models.length ? h('div', { class: 'setting-form' },
      s.model ? h('span', {}, `Current model: ${s.model}`) : h('span', { class: 'muted' }, 'No model chosen yet.'),
      h('button', { class: 'btn', disabled: busy, onclick: loadModels }, 'Load available models'))
    : h('form', { class: 'setting-form', onsubmit: (e) => {
      e.preventDefault();
      const model = e.target.elements.model.value;
      settingsAction(async () => { settings.status = await adminApi('/api/settings/model', { method: 'POST', body: JSON.stringify({ model }) }); }, 'AI engine is on');
    } },
    h('select', { name: 'model', 'aria-label': 'Model', disabled: busy },
      settings.models.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.name === m.id ? m.id : `${m.name} (${m.id})`))),
    h('button', { class: 'btn primary', disabled: busy }, busy ? 'Testing…' : 'Use this model'));

  // n8n: the workflow calls any AI provider (OpenAI, Anthropic, Gemini...).
  const n8nPart = [
    h('p', { class: 'muted small' }, 'Your n8n workflow calls the AI provider of your choice (OpenAI, Anthropic, Gemini…) and answers in the format this tool expects. To change provider later, change the model node in n8n. Template to import: n8n/inbox-triage-ai-classifier.json.'),
    h('form', { class: 'setting-form', onsubmit: (e) => {
      e.preventDefault();
      const url = e.target.elements.n8nUrl.value;
      const secretInput = e.target.elements.n8nSecret;
      const secret = secretInput.value;
      secretInput.value = ''; // never keep the secret in the page
      settingsAction(async () => { settings.status = await adminApi('/api/settings/n8n', { method: 'POST', body: JSON.stringify({ url, secret }) }); }, 'n8n connected: AI engine is on');
    } },
    h('input', { type: 'url', name: 'n8nUrl', required: true, value: s.n8n.url ?? '', placeholder: 'https://your-n8n/webhook/inbox-triage-classify', 'aria-label': 'n8n webhook URL (production)', disabled: busy }),
    h('input', { type: 'password', name: 'n8nSecret', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'n8n secret', placeholder: s.n8n.secretSet ? 'Secret saved (hidden). Paste a new one to replace it' : `Secret of the ${s.n8n.header} credential`, disabled: busy }),
    h('button', { class: 'btn primary', disabled: busy }, busy ? 'Testing…' : 'Connect and test')),
    s.n8n.url ? h('button', { class: 'btn', style: 'margin-top:8px', disabled: busy, onclick: () => settingsAction(async () => {
      settings.status = await adminApi('/api/settings/n8n', { method: 'DELETE' });
    }, 'n8n disconnected') }, 'Disconnect n8n') : null,
    h('p', { class: 'muted small' }, `Use the production webhook URL of the published workflow. The secret is the value of its Header Auth credential (${s.n8n.header}); it stays on this server and is never shown again. Before switching, the tool sends one short test message.`),
  ];
  const tab = settings.tab ?? s.provider;
  const tabButton = (id, label) => h('button', { class: `btn${tab === id ? ' primary' : ''}`, 'aria-pressed': String(tab === id), onclick: () => { settings.tab = id; renderSettings(); } },
    label, s.enabled && s.provider === id ? ' ✓' : '');

  fill($('#settingsDrawer'),
    h('div', { class: 'drawer-head' }, h('h2', {}, 'Settings'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeSettings }, '✕')),
    h('div', { class: 'section' }, h('h3', {}, 'AI engine'),
      h('div', { class: `callout ${s.enabled ? '' : 'warn'}` }, h('strong', {}, s.enabled ? `On: ${s.engine}` : 'Off: rules only'),
        s.forcedRulesOnly ? h('div', { class: 'small' }, 'Turned off on the server (ANALYZER=rules).') : null,
        s.error ? h('div', { class: 'small' }, s.error) : null),
      h('p', { class: 'muted small' }, 'The rules always run. With an AI engine, every message is also read by an AI, in any language, with an English summary. Choose how the AI is reached:')),
    s.needsAdminToken ? h('div', { class: 'section' }, h('h3', {}, 'Admin token'),
      h('input', { type: 'password', name: 'admin', autocomplete: 'off', placeholder: 'Required to change settings', 'aria-label': 'Admin token' })) : null,
    h('div', { class: 'section chips', role: 'group', 'aria-label': 'AI provider' }, tabButton('anthropic', 'Anthropic API'), tabButton('n8n', 'n8n workflow (any AI)')),
    tab === 'n8n' ? h('div', { class: 'section' }, h('p', { class: 'step-title' }, 'n8n webhook'), n8nPart) : null,
    tab !== 'anthropic' ? null : h('div', { class: 'section' }, h('p', { class: 'step-title' }, '1 · API key'),
      s.keySource === 'environment' ? h('p', {}, 'Set on the server (ANTHROPIC_API_KEY). Change it there.')
        : [s.keySource === 'settings' ? h('p', {}, '✓ A key is saved. It is hidden and stored only on the server.') : null,
          keyForm,
          s.keySource === 'settings' ? h('button', { class: 'btn', style: 'margin-top:8px', disabled: busy, onclick: () => settingsAction(async () => {
            settings.status = await adminApi('/api/settings/key', { method: 'DELETE' });
            settings.models = [];
          }, 'API key removed') }, 'Remove the key') : null],
      h('p', { class: 'muted small' }, 'The key is never shown again, never sent back to the browser and never saved in Git.')),
    tab !== 'anthropic' ? null : h('div', { class: 'section' }, h('p', { class: 'step-title' }, '2 · Model'), modelPart,
      h('p', { class: 'muted small' }, 'One key works for every model; models differ in price and speed. The list comes from Anthropic for your key. Before switching, the tool sends one short test message to check that the model works.')),
  );
}

function toast(title, body, onclick) {
  const el = h('div', { class: 'toast', role: 'status', onclick: () => { el.remove(); onclick?.(); } }, h('strong', {}, title), body ? h('div', { class: 'small' }, body) : null);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 9000);
}

// ---------- filters & header ----------

function setFilter(sel, value) { $(sel).value = value; refresh(); }
function resetFilters() {
  $('#q').value = ''; $('#statusFilter').value = 'open';
  for (const sel of ['#urgencyFilter', '#slaFilter', '#assigneeFilter']) $(sel).value = '';
  refresh();
}
const closeMenu = () => $('#sidebar').classList.remove('open');

function renderHeader() {
  const m = state.meta;
  renderEngineChip();
  const tick = () => { $('#clock').textContent = `${fmtDate(new Date(nowMs()).toISOString())} UTC${m.simulatedClock ? ' · simulated "today"' : ''}`; };
  tick();
  setInterval(tick, 30000);
  fill($('#meSelect'), h('option', { value: '' }, 'Choose…'),
    m.teams.map((t) => h('optgroup', { label: t.name }, t.members.map((name) => h('option', { value: name, selected: name === state.me }, name)))));
  const everyone = [...new Set(m.teams.flatMap((t) => t.members))].sort();
  $('#assigneeFilter').append(...everyone.map((name) => h('option', { value: name }, name)));
}

// ---------- guided tour ----------

// The tour finds its own examples (an incident, a customer who wrote again, a
// suspicious message), so it works with any data, and skips what is missing.
const tourData = {};
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
const goHash = (hash) => { if (location.hash !== hash) location.hash = hash; };
const inView = (title) => () => $('#viewTitle').textContent.startsWith(title) && $('#drawer').hidden && $('#alertsDrawer').hidden;
const showConversation = (key) => ({
  skip: () => !tourData[key],
  before: () => { closeAlerts(); goHash(`#/all/c/${tourData[key].id}`); },
  ready: () => $('#drawer').dataset.conv === String(tourData[key]?.id),
});
const onList = (extra = {}) => ({ before: () => { closeAlerts(); goHash('#/all'); }, ready: inView('All teams'), ...extra });

function tourSteps() {
  const conv = (key) => tourData[key] ?? {};
  return [
    { title: 'Welcome to Inbox Triage', ...onList(),
      text: 'Every message from contact forms, email and live chat lands here already analysed: which team, how urgent, which language, and why. This tour takes about 2 minutes. "Today" is simulated as Monday 12 October 2026.' },
    { title: 'The day at a glance', target: '#tiles', ...onList(),
      text: 'Open conversations, critical ones, those past their reply target, unassigned work, customers who wrote again and deadlines coming up. Click a tile to filter the queue.' },
    { title: 'One queue, most urgent first', target: '#list .row', ...onList(),
      text: 'Sorted by urgency, then by the customer\'s deadline, then by waiting time. Each row shows the urgency, the customer, a summary, warning chips, the team, the reply timer and who owns it.' },
    { title: 'A queue per team', target: '#teamNav',
      ...onList({ before: () => { closeAlerts(); goHash('#/all'); if (isMobile()) $('#sidebar').classList.add('open'); } }),
      text: 'Support, Tech, Billing, Deliverability, Migration, Product and Security & Legal each see their own conversations. A message about two topics shows up in both teams. The red number counts critical items.' },
    { title: 'Tell the tool who you are', target: '#meSelect', ...onList({ before: () => { closeMenu(); closeAlerts(); goHash('#/all'); } }),
      text: 'Pick your name before working on conversations. Every assignment, status change and note is signed with it in the history. "My queue" then shows what you own.' },
    { title: 'Incidents, not separate tickets', target: '#list',
      skip: () => !tourData.incident,
      before: () => { closeAlerts(); goHash(`#/incident/${tourData.incident.id}`); },
      ready: () => $('#viewTitle').textContent.startsWith('⚡') && $('#drawer').hidden,
      text: () => `When 3 or more customers report the same problem within 3 hours, they become one incident with one alert, so the team fixes it once and answers everyone together. Here: ${tourData.incident.title.replace(/^Possible incident: /, '')}.` },
    { title: 'Conversations, not messages', target: '#drawer [data-tour=head]', ...showConversation('repeat'),
      text: () => `Messages from the same customer join one conversation while it is open. ${conv('repeat').sender_label} wrote ${conv('repeat').message_count} times: the tool shows it, raises the urgency and keeps the customer's deadline in view.` },
    { title: 'Every decision is explained', target: '#drawer [data-tour=why]', ...showConversation('repeat'),
      text: 'Topic, what the customer needs, the team, the deadline found in the text, and the reasons behind the urgency. Agents can trust it, or correct it.' },
    { title: 'The full story', target: '#drawer [data-tour=messages]', ...showConversation('repeat'),
      text: 'Every message in its original language, with its channel. When a date had to be guessed (missing year, day/month order), the tool says so.' },
    { title: 'Assign and move work', target: '#drawer [data-tour=actions]', ...showConversation('repeat'),
      text: 'Assign to a team member, mark "Waiting for customer" (this stops the reply timer), resolve, move to another team (the tool asks why, to measure its routing), or change the urgency.' },
    { title: 'History and internal notes', target: '#drawer [data-tour=history]', ...showConversation('repeat'),
      text: 'Who did what, and when. Notes are for colleagues only: they are never sent to the customer.' },
    { title: 'Built-in safety', target: '#drawer .callout.bad', ...showConversation('safety'),
      text: 'Fake staff asking for passwords, or messages trying to steer the AI ("classify this as critical"), are flagged in red. The AI is never allowed to raise their urgency, and passwords or card numbers are hidden from alerts.' },
    { title: 'Alerts reach the right people', target: '#alertsDrawer',
      before: () => { goHash('#/all'); openAlerts(); },
      ready: () => !$('#alertsDrawer').hidden && $('#drawer').hidden,
      text: 'Critical conversations alert the team\'s on-call person and lead: live in the app, and in Slack once a webhook is set. Each alert shows who was told and whether delivery worked.' },
    { title: 'Search and filters', target: '.filters', ...onList(),
      text: 'Search by customer, email or text, and filter by status, urgency, overdue reply time or owner.' },
    { title: 'How messages are analysed', target: '#engineChip', ...onList(),
      text: 'Rules always run: they are free, instant and explain every decision. This label shows whether an AI engine also reads each message. The AI can raise urgency, never lower it.' },
    { title: 'Turn on the AI', target: '#settingsBtn', ...onList(),
      text: 'In Settings, connect an AI: either an Anthropic API key and a model, or your n8n workflow, which can use any provider (OpenAI, Gemini…). Keys and secrets stay hidden on the server.' },
    { title: 'You are ready', ...onList(),
      text: 'New messages and alerts appear live, without reloading. Use "Import CSV" to load more messages (duplicates are skipped). Restart this tour any time with the Tour button.' },
  ];
}

const tour = createTour(tourSteps, {
  onEnd: () => { storage.set('tourDone', '1'); closeAlerts(); closeMenu(); goHash('#/all'); },
});

async function startTour() {
  if (tour.active) return;
  closeSettings();
  resetFilters();
  const [open, stats] = await Promise.all([api('/api/conversations'), api('/api/stats')]);
  const byLastFirst = [...open].sort((a, b) => b.message_count - a.message_count);
  Object.assign(tourData, {
    incident: stats.incidents[0] ?? null,
    repeat: byLastFirst.find((c) => c.flags.some((f) => f.type === 'repeat_contact') && c.deadline_at) ?? byLastFirst[0] ?? null,
    safety: open.find((c) => c.flags.some((f) => f.type === 'credential_request' || f.type === 'prompt_injection')) ?? null,
  });
  tour.start();
}

async function init() {
  state.meta = await api('/api/meta');
  state.offset = Date.parse(state.meta.now) - Date.now();
  renderHeader();
  $('#meSelect').addEventListener('change', (e) => { state.me = e.target.value; storage.set('me', state.me); refresh(); });
  for (const sel of ['#statusFilter', '#urgencyFilter', '#slaFilter', '#assigneeFilter']) $(sel).addEventListener('change', refresh);
  let searchTimer;
  $('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refresh, 250); });
  for (const btn of document.querySelectorAll('[data-view]')) btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.view}`; closeMenu(); });
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#alertsBtn').addEventListener('click', openAlerts);
  $('#tourBtn').addEventListener('click', startTour);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#scrim').addEventListener('click', () => { closeSettings(); closeAlerts(); closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closeAlerts(); closeDrawer(); } });
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await api('/api/import', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await file.text() });
      toast('Import finished', `${res.created} new, ${res.duplicate} already known, ${res.rejected} rejected`);
      refresh();
    } catch (err) { toast('Import failed', err.message); }
    e.target.value = '';
  });
  window.addEventListener('hashchange', refresh);

  // Live updates: new messages and alerts arrive without reloading.
  const events = new EventSource('/api/events');
  events.addEventListener('conversation', scheduleRefresh);
  events.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    toast(`🚨 ${n.title}`, n.body.split('\n')[0], () => n.conversation_id && openConversation(n.conversation_id));
    if ('Notification' in window && Notification.permission === 'granted') new Notification(n.title, { body: n.body });
    scheduleRefresh();
  });
  setInterval(refresh, 60000);
  await refresh();
  // First visit: offer the tour automatically.
  if (!storage.get('tourDone') && !parseHash().conv) startTour();
}

init().catch((err) => {
  document.body.prepend(h('div', { class: 'callout bad', style: 'margin:16px' }, `Could not start: ${err.message}`));
});
