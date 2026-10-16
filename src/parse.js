// Parsing helpers for messy inbound data: CSV, dates, senders.
import { normalize } from './text.js';

// RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines
// inside quotes, CRLF, UTF-8 BOM. Returns an array of objects keyed by header.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Column aliases so other exports (Crisp, Intercom, FreeScout...) import too.
const ALIASES = {
  received_at: ['received_at', 'date', 'created_at', 'timestamp', 'received', 'datetime', 'sent_at'],
  source: ['source', 'channel', 'via', 'origin'],
  from: ['from', 'sender', 'customer', 'contact'],
  email: ['email', 'customer_email', 'from_email'],
  name: ['name', 'customer_name', 'from_name'],
  subject: ['subject', 'title'],
  message: ['message', 'body', 'content', 'text', 'description'],
  external_id: ['id', 'external_id', 'ticket_id', 'reference'],
};

export function mapColumns(record) {
  const out = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const hit = names.find((n) => record[n] !== undefined && record[n] !== '');
    out[key] = hit ? record[hit] : '';
  }
  return out;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

// "Name <email>", "email", "", or garbage like "lina.haddad.com".
export function parseSender(raw = '', emailField = '', nameField = '') {
  const text = String(raw ?? '').trim();
  let name = String(nameField ?? '').trim() || null;
  let candidate = String(emailField ?? '').trim();
  const angle = text.match(/^(.*?)<([^>]*)>\s*$/);
  if (angle) {
    name = name || angle[1].trim().replace(/^"|"$/g, '') || null;
    candidate = candidate || angle[2].trim();
  } else if (!candidate) {
    candidate = text;
  }
  if (!candidate) return { name, email: null, issue: 'missing' };
  if (EMAIL_RE.test(candidate)) return { name, email: candidate.toLowerCase(), issue: null };
  return { name: name || null, email: null, issue: 'invalid', rawAddress: candidate };
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  janv: 0, fev: 1, fevr: 1, mars: 2, avr: 3, mai: 4, juin: 5, juil: 6, aout: 7, sept: 8, okt: 9, dez: 11,
};
export const monthIndex = (word) => {
  const w = normalize(word).replace(/\.$/, '');
  return MONTHS[w] ?? MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)];
};

// Parses the date formats seen in real exports. Times without a zone are
// treated as UTC. Day/month order defaults to European (DD/MM) unless the
// numbers make that impossible. A missing year is taken from `now`.
// Returns { iso, precision: 'minute'|'day', notes: [] } or null.
export function parseDate(raw, now = new Date()) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const notes = [];
  let y, mo, d, h = null, mi = null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/))) {
    if (m[6]) {
      const dt = new Date(s.replace(' ', 'T'));
      return Number.isNaN(dt.getTime()) ? null : { iso: dt.toISOString(), precision: 'minute', notes };
    }
    [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
    if (m[4] !== undefined) [h, mi] = [+m[4], +m[5]];
  } else if ((m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/))) {
    let [a, b] = [+m[1], +m[2]];
    if (a <= 12 && b > 12) { [a, b] = [b, a]; notes.push('read as MM/DD (day > 12)'); }
    else if (a <= 12 && b <= 12 && a !== b) notes.push('ambiguous date, read as DD/MM');
    [y, mo, d] = [+m[3], b - 1, a];
    if (m[4] !== undefined) [h, mi] = [+m[4], +m[5]];
  } else if ((m = s.match(/^([A-Za-zÀ-ÿ]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?(?:,?\s+(\d{1,2}):(\d{2}))?$/))) {
    mo = monthIndex(m[1]); d = +m[2]; y = m[3] ? +m[3] : null;
    if (m[4] !== undefined) [h, mi] = [+m[4], +m[5]];
  } else if ((m = s.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]{3,10})\.?,?(?:\s+(\d{4}))?(?:,?\s+(\d{1,2}):(\d{2}))?$/))) {
    d = +m[1]; mo = monthIndex(m[2]); y = m[3] ? +m[3] : null;
    if (m[4] !== undefined) [h, mi] = [+m[4], +m[5]];
  } else {
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return null;
    notes.push('parsed with generic parser');
    return { iso: dt.toISOString(), precision: 'minute', notes };
  }
  if (mo === undefined || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  if (y === null) {
    y = now.getUTCFullYear();
    if (Date.UTC(y, mo, d) > now.getTime() + 86400000) y -= 1;
    notes.push(`year missing, assumed ${y}`);
  }
  const precision = h === null ? 'day' : 'minute';
  if (precision === 'day') notes.push('no time given');
  const dt = new Date(Date.UTC(y, mo, d, h ?? 0, mi ?? 0));
  if (dt.getUTCDate() !== d) return null; // e.g. 31/02
  return { iso: dt.toISOString(), precision, notes };
}
