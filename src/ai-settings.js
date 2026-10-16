// AI engine settings. Two providers:
// - "anthropic": an Anthropic API key + a model chosen from Anthropic's list;
// - "n8n": an n8n webhook URL + secret; n8n calls whatever AI it is set up with.
// - The key stays on the server (database file, never in Git) and is never
//   sent back to the browser.
// - A key in the environment (ANTHROPIC_API_KEY) always wins and cannot be
//   changed from the UI.
// - A model is only switched on after one test classification succeeds.
import { createAiEngine, createAnthropicClient, listModels } from './analyzer/ai.js';
import { createN8nEngine, N8N_SECRET_HEADER } from './analyzer/n8n.js';

const TEST_MESSAGE = { body: 'Hello, how do I add a coupon to my order form?' };

const friendly = (err) => {
  if (err.status === 401) return 'Anthropic refused this API key. Check that it was copied entirely.';
  if (err.status === 403) return 'This API key is not allowed to use that model.';
  if (err.status === 404) return 'This model is not available for this API key.';
  if (err.status === 429) return 'Too many requests or no credit left on this API key. Try again later.';
  return err.message;
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const friendlyN8n = (err) => {
  if (err.status === 401 || err.status === 403) return `n8n refused the secret. Check the Header Auth credential on the webhook (name ${N8N_SECRET_HEADER}).`;
  if (err.status === 404) return 'n8n does not know this URL. Is the workflow published? Use the production URL, not the test URL.';
  if (err.status === 502 && /authori[sz]ation|credential|api key|invalid.*key|quota|billing|insufficient/i.test(err.message)) {
    return `The AI step in n8n failed: ${err.message.replace(/^n8n: /, '')}. Check the AI credential used by the model node in n8n (valid key, credit left).`;
  }
  if (err.status === 502) return `The AI step in n8n failed. ${err.message}`;
  return err.message;
};

export function createAiSettings({ db, env, analyzer, clock, clientFactory = createAnthropicClient, fetchImpl = fetch }) {
  const get = (key) => db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  const set = (key, value) => (value === null
    ? db.run('DELETE FROM settings WHERE key = ?', key)
    : db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value));

  const envKey = () => Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const keySource = () => (envKey() ? 'environment' : get('anthropic_api_key') ? 'settings' : null);
  const model = () => get('ai_model') ?? env.AI_MODEL ?? null;
  // Environment key: let the SDK read it. Saved key: pass it explicitly.
  const client = (apiKey) => clientFactory(apiKey ?? (envKey() ? undefined : get('anthropic_api_key')));
  const provider = () => get('ai_provider') ?? env.AI_PROVIDER ?? 'anthropic';
  const n8nUrl = () => get('n8n_url') ?? env.N8N_WEBHOOK_URL ?? null;
  const n8nSecret = () => get('n8n_secret') ?? env.N8N_WEBHOOK_SECRET ?? null;
  const makeN8n = (url = n8nUrl(), secret = n8nSecret()) => createN8nEngine({ url, secret, fetchImpl });
  let lastError = null;

  async function apply() {
    lastError = null;
    if (env.ANALYZER === 'rules') { analyzer.setAi(null); return; }
    try {
      if (provider() === 'n8n') analyzer.setAi(n8nUrl() && n8nSecret() ? makeN8n() : null);
      else if (keySource() && model()) analyzer.setAi(createAiEngine({ client: await client(), model: model() }));
      else analyzer.setAi(null);
    } catch (err) {
      lastError = err.message;
      analyzer.setAi(null);
    }
  }

  // One short classification, so a broken setup is never switched on.
  async function tryOnce(engine) {
    const now = clock.now();
    await engine.classify(TEST_MESSAGE, { receivedAt: new Date(now).toISOString(), now });
  }

  function status() {
    return {
      enabled: analyzer.engine !== 'rules',
      engine: analyzer.engine,
      provider: provider(),
      n8n: { url: n8nUrl(), secretSet: Boolean(n8nSecret()), header: N8N_SECRET_HEADER },
      keySource: keySource(),
      model: model(),
      forcedRulesOnly: env.ANALYZER === 'rules',
      needsAdminToken: Boolean(env.ADMIN_TOKEN),
      error: lastError,
    };
  }

  async function saveKey(apiKey) {
    if (envKey()) throw fail(409, 'The API key is set on the server (ANTHROPIC_API_KEY): change it there.');
    const key = String(apiKey ?? '').trim();
    if (key.length < 20 || /\s/.test(key)) throw fail(400, 'This does not look like an API key.');
    let models;
    try { models = await listModels(await clientFactory(key)); }
    catch (err) { throw fail(400, friendly(err)); }
    set('anthropic_api_key', key);
    if (model() && !models.some((m) => m.id === model())) set('ai_model', null);
    await apply();
    return { status: status(), models };
  }

  async function removeKey() {
    if (envKey()) throw fail(409, 'The API key is set on the server (ANTHROPIC_API_KEY): remove it there.');
    set('anthropic_api_key', null);
    await apply();
    return status();
  }

  async function models() {
    if (!keySource()) throw fail(400, 'Add an API key first.');
    try { return await listModels(await client()); }
    catch (err) { throw fail(400, friendly(err)); }
  }

  async function saveModel(id) {
    if (!keySource()) throw fail(400, 'Add an API key first.');
    const chosen = String(id ?? '').trim();
    if (!chosen) throw fail(400, 'Choose a model.');
    try {
      await tryOnce(createAiEngine({ client: await client(), model: chosen }));
    } catch (err) {
      throw fail(400, `This model did not work with the tool: ${friendly(err)}`);
    }
    set('ai_model', chosen);
    set('ai_provider', 'anthropic');
    await apply();
    return status();
  }

  async function saveN8n({ url, secret } = {}) {
    const cleanUrl = String(url ?? '').trim();
    let parsed;
    try { parsed = new URL(cleanUrl); } catch { throw fail(400, 'This is not a valid URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw fail(400, 'The URL must start with https://');
    const newSecret = String(secret ?? '').trim();
    if (newSecret && newSecret.length < 16) throw fail(400, 'Use a secret of at least 16 characters.');
    const finalSecret = newSecret || n8nSecret();
    if (!finalSecret) throw fail(400, `Paste the secret of the n8n Header Auth credential (${N8N_SECRET_HEADER}).`);
    try {
      await tryOnce(makeN8n(cleanUrl, finalSecret));
    } catch (err) {
      throw fail(400, friendlyN8n(err));
    }
    set('n8n_url', cleanUrl);
    set('n8n_secret', finalSecret);
    set('ai_provider', 'n8n');
    await apply();
    return status();
  }

  async function removeN8n() {
    set('n8n_url', null);
    set('n8n_secret', null);
    if (get('ai_provider') === 'n8n') set('ai_provider', null);
    await apply();
    return status();
  }

  return { apply, status, saveKey, removeKey, models, saveModel, saveN8n, removeN8n };
}
