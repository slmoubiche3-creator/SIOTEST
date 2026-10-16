// Lower-case and strip accents so patterns match "piraté", "pirate", "PIRATÉ".
// Keeps string length for precomposed characters, so match positions map
// back to the original text.
export const normalize = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
