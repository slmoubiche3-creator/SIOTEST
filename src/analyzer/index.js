// Combines the two engines. Policy, in plain words:
// - Rules always run (free, instant, explainable).
// - If the AI engine is configured, it decides the topic and writes the summary.
// - Urgency is the higher of the two: the AI can raise it, never lower a
//   rule-based escalation (a missed critical costs more than a false alarm).
// - If the message tries to manipulate the AI, the AI may not raise urgency.
// - Any AI error falls back to the rules result.
import { CATEGORIES, NO_SECONDARY, maxUrgency, urgencyRank, teamName } from '../taxonomy.js';
import { analyzeWithRules } from './rules.js';

export function createAnalyzer({ ai = null } = {}) {
  return {
    engine: ai ? `AI (${ai.model}) + rules` : 'rules',
    async analyze(input, ctx) {
      const rules = analyzeWithRules(input, ctx);
      if (!ai) return rules;
      try {
        const result = await ai.classify(input, ctx);
        return mergeWithGuardrails(rules, result);
      } catch (err) {
        return { ...rules, engineError: err.message };
      }
    },
  };
}

export function mergeWithGuardrails(rules, ai) {
  const def = CATEGORIES[ai.category];
  // Flags that describe the category follow the final (AI) category, so a real
  // complaint the rules took for spam is not hidden from the counts.
  const CATEGORY_FLAGS = { spam: ['spam', 'Looks like spam'], test_noise: ['test', 'Looks like a test message'], social_engineering: ['credential_request', 'Asks for credentials / claims to be staff: never share access'] };
  const categoryFlagTypes = Object.values(CATEGORY_FLAGS).map(([type]) => type);
  const flags = rules.flags.filter((f) => !categoryFlagTypes.includes(f.type));
  if (CATEGORY_FLAGS[ai.category]) flags.push({ type: CATEGORY_FLAGS[ai.category][0], label: CATEGORY_FLAGS[ai.category][1] });
  const guardrails = [];
  const manipulated = ai.injection || rules.flags.some((f) => f.type === 'prompt_injection');
  if (ai.injection && !flags.some((f) => f.type === 'prompt_injection')) {
    flags.push({ type: 'prompt_injection', label: 'Contains instructions aimed at the triage AI: ignored' });
  }

  let urgency = maxUrgency(ai.urgency, rules.urgency);
  if (urgencyRank(rules.urgency) > urgencyRank(ai.urgency)) {
    guardrails.push(`Safety net: rules kept urgency at ${rules.urgency} (AI said ${ai.urgency})`);
  }
  if (manipulated && urgencyRank(ai.urgency) > urgencyRank(rules.urgency)) {
    urgency = rules.urgency;
    guardrails.push('Message tries to steer the AI: AI was not allowed to raise urgency');
  }
  if (def.team !== rules.team) {
    flags.push({ type: 'engines_disagree', label: `Rules suggested ${teamName(rules.team)}: please check` });
  }

  const secondaryTeams = NO_SECONDARY.has(ai.category) ? [] : [...new Set([
    ...ai.secondaryCategories.map((c) => CATEGORIES[c].team),
    ...rules.secondaryTeams,
  ])].filter((t) => t !== def.team);

  return {
    ...rules,
    category: ai.category,
    team: def.team,
    urgency,
    language: ai.language ?? rules.language,
    summary: ai.summary || rules.summary,
    need: ai.need || def.need,
    reasons: [...ai.reasons.map((r) => `AI: ${r}`), ...guardrails, ...rules.reasons.map((r) => `Rules: ${r}`)],
    flags,
    confidence: ai.confidence,
    secondaryTeams,
    engine: 'ai',
  };
}
