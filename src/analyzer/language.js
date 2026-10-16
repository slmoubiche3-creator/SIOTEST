// Lightweight language detection: script detection for non-Latin alphabets,
// then distinctive stop-word counts for Latin languages. Good enough for
// routing; the AI engine overrides it when enabled.

const SCRIPTS = [
  ['ar', /[؀-ۿ]/g],
  ['he', /[֐-׿]/g],
  ['ru', /[Ѐ-ӿ]/g],
  ['el', /[Ͱ-Ͽ]/g],
  ['ja', /[぀-ヿ]/g],
  ['zh', /[一-鿿]/g],
  ['ko', /[가-힯]/g],
  ['th', /[฀-๿]/g],
  ['hi', /[ऀ-ॿ]/g],
];

// Only words that are distinctive for one language (shared words like
// "de", "la", "a", "in" are left out on purpose).
const STOPWORDS = {
  en: 'the and is are was were to my i you your it for on this that have has with not can please hi hello since of be would will do does did how what when our we me still just any get about from before after there here at been want like last night anyone else',
  fr: 'le les des et je mon ma mes est pas une pour qui sur avec depuis bonjour merci vous ne plus ce du au aux nous mais dans alors aussi j qu ai suis mes clients',
  es: 'el los las y mi mis es por para con hola gracias del hace desde pero muy esta puedo tengo hora una',
  de: 'der die das und ich ist nicht mit ein eine mir mein meinem meine meiner bitte sie zu von den dem für guten tag wurde wie kann einen im auf um aller alle gemäß sehr geehrte',
  it: 'il lo gli di che non per mi sono ciao grazie è sarebbe alla dei delle della avete voglio altrimenti apro una',
  pt: 'não um uma com meu minha olá obrigado obrigada você são nenhum os ao pelo pela',
  nl: 'het een ik niet van wat mijn hallo zonder tussen verschil graag bedankt',
};
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

const CHAR_HINTS = [
  ['es', /[ñ¿¡]/g, 2],
  ['de', /[ßäöü]/g, 1],
  ['pt', /[ãõ]/g, 2],
  ['fr', /[èêùçœ«»]/g, 1],
  ['it', /[ìò]/g, 1],
];

export function detectLanguage(text = '') {
  const letters = (text.match(/\p{L}/gu) || []).length || 1;
  for (const [code, re] of SCRIPTS) {
    const n = (text.match(re) || []).length;
    if (n / letters > 0.3) return { language: code, confidence: Math.min(1, 0.6 + n / letters / 2) };
  }
  const lower = text.toLowerCase();
  const words = lower.split(/[^\p{L}]+/u).filter(Boolean);
  const scores = Object.fromEntries(Object.keys(SETS).map((k) => [k, 0]));
  for (const w of words) for (const k of Object.keys(SETS)) if (SETS[k].has(w)) scores[k] += 1;
  for (const [code, re, weight] of CHAR_HINTS) scores[code] += (lower.match(re) || []).length * weight;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] === 0) return { language: 'en', confidence: 0 };
  // Margin over the runner-up, discounted when there is little evidence.
  const confidence = Math.min(0.99, ((best[1] - second[1]) / best[1]) * (1 - 1 / (best[1] + 1)));
  return { language: best[0], confidence: Number(confidence.toFixed(2)) };
}
