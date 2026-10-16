// Finds the customer's deadline in free text: "launch is on Thursday Oct 15",
// "plan ends Oct 20", "launch in 6 days", "ads start Monday", "tomorrow's
// payout", "lancement le 15 octobre"... Dates are resolved relative to when
// the message was received, not to today.
import { monthIndex } from '../parse.js';
import { normalize } from '../text.js';

const DAY = 86400000;
const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6,
};
const MONTH_WORD = '(jan(?:uary|vier)?|feb(?:ruary)?|fev(?:rier)?|mar(?:ch|s)?|apr(?:il)?|avr(?:il)?|may|mai|june?|juin|july?|juil(?:let)?|aug(?:ust)?|aout|sept?(?:ember|embre)?|oct(?:ober|obre)?|okt(?:ober)?|nov(?:ember|embre)?|dec(?:ember|embre)?|dez(?:ember)?)';
// Words that make a date a deadline rather than a past reference.
const CONTEXT = /(launch|lancement|lance|start|starts|begin|ends?|expire|renewal|renouvellement|before|avant|by|deadline|due|payout|webinar|event|live|ouverture|sortie|until|jusqu)/;

const startOfDay = (t) => Math.floor(t / DAY) * DAY;

export function extractDeadline(text, receivedAtIso) {
  const received = new Date(receivedAtIso).getTime();
  const t = normalize(text);
  const found = [];
  const add = (ms, phrase) => found.push({ at: new Date(startOfDay(ms)).toISOString(), phrase: phrase.trim() });
  const nearContext = (idx) => CONTEXT.test(t.slice(Math.max(0, idx - 45), idx + 30));

  // "Oct 15", "Thursday Oct 15", "October 20th"
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:h|:|am|pm|%))`, 'g'))) {
    const mo = monthIndex(m[1]);
    if (mo === undefined || !nearContext(m.index)) continue;
    add(resolveYear(mo, +m[2], received), m[0]);
  }
  // "15 octobre", "20 oct."
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_WORD}\\b`, 'g'))) {
    const mo = monthIndex(m[2]);
    if (mo === undefined || !nearContext(m.index)) continue;
    add(resolveYear(mo, +m[1], received), m[0]);
  }
  // "in 6 days", "dans 3 jours", "en 2 dias", "in 2 weeks"
  for (const m of t.matchAll(/\b(?:in|dans|en|entro|em)\s+(\d{1,2})\s+(days?|jours?|dias?|giorni|tagen|weeks?|semaines?)\b/g)) {
    if (!nearContext(m.index)) continue;
    const n = +m[1] * (/^(week|semaine)/.test(m[2]) ? 7 : 1);
    add(received + n * DAY, m[0]);
  }
  // "tomorrow", "demain", "manana", "domani"
  // "I'll try again tomorrow" is not a deadline: a deadline word must be close.
  for (const m of t.matchAll(/\b(tomorrow|demain|manana|domani)\b/g)) if (nearContext(m.index)) add(received + DAY, m[0]);
  // "today", "tonight", "ce soir", "aujourd'hui" with a deadline word nearby
  for (const m of t.matchAll(/\b(today|tonight|ce soir|aujourd.?hui|hoy|esta noche|heute|stasera|oggi)\b/g)) {
    if (nearContext(m.index)) add(received, m[0]);
  }
  // "start Monday", "lancement jeudi" (only when not already part of "Thursday Oct 15")
  for (const m of t.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi|domingo|lunes|martes|miercoles|jueves|viernes|sabado|sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b(?!\s+(?:\d|[a-z]{3,9}\.?\s+\d))/g)) {
    if (!nearContext(m.index)) continue;
    const target = WEEKDAYS[m[1]];
    const from = new Date(received).getUTCDay();
    const ahead = ((target - from + 7) % 7) || 7;
    add(received + ahead * DAY, m[0]);
  }
  if (!found.length) return null;
  // The earliest date that is not before the message itself.
  const valid = found.filter((f) => new Date(f.at).getTime() >= startOfDay(received)).sort((a, b) => a.at.localeCompare(b.at));
  return valid[0] ?? found.sort((a, b) => a.at.localeCompare(b.at))[0];
}

function resolveYear(month, day, received) {
  const y = new Date(received).getUTCFullYear();
  const candidate = Date.UTC(y, month, day);
  // "Jan 5" written in December means next year.
  return candidate < received - 180 * DAY ? Date.UTC(y + 1, month, day) : candidate;
}

// Whole days between today and the deadline (negative = already passed).
export function daysUntil(deadlineIso, nowMs) {
  return Math.round((startOfDay(new Date(deadlineIso).getTime()) - startOfDay(nowMs)) / DAY);
}
