// AI through an n8n workflow: the tool sends the instructions and the message
// to an n8n webhook, n8n calls whichever AI provider it is set up with
// (OpenAI, Anthropic, Gemini...) and answers with the same JSON as the
// Anthropic engine. Changing provider then happens in n8n, not in this code.
// Template workflow: n8n/inbox-triage-ai-classifier.json
import { SYSTEM_PROMPT, buildUserContent, validate } from './ai.js';

export const N8N_SECRET_HEADER = 'X-Triage-Secret';

export function createN8nEngine({ url, secret, fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!url || !secret) throw new Error('n8n needs a webhook URL and a secret');
  return {
    name: 'n8n',
    model: 'n8n workflow',
    async classify(input, ctx) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [N8N_SECRET_HEADER]: secret },
          body: JSON.stringify({ system: SYSTEM_PROMPT, prompt: buildUserContent(input, ctx) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`n8n could not be reached (${err.cause?.code ?? err.message})`);
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        const detail = data?.error ?? data?.message ?? '';
        throw Object.assign(new Error(`n8n answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
      }
      if (!data || typeof data !== 'object') throw new Error('n8n did not answer with JSON');
      // A Structured Output Parser wraps the result in { output: ... }.
      return validate(data.output ?? data);
    },
  };
}
