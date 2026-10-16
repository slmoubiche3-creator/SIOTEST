// AI engine settings: the Anthropic API key and the chosen model.
// - The key stays on the server (database file, never in Git) and is never
//   sent back to the browser.
// - A key in the environment (ANTHROPIC_API_KEY) always wins and cannot be
//   changed from the UI.
// - A model is only switched on after one test classification succeeds.
import { createAiEngine, createAnthropicClient, listModels } from './analyzer/ai.js';

const TEST_MESSAGE = { body: 'Hello, how do I add a coupon to my order form?' };

const friendly = (err) => {
  if (err.status === 401) return 'Anthropic refused this API key. Check that it was copied entirely.';
  if (err.status === 403) return 'This API key is not allowed to use that model.';
  if (err.status === 404) return 'This model is not available for this API key.';
  if (err.status === 429) return 'Too many requests or no credit left on this API key. Try again later.';
  return err.message;
};
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createAiSettings({ db, env, analyzer, clock, clientFactory = createAnthropicClient }) {
  const get = (key) => db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  const set = (key, value) => (value === null
    ? db.run('DELETE FROM settings WHERE key = ?', key)
    : db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value));

  const envKey = () => Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const keySource = () => (envKey() ? 'environment' : get('anthropic_api_key') ? 'settings' : null);
  const model = () => get('ai_model') ?? env.AI_MODEL ?? null;
  // Environment key: let the SDK read it. Saved key: pass it explicitly.
  const client = (apiKey) => clientFactory(apiKey ?? (envKey() ? undefined : get('anthropic_api_key')));
  let lastError = null;

  async function apply() {
    lastError = null;
    if (env.ANALYZER === 'rules' || !keySource() || !model()) { analyzer.setAi(null); return; }
    try {
      analyzer.setAi(createAiEngine({ client: await client(), model: model() }));
    } catch (err) {
      lastError = err.message;
      analyzer.setAi(null);
    }
  }

  function status() {
    return {
      enabled: analyzer.engine !== 'rules',
      engine: analyzer.engine,
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
      const engine = createAiEngine({ client: await client(), model: chosen });
      const now = clock.now();
      await engine.classify(TEST_MESSAGE, { receivedAt: new Date(now).toISOString(), now });
    } catch (err) {
      throw fail(400, `This model did not work with the tool: ${friendly(err)}`);
    }
    set('ai_model', chosen);
    await apply();
    return status();
  }

  return { apply, status, saveKey, removeKey, models, saveModel };
}
