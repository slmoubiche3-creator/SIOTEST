// Deterministic, explainable triage. Works offline, costs nothing, and is the
// safety net under the AI engine. Every decision adds a human-readable
// reason so agents can see *why* something was routed or escalated.
import { CATEGORIES, LOW_ONLY, NO_SECONDARY, maxUrgency, urgencyRank } from '../taxonomy.js';
import { normalize } from '../text.js';
import { detectLanguage } from './language.js';
import { extractDeadline, daysUntil } from './deadline.js';

// Patterns run on lower-cased text with accents removed ("piraté" -> "pirate").

const PATTERNS = {
  social_engineering: [
    [/\b(send|give|share|tell|forward) (me )?(the |your |our )?(admin(istrator)? |support |master |root )?(password|credentials|login details|2fa code|access codes?)\b/, 3],
    [/\b(it.?s|this is|i am|i.?m|c.?est) (the |le |votre )?(ceo|founder|fondateur|boss|patron|directeur)\b/, 3],
    [/\b(from|depuis) my personal (email|address|account)\b|\bmon (email|adresse) perso/, 2],
    [/\badmin(istrator)? password\b|\bmot de passe (admin|administrateur)\b/, 3],
  ],
  security_incident: [
    [/\bhack(ed|er|ers|ing)?\b/, 3],
    [/\bpirat(e|ee|es|age)\b/, 3],
    [/\b(gehackt|hackead[oa]|hackerat[oa])\b/, 3],
    [/\b(someone|somebody|a stranger) (has )?(logged|signed|got|broke) in(to)?\b/, 3],
    [/\bquelqu.?un s.?est (connecte|introduit)\b/, 3],
    [/\bunauthori[sz]ed (access|login|log ?in|change)/, 3],
    [/\bacces non autorise/, 3],
    [/\b(it|that) (wasn.?t|was not) me\b|\bce n.?etait pas moi\b/, 2],
    [/\b(account|compte) (was |a ete |has been )?(compromised|compromis|stolen|vole)\b/, 3],
    [/\bphishing\b|\bhameconnage\b/, 3],
    [/\bdata breach\b|\bfuite de donnees\b/, 3],
  ],
  gdpr: [
    [/\b(gdpr|rgpd|dsgvo|lgpd|ccpa)\b/, 3],
    [/\bart(icle|\.)?\s?(15|16|17|20|21)\b/, 2],
    [/\bright (to be forgotten|to erasure|of access|to access)\b|\bdroit (a l.?oubli|d.?acces|a l.?effacement)\b/, 3],
    [/\b(delete|erase|remove) (all )?(of )?my (personal )?(data|information)\b|\bsupprimer (toutes )?mes donnees\b/, 3],
    [/\bloschung\b|\bloschen\b/, 2],
    [/\bpersonenbezogen|\bdonnees personnelles\b|\bpersonal data\b|\bdatos personales\b|\bdati personali\b/, 2],
    [/\bdatenschutz|\bauskunft\b/, 1],
  ],
  legal: [
    [/\b(lawyer|attorney|lawsuit|sue you|legal action|avocat|anwalt|abogado|avvocato|tribunal|court order|police report|dmca|copyright|mise en demeure|poursuites? judiciaires?)\b/, 2],
    [/\bon behalf of my client\b|\bau nom de mon client\b/, 2],
  ],
  payment_gateway: [
    [/\bstripe\b/, 2],
    [/\bpaypal\b/, 1],
    [/\bcheckout\b/, 2],
    [/\b(order form|bon de commande|pagina de pedido|page de (paiement|commande)|payment page)\b/, 1],
    [/\bpayments? (failed|failing|fails|declined|error|not working|refused)\b|\bpaiements? (echou|refus)/, 2],
    [/\b(can.?t|cannot|unable to|not able to) pay\b|\bne (peuvent|peut|pouvons) (plus|pas) payer\b|\bno pueden pagar\b|\bnon possono pagare\b/, 3],
    [/\b(el|o|il) (pago|pagamento)\b|\bpago con\b/, 1],
    [/\b(carte|card) (refusee|declined)\b/, 2],
    [/\b(mollie|gocardless|razorpay|flutterwave|paystack|mercado ?pago|xendit|secureandpay)\b/, 2],
  ],
  outage: [
    [/\b(blank|white|empty) (white )?(screen|page)s?\b|\becrans? blancs?\b/, 3],
    [/\b(site|page|pages|funnel|funnels|website|tunnel|tunnels)\b[^.!?]{0,25}\b(down|not loading|won.?t load|offline|inaccessible|unreachable)\b/, 3],
    [/\b(error|erreur)\s*50[234]\b|\b50[234] (error|erreur|bad gateway)/, 2],
    [/\b(outage|panne|hors ligne)\b/, 2],
    [/\bne (s.?affiche(nt)?|se charge(nt)?|charge(nt)?) (plus|pas)\b/, 2],
  ],
  account_access: [
    [/\b(can.?t|cannot|unable to|not able to) (log ?in|login|sign ?in|access my account)\b/, 3],
    [/\blocked out\b/, 2],
    [/\b(password|mot de passe|passwort|contrasena) (reset|oublie|forgotten|incorrect|refuse|doesn.?t work)\b|\breset (my |the )?password\b|\breinitialis\w*/, 2],
    [/\bje n.?arrive (plus|pas) a me connecter\b|\bimpossible de me connecter\b|\bne peux (plus|pas) me connecter\b/, 3],
    [/\b2fa\b|\btwo.?factor\b|\bdouble authentification\b/, 2],
  ],
  domain: [
    [/\b(custom )?domains?\b|\bdomaines?\b|\bdominios?\b|\bdomini\b/, 2],
    [/\bdns\b/, 2],
    [/\bssl\b|\bcertifica(t|te|do)\b/, 2],
    [/\bcname\b|\ba record\b|\benregistrements? (a|cname)\b/, 2],
    [/\bpropagat/, 1],
    [/\b(ovh|godaddy|namecheap|ionos|cloudflare|hostinger|gandi)\b/, 1],
  ],
  bug: [
    [/\bbugs?\b|\bbugg(y|e)\b/, 2],
    [/\b(error|erreur|fehler|errore|erro)\b/, 1],
    [/\b(broken|crash(es|ed|ing)?|plante|planter)\b/, 2],
    [/\b(not working|doesn.?t work|isn.?t working|stopped working|stuck|freez\w*|glitch\w*)\b/, 1],
    [/\bne (fonctionne|marche) (plus|pas)\b|\bno funciona\b|\bnao funciona\b|\bnon funziona\b|\bfunktioniert nicht\b/, 1],
    [/\btracking\b|\bshows? 0\b|\bwebhooks?\b|\bapi\b|\bzapier\b/, 1],
  ],
  billing: [
    [/\b(invoice|facture|rechnung|factura|fattura|fatura)s?\b/, 2],
    [/\b(refund\w*|rembours\w*|erstatt\w*|reembols\w*|rimbors\w*)\b/, 2],
    [/\b(subscription|abonnement|abo|suscripcion|abbonamento|assinatura)\b/, 2],
    [/\b(downgrade|upgrade|upgraden)\b|\bchanger de (plan|forfait)\b/, 2],
    [/\b(cancel\w*|annuler|resilier|resiliation|kundigen|cancelar|disdire)\b/, 1],
    [/\b(charged|debite|preleve|abgebucht|cobrad[oa]|addebitat[oa])\b/, 2],
    [/\b(vat|tva|mwst|iva)\b/, 2],
    [/\b(plan|forfait|piano|plano)\b/, 1],
    [/\b(renewal|renouvellement|verlangerung|rinnovo)\b/, 1],
    [/\b(from|to|de|vers) (the )?(free|startup|webinar|unlimited)\b/, 1],
  ],
  affiliate: [
    [/\baffiliat\w*|\baffilie\w*|\bafiliad\w*|\baffiliazion\w*|\bpartner program/, 2],
    [/\bcommissions?\b|\bcomision\w*|\bcommissioni\b|\bprovisionen\b/, 2],
    [/عمول/, 2],
    [/افلييت|افلييت/, 2],
    [/\bpayouts?\b/, 1],
  ],
  deliverability: [
    [/\b(spam|junk|indesirables?|promotions?) (folder|dossier|tab|ordner|carpeta)\b|\bdossier (spam|courrier indesirable|promotions)\b/, 3],
    [/\b(land|lands|landing|go|goes|going|end up|ends up|arrive\w*|atterri\w*|tombent?|finissent?|vont|llegan|finiscono)\b[^.!?]{0,20}\b(spam|spams|junk|courriers? indesirables?)\b/, 3],
    [/\b(dkim|spf|dmarc)\b/, 3],
    [/\b(open rates?|taux d.?ouverture|offnungsrate|tasa de apertura|tasso di apertura)\b/, 2],
    [/\bbounc\w*/, 2],
    [/\bdeliverabilit\w*|\bdelivrabilite\b|\bzustellbarkeit\b/, 3],
    [/\bblacklist\w*|\bblocklist\w*/, 2],
    [/\bsender (domain|email|address)\b|\b(email|adresse) d.?expedi/, 1],
  ],
  abuse_complaint: [
    [/\b(never|jamais|nunca|mai) (signed up|subscribed|opted in|inscrit|abonne|me inscribi)\b/, 3],
    [/\b(unsubscribe|desinscription|desabonnement)\b[^.!?]{0,30}\b(doesn.?t|does not|don.?t|ne|not)\b[^.!?]{0,10}\b(work|marche|fonctionne|working)/, 3],
    [/\b(sending|sends|send|envoie|envoient)\b[^.!?]{0,15}\bspam\b/, 3],
    [/\bunsolicited|\bnon sollicit/, 2],
    [/\b(report|signaler) (spam|abuse|abus)\b/, 2],
  ],
  migration: [
    [/\b(kajabi|clickfunnels|teachable|thinkific|podia|kartra|learnybox|wordpress|wix|shopify|mailchimp|activecampaign|convertkit|sendinblue|brevo|getresponse|samcart|thrivecart|learndash|gumroad|squarespace|hubspot|leadpages|webflow)\b/, 1],
    [/\bmigrat\w*|\bmigrer\b|\bmigrar\b|\bmigrare\b/, 2],
    [/\bmoving (from|to|our|my)\b|\bmove (our|my|all|everything|it)\b|\bswitch(ing)? (from|to)\b/, 2],
    [/\btransfer\w*|\btransferer\b|\btrasferi\w*|\bimport(er|ing|ar|are)?\b/, 2],
    [/\bpasser de\b|\bumzug\b|\bdemenag\w*/, 2],
  ],
  feature_request: [
    [/\bfeature requests?\b|\bsuggestions?\b|\bsuggest\w*|\bsuggerimento\b|\bsugerencia\b/, 2],
    [/\bwould (be|love)\b[^.!?]{0,15}\b(amazing|great|nice|awesome|cool|helpful|useful|to have|if)\b/, 2],
    [/\b(plan|planning|plans) to add\b|\bany plans? (to|for)\b|\broadmap\b|\bat some point\b/, 2],
    [/\bdark mode\b|\bmode sombre\b/, 1],
    [/\bce serait (bien|genial|top|super)\b|\bil serait (bien|utile)\b|\bsarebbe (bello|fantastico|utile)\b|\bseria (genial|util|otimo)\b|\bware (toll|schon|super)\b/, 2],
    [/\b(add|ajouter|agregar|aggiungere) (a|an|une?|the)\b[^.!?]{0,30}\b(field|option|feature|fonctionnalite|integration)\b/, 1],
  ],
  how_to: [
    [/\bhow (do|can|should|would) (i|we|you)\b|\bhow to\b/, 2],
    [/\bcomment (je|on|faire|puis|creer|ajouter|changer|modifier)\b/, 2],
    [/\bwie (kann|konnen|richte) (ich|man|wir)\b/, 2],
    [/\bcomo (puedo|hago|se|posso|faco)\b/, 2],
    [/\bcome (posso|faccio|si)\b/, 2],
    [/\b(is it possible|est.?(ce|il) possible|es posible|e possibile)\b/, 1],
    [/\bwhere (can|do) i (find|change|set)\b|\bou (trouver|puis.?je)\b/, 1],
    [/\bworkaround\b|\bcontournement\b/, 2],
    [/\bi need to (change|add|set up|create|edit)\b/, 1],
  ],
  thanks: [
    [/\b(thank you|thanks|merci beaucoup|merci infiniment|gracias|grazie|danke|obrigad[oa])\b/, 1],
    [/\b(you.?re|vous etes|sois|siete|ihr seid) (the |les |los )?(best|great|amazing|meilleurs|mejores|migliori)\b/, 2],
  ],
  test_noise: [
    [/^\W*(test\W*)+(please ignore|ignore)?\W*$/, 4],
    [/\b(please ignore|ignore this|ceci est un test|this is a test|test message)\b/, 3],
  ],
  spam: [
    [/\b(make|earn|gagnez?)\b[^.!?]{0,12}\$?\d[\d,.]*\s?k?\s?(\/|per |a |par )?(week|day|month|semaine|jour|mois)\b/, 3],
    [/\bcrypto (signals?|deals?|trading|profits?)\b|\bbitcoin\b|\bforex\b|\bcasino\b|\bviagra\b/, 2],
    [/\bclick here\b|\bcliquez ici\b/, 1],
    [/\bguaranteed\b/, 1],
    [/\b(page 1|first page|premiere page) (of|on|de) google\b|\bdear (website|site) owner\b|\bseo (services?|audit|agency)\b|\bfree audit\b/, 2],
  ],
};

// Tie-break order when two categories score the same (most severe first).
const PRIORITY = ['social_engineering', 'security_incident', 'gdpr', 'legal', 'payment_gateway', 'outage', 'account_access',
  'abuse_complaint', 'deliverability', 'domain', 'migration', 'billing', 'affiliate', 'bug', 'how_to', 'feature_request',
  'spam', 'test_noise', 'thanks'];

const SIGNALS = {
  revenueImpact: /\b(losing|lost|lose|burning|burn)\b[^.!?]{0,20}\b(sales|money|customers|revenue|orders|clients)\b|\bburning money\b|\bperd(s|re|u|ons)?\b[^.!?]{0,15}\b(ventes|argent|clients|commandes)\b/,
  liveCheckout: /\b(checkout|order (form|page)|page de (paiement|commande)|pagina de pedido|payment page|customers?|clients?|clientes|buyers|el pago|payments? failed|payment failed)\b/,
  manyAffected: /\b(anyone else|everyone|everybody|all (my |our )?(customers|clients|users|pages|funnels)|c.?est general|tout le monde|is it just me|others? (too|as well)|plusieurs clients|toutes? (mes|les) (pages|clients))\b/,
  paymentFailure: /\b(fail\w*|falla\w*|echou\w*|error|erreur|declined|refus\w*|broken|down|not working|ne peuvent|can.?t pay|cannot pay)\b/,
  notWorking: /\b(not (working|connecting|loading)|still (isn.?t|not|broken|down)|isn.?t (working|connecting)|broken|no funciona|ne (fonctionne|marche) (plus|pas)|erreur|error|fails?)\b/,
  doubleCharge: /\b(twice|two times|charged two|double(d)? charge|deux fois|zweimal|doppelt|dos veces|due volte|duas vezes)\b/,
  dispute: /\b(chargeback|dispute|contestation|contestazione|litige|ruckbuchung|open a case)\b/,
  deliverabilityImpact: /\b(land|lands|go|goes|end up|arrive\w*|tombent?|vont)\b[^.!?]{0,20}\bspam\b|\bspam (folder|dossier)\b|\bbounc\w*|\bblacklist\w*|\b(open rates?|taux d.?ouverture)\b[^.!?]{0,40}\b(drop\w*|fell|fall\w*|chute\w*|passe)\b/,
  selfUrgent: /\b(urgent|urgente|urgence|dringend|asap|emergency|immediately|right away|au plus vite|tout de suite|sofort)\b|!!!/,
  noRush: /\b(no rush|no hurry|whenever you can|pas (urgent|presse)|rien d.?urgent|sin prisa|nessuna fretta|keine eile)\b/,
  followUp: /\b(\d+(st|nd|rd|th)|second|third|fourth) (time|message|email)\b|\b(still|toujours) (no|pas de|aucune?) (answer|reply|response|reponse)\b|\bno (answer|reply|response) (yet|so far)\b|\brelance\b|\b(deuxieme|troisieme|2e|3e) (fois|message|relance)\b|\bhaven.?t heard back\b|\bsomeone (please )?answer\b|\bstill waiting\b|\bsans reponse\b/,
  injection: /\b(ignore|disregard|forget|override)\b[^.!?]{0,20}\b(previous|prior|above|earlier|all|your)\b[^.!?]{0,15}\b(instructions?|prompts?|rules|guidelines)\b|\b(classify|mark|label|flag|treat) (this|it|me)\b[^.!?]{0,20}\b(critical|urgent|high priority)\b|\bassign (it|this|me) to\b|\bsystem prompt\b|\byou are (now )?(an? )?(ai|assistant|language model)\b/,
};

// Terms used to recognise "the same problem" across customers (incident detection).
export const INCIDENT_TERMS = ['stripe', 'paypal', 'mollie', 'gocardless', 'gmail', 'outlook', 'yahoo', 'hotmail', 'dkim', 'spf',
  'dmarc', 'dns', 'ssl', 'zapier', 'webhook', 'video', 'editor', 'checkout', 'login', 'blank', '502', '503', '504'];

const GREETING = /^\s*(bonjour|bonsoir|hello|hi|hey|hola|ciao|salam|salut|guten tag|hallo|ola|olá|dear [^,]+|cher [^,]+|chère [^,]+|sehr geehrte[^,]*|مرحبا)[\s,!.،]+/i;

// First sentence(s) of the message, skipping greetings, one-word shouts
// ("URGENT!!!") and sentences that only talk to the AI.
export function summarize(text, max = 120) {
  const cleaned = text.replace(GREETING, '').replace(/\s+/g, ' ').trim();
  // A sentence ends at punctuation followed by a space (not "sarahyoga.com").
  const sentences = cleaned.match(/.+?(?:[.!?؟]+(?=\s|$)|$)/g) ?? [cleaned];
  let out = '';
  for (const sentence of sentences) {
    if (SIGNALS.injection.test(normalize(sentence))) continue;
    out = `${out} ${sentence.trim()}`.trim();
    if (out.length >= 30) break;
  }
  out ||= cleaned;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

function scoreCategories(norm, original) {
  const sameLength = original.length === norm.length;
  const scores = {};
  const hits = {};
  for (const [cat, patterns] of Object.entries(PATTERNS)) {
    for (const [re, weight] of patterns) {
      const m = norm.match(re);
      if (!m) continue;
      scores[cat] = (scores[cat] ?? 0) + weight;
      const snippet = sameLength ? original.slice(m.index, m.index + m[0].length) : m[0];
      (hits[cat] ??= []).push(snippet.trim());
    }
  }
  return { scores, hits };
}

function pickCategory(scores) {
  if (scores.spam >= 3) return 'spam';
  if (scores.test_noise >= 3) return 'test_noise';
  if (scores.social_engineering >= 5) return 'social_engineering';
  const ranked = Object.entries(scores)
    .filter(([cat]) => !['spam', 'test_noise', 'thanks'].includes(cat))
    .sort((a, b) => b[1] - a[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]));
  if (ranked.length) return ranked[0][0];
  if (scores.thanks) return 'thanks';
  return 'general';
}

/**
 * Analyse one message. `receivedAt` (ISO) anchors relative dates in the text,
 * `now` (ms) is "today" for deadline maths.
 * Returns everything the UI needs, including human-readable reasons.
 */
export function analyzeWithRules({ body, subject = '' }, { receivedAt, now }) {
  const original = `${subject ? `${subject}. ` : ''}${body ?? ''}`.trim();
  const norm = normalize(original);
  const reasons = [];
  const flags = [];
  const flag = (type, label) => { if (!flags.some((f) => f.type === type)) flags.push({ type, label }); };

  const { scores, hits } = scoreCategories(norm, original);
  const category = pickCategory(scores);
  const def = CATEGORIES[category];
  const top = scores[category] ?? 0;
  // Only a competing topic for *another* team makes the routing uncertain.
  const runnerUp = Math.max(0, ...Object.entries(scores)
    .filter(([cat]) => cat !== category && CATEGORIES[cat]?.team !== def.team && !LOW_ONLY.has(cat))
    .map(([, v]) => v));

  if (category === 'general') reasons.push('No known topic matched: routed to Support for a human read');
  else reasons.push(`Topic "${def.label}" (matched: ${[...new Set(hits[category])].slice(0, 3).map((h) => `"${h}"`).join(', ')}) → ${def.team}`);

  const has = (name) => SIGNALS[name].test(norm);
  let urgency = def.base;
  const raise = (level, why) => {
    if (LOW_ONLY.has(category)) return;
    if (urgencyRank(level) > urgencyRank(urgency)) { urgency = level; reasons.push(why); }
  };

  if (category === 'payment_gateway' && has('paymentFailure')) {
    if (has('liveCheckout') || has('revenueImpact') || has('manyAffected')) raise('critical', 'Live payments are failing: every sale is lost until fixed');
    else raise('high', 'Payment setup is failing');
  }
  if (category === 'outage' && has('manyAffected')) raise('critical', 'Several customers or all pages seem affected');
  if (category === 'domain' && has('notWorking')) raise('high', 'Domain is not working (site unreachable on its own domain)');
  if (category === 'billing' && (has('doubleCharge') || has('dispute'))) raise('high', has('dispute') ? 'Customer threatens a bank dispute / chargeback' : 'Customer was charged twice');
  if (category === 'deliverability' && has('deliverabilityImpact')) raise('high', 'Emails are landing in spam or bouncing (direct revenue impact)');
  if (has('revenueImpact')) raise('high', 'Customer is losing money right now');

  let deadline = null;
  const found = receivedAt ? extractDeadline(original, receivedAt) : null;
  if (found) {
    const days = daysUntil(found.at, now);
    deadline = { ...found, daysLeft: days };
    const when = days < 0 ? `passed ${-days} day(s) ago` : days === 0 ? 'is today' : `is in ${days} day(s)`;
    if (days < 0) flag('deadline_passed', `Deadline "${found.phrase}" has already passed`);
    const before = urgency;
    if (days <= 7) raise('high', `Deadline "${found.phrase}" ${when}${days < 0 ? ': damage may already be done' : ''}`);
    if (urgency === before) reasons.push(`Deadline "${found.phrase}" ${when}`);
  }

  if (has('followUp')) {
    flag('follow_up', 'Customer says they already wrote without an answer');
    raise('high', 'Customer is chasing an earlier unanswered message');
  }
  if (has('noRush')) flag('no_rush', 'Customer says it is not urgent');
  if (has('selfUrgent') && urgencyRank(urgency) <= urgencyRank('normal') && !LOW_ONLY.has(category)) {
    flag('self_declared_urgency', 'Says "urgent" but no business impact or deadline found: not escalated');
    reasons.push('"Urgent" wording alone does not raise urgency');
  }
  if (has('injection')) {
    flag('prompt_injection', 'Contains instructions aimed at the triage AI: ignored');
    reasons.push('Instructions to the AI inside the message were ignored');
  }
  if (category === 'social_engineering') flag('credential_request', 'Asks for credentials / claims to be staff: never share access');
  if (category === 'spam') flag('spam', 'Looks like spam');
  if (category === 'test_noise') flag('test', 'Looks like a test message');

  // Second topic for another team ("my invoice is wrong. Also, the editor crashes").
  const secondaryTeams = [];
  const noSecondary = NO_SECONDARY.has(category);
  for (const [cat, score] of Object.entries(scores)) {
    const team = CATEGORIES[cat]?.team;
    if (noSecondary || cat === category || score < 2 || ['how_to', 'thanks', 'test_noise', 'spam', 'feature_request'].includes(cat)) continue;
    if (team !== def.team && !secondaryTeams.includes(team)) secondaryTeams.push(team);
  }
  if (secondaryTeams.length) flag('multi_topic', `Also concerns: ${secondaryTeams.join(', ')}`);

  let confidence = category === 'general' ? 0.2 : Math.min(0.95, 0.45 + 0.1 * top);
  if (runnerUp && runnerUp >= top * 0.75 && category !== 'spam') confidence *= 0.8;
  confidence = Number(confidence.toFixed(2));
  if (confidence < 0.55) flag('low_confidence', 'Low confidence: please check the routing');

  const lang = detectLanguage(original);
  return {
    category,
    team: def.team,
    urgency: maxUrgency(urgency),
    language: lang.language,
    summary: summarize(body || subject || ''),
    need: def.need,
    reasons,
    flags,
    confidence,
    deadline,
    secondaryTeams,
    incidentTerm: INCIDENT_TERMS.find((term) => new RegExp(`\\b${term}\\b`).test(norm)) ?? null,
    engine: 'rules',
  };
}
