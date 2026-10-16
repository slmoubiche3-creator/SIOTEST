// Single source of truth for teams, urgency levels, statuses and categories.
// Routing is data, not code: change a category's `team` here and both the
// rules engine and the AI engine follow.

export const TEAMS = [
  { id: 'support', name: 'Support' },
  { id: 'tech', name: 'Tech' },
  { id: 'billing', name: 'Billing' },
  { id: 'deliverability', name: 'Deliverability' },
  { id: 'migration', name: 'Migration' },
  { id: 'product', name: 'Product' },
  { id: 'security_legal', name: 'Security & Legal' },
];
export const TEAM_IDS = TEAMS.map((t) => t.id);

export const URGENCIES = ['low', 'normal', 'high', 'critical'];
export const urgencyRank = (u) => URGENCIES.indexOf(u);
export const maxUrgency = (...levels) =>
  levels.filter(Boolean).reduce((a, b) => (urgencyRank(b) > urgencyRank(a) ? b : a), 'low');
export const bumpUrgency = (u, steps = 1) =>
  URGENCIES[Math.min(URGENCIES.length - 1, urgencyRank(u) + steps)];

export const STATUSES = ['new', 'in_progress', 'waiting_customer', 'resolved'];

// base = urgency before impact/deadline signals are applied.
export const CATEGORIES = {
  security_incident: { label: 'Account compromise / security threat', team: 'security_legal', base: 'critical', need: 'Secure the account or stop an active security threat' },
  social_engineering: { label: 'Impersonation / credential request', team: 'security_legal', base: 'critical', need: 'Suspicious request for credentials: do not comply, Security must review' },
  gdpr: { label: 'GDPR / personal data request', team: 'security_legal', base: 'high', need: 'Exercise a GDPR right (access or erasure of personal data) within the legal deadline' },
  legal: { label: 'Legal matter', team: 'security_legal', base: 'high', need: 'Legal matter that needs a formal answer' },
  payment_gateway: { label: 'Payments / checkout (Stripe, PayPal...)', team: 'tech', base: 'normal', need: "Get the customer's checkout taking payments again" },
  outage: { label: 'Pages down / site not loading', team: 'tech', base: 'high', need: 'Bring pages that are down back online' },
  domain: { label: 'Custom domain / DNS / SSL', team: 'tech', base: 'normal', need: 'Get a custom domain connected and working' },
  bug: { label: 'Bug / something not working', team: 'tech', base: 'normal', need: 'Fix a feature that is not working as expected' },
  billing: { label: 'Subscription / invoice / refund', team: 'billing', base: 'normal', need: 'Sort out their systeme.io subscription, invoice or refund' },
  affiliate: { label: 'Affiliate program / commissions', team: 'billing', base: 'normal', need: 'Answer an affiliate commission or tracking question' },
  deliverability: { label: 'Email deliverability (spam folder, DKIM...)', team: 'deliverability', base: 'normal', need: 'Get their emails delivered to the inbox' },
  abuse_complaint: { label: 'Spam complaint about a systeme.io sender', team: 'deliverability', base: 'high', need: 'Stop unwanted emails sent by a systeme.io user' },
  migration: { label: 'Migration from another platform', team: 'migration', base: 'normal', need: 'Move courses, funnels or contacts from another platform' },
  feature_request: { label: 'Feature request / feedback', team: 'product', base: 'low', need: 'Suggests a feature or improvement' },
  account_access: { label: 'Login / account access', team: 'support', base: 'high', need: 'Regain access to their account' },
  how_to: { label: 'How-to question', team: 'support', base: 'normal', need: 'Learn how to do something in systeme.io' },
  thanks: { label: 'Thanks / positive feedback', team: 'support', base: 'low', need: 'No action needed beyond a thank-you' },
  test_noise: { label: 'Test / empty message', team: 'support', base: 'low', need: 'No action needed (test message)' },
  spam: { label: 'Spam / unsolicited promotion', team: 'support', base: 'low', need: 'No action needed (spam)' },
  general: { label: 'General / unclear', team: 'support', base: 'normal', need: 'Unclear request: a human needs to read it' },
};
export const CATEGORY_IDS = Object.keys(CATEGORIES);
// Categories that stay low whatever the wording (no escalation from "URGENT",
// deadlines or repeat contacts).
export const LOW_ONLY = new Set(['spam', 'test_noise', 'thanks']);
// Categories that never get a "second team": a fake CEO "locked out" is not a Support case.
export const NO_SECONDARY = new Set(['social_engineering', 'spam', 'test_noise']);

// Flags that put a conversation in the "Needs review" queue: the tool is
// unsure about something a person should check (sender, date, routing, AI).
export const REVIEW_FLAGS = ['no_sender', 'invalid_sender', 'date_guessed', 'low_confidence', 'engines_disagree', 'prompt_injection'];

// Response-time targets (time to first answer), in hours.
export const SLA_HOURS = { critical: 1, high: 4, normal: 24, low: 72 };

export const teamName = (id) => TEAMS.find((t) => t.id === id)?.name ?? id;
