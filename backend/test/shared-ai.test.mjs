import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { sharedAiSettings } from './helpers/shared-ai.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { createAssistantSettings } from '../src/lib/assistant-settings.mjs';
import { Store } from '../src/lib/store.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { createApp } from '../src/app.mjs';
import { createClassificationIntegration } from '../src/lib/classification.mjs';
import { createAssistant } from '../src/lib/assistant.mjs';
import { sendAssistantTurn } from '../src/lib/assistant-provider.mjs';
import { FINANCE_TOOLS, invokeFinanceTool } from '../src/lib/assistant-tools.mjs';
import { validateAndSetGrants } from '../src/lib/access.mjs';

const database = readTestPostgresConfig();
const dbTest = (name, fn) => test(name, { skip: !database, timeout: 30000 }, fn);
const key = 'synthetic-shared-openai-secret';
const classificationInput = {
  model: 'synthetic-classifier',
  enabled: true,
  autoClassify: false,
  autoApply: false
};
const assistantInput = {
  model: 'synthetic-assistant',
  enabled: true,
  dataSharingAcknowledged: true
};
const conflict = (error) => error.status === 409;
const responseText = (text) =>
  Response.json({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
  });
const responseTool = () =>
  Response.json({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        id: 'function-1',
        call_id: 'call-1',
        name: 'finance_accounts',
        arguments: '{"currency":"AUD"}'
      }
    ]
  });
const classificationResponse = () =>
  Response.json({
    choices: [{ message: { content: JSON.stringify({ category: 'Groceries', reason: 'Synthetic suggestion' }) } }]
  });

async function fixture(t, { legacy = false } = {}) {
  const admin = new pg.Pool(database);
  const schema = `shared_ai_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}`, max: 8 });
  const config = {
    mode: 'live',
    host: '127.0.0.1',
    port: 0,
    origin: 'https://dolphino.test',
    timezone: 'Etc/UTC',
    currency: 'AUD',
    appSecret: randomBytes(32).toString('base64'),
    llmApiKey: 'synthetic-env-must-not-use',
    llmEnabled: true
  };
  const store = new Store(pool, config);
  await store.migrate();
  const shared = sharedAiSettings({ pool, appSecret: config.appSecret, envConfig: config });
  await shared.vault.init();
  if (!legacy) {
    await shared.aiSettings.init();
  }

  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  const users = {},
    cookies = {};
  for (const role of ['admin', 'member', 'other']) {
    const user = (
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,$3,'unused') RETURNING id",
        [`${role}@example.invalid`, role, role === 'admin' ? 'admin' : 'member']
      )
    ).rows[0];
    users[role] = user.id;
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), user.id]
    );
    cookies[role] = `dolphino_session=${token}`;
  }

  const outbound = [];
  let hook;
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null };
    outbound.push(call);
    const intercepted = await hook?.(call);
    if (intercepted) {
      return intercepted;
    }

    if (call.url.endsWith('/responses')) {
      return call.body.input.some((item) => item.type === 'function_call_output')
        ? responseText('Synthetic verified account summary')
        : responseTool();
    }

    if (call.url.includes('/models')) {
      return Response.json({ data: [], id: 'synthetic-model' });
    }

    return classificationResponse();
  };

  const classification = createClassificationIntegration({
    pool,
    store,
    config,
    getProviderConfig: shared.settings.getProviderConfig,
    fetchImpl
  });
  await classification.init();
  const assistant = createAssistant({
    getProviderConfig: shared.assistantSettings.getRuntimeConfig,
    sendTurn: (input) => sendAssistantTurn(input, { fetchImpl }),
    invokeTool: invokeFinanceTool,
    tools: FINANCE_TOOLS
  });
  const servers = [];
  const transcript = [];
  async function serve(overrides = {}) {
    const app = createApp({
      store,
      config,
      auth,
      ...shared,
      assistant,
      classification,
      simplefin: null,
      providerDependencies: { fetchImpl },
      integration: { status: async () => ({ configured: false }) },
      ...overrides
    });
    const server = await new Promise((resolve) => {
      const value = app.start(() => resolve(value));
    });
    servers.push(server);
    return async (path, { method = 'GET', value, who = 'admin', origin = config.origin } = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: { ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(origin === null ? {} : { Origin: origin }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) })
      });
      const text = await response.text();
      transcript.push({ path, method, status: response.status, text });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert(!text.includes(key));
      return { status: response.status, json: JSON.parse(text), text };
    };
  }

  const request = await serve();
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const state = async () => ({
    settings: (await pool.query('SELECT key,value,updated_at FROM app_settings ORDER BY key')).rows,
    credentials: (await pool.query('SELECT * FROM encrypted_credentials ORDER BY setting,provider')).rows
  });
  const ingest = async (id = randomUUID()) =>
    store.ingest({
      sourceId: id,
      accountId: id,
      currency: 'AUD',
      date: '2026-09-01',
      description: `Synthetic merchant ${id}`,
      amountMinor: '-1234',
      status: 'posted',
      kind: 'expense'
    });
  return {
    ...shared,
    pool,
    config,
    store,
    users,
    request,
    serve,
    outbound,
    transcript,
    classification,
    assistant,
    state,
    ingest,
    setHook(value) {
      hook = value;
    }
  };
}

dbTest('shared AI HTTP boundary is admin-only, exact-origin, strict, live-only and credentials-only', async (t) => {
  const f = await fixture(t);
  const routes = [
    ['/api/settings/ai', 'GET'],
    ['/api/settings/ai', 'PUT'],
    ['/api/settings/ai/models', 'POST'],
    ['/api/settings/ai/test-connection', 'POST']
  ];
  for (const [path, method] of routes) {
    for (const [who, expected] of [
      ['anonymous', 401],
      ['member', 403]
    ]) {
      assert.equal((await f.request(path, { method, who, value: method === 'GET' ? undefined : {} })).status, expected);
    }

    if (method !== 'GET') {
      for (const origin of [null, 'null', 'https://evil.invalid', `${f.config.origin}.evil.invalid`]) {
        assert.equal((await f.request(path, { method, origin, value: {} })).status, 403);
      }
    }
  }

  const initial = await f.aiSettings.getPublic();
  assert.equal(initial.configured, false);
  assert.equal((await f.settings.getProviderConfig()).llmApiKey, '');
  assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, false);
  const input = { provider: 'openai', apiKey: key, revision: initial.discoveryRevision };
  for (const extra of [{ endpoint: 'http://127.0.0.1/' }, { model: 'forbidden' }, { enabled: true }]) {
    assert.equal((await f.request('/api/settings/ai', { method: 'PUT', value: { ...input, ...extra } })).status, 400);
  }

  const demo = await f.serve({ config: { ...f.config, mode: 'demo' } });
  for (const path of ['/api/settings/ai', '/api/settings/ai/models', '/api/settings/ai/test-connection']) {
    assert.equal(
      (await demo(path, { method: path === '/api/settings/ai' ? 'PUT' : 'POST', value: input })).status,
      409
    );
  }

  const saved = await f.saveAi({ provider: 'openai', apiKey: key });
  assert.equal(saved.configured, true);
  assert.equal((await f.request('/api/settings/ai/test-connection', { method: 'POST', value: {} })).status, 200);
  assert.equal(f.outbound.length, 1);
  assert.equal(f.outbound[0].url, 'https://api.openai.com/v1/models');
  assert.equal(f.outbound[0].options.headers.Authorization, `Bearer ${key}`);
  assert.equal(f.outbound[0].options.body, undefined);
  for (const namespace of ['provider', 'assistant']) {
    for (const illegal of [
      { provider: 'openai' },
      { region: 'us-east-1' },
      { apiKey: key },
      { accessKeyId: 'AKIASYNTHETIC' },
      { secretAccessKey: 'synthetic' }
    ]) {
      assert.equal(
        (
          await f.request(`/api/settings/${namespace}`, {
            method: 'PUT',
            value: { aiRevision: saved.discoveryRevision, model: 'synthetic', ...illegal }
          })
        ).status,
        400
      );
    }
  }
});

dbTest(
  'one credential write is shared by independent feature controls, revision fences, rotation, clear and restart',
  async (t) => {
    const f = await fixture(t);
    const first = await f.saveAi({ provider: 'openai', apiKey: key });
    await f.saveClassification(classificationInput);
    await f.saveAssistant(assistantInput);
    assert.equal((await f.aiSettings.getPublic()).discoveryRevision, first.discoveryRevision);
    assert.equal((await f.settings.getProviderConfig()).llmApiKey, key);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).llmApiKey, key);
    assert.equal((await f.pool.query('SELECT * FROM encrypted_credentials')).rowCount, 1);
    const before = await f.state();
    await assert.rejects(
      f.aiSettings.save({ provider: 'openai', apiKey: 'synthetic-stale', revision: 'a'.repeat(64) }),
      conflict
    );
    assert.deepEqual(await f.state(), before);
    const rotated = await f.saveAi({ provider: 'openai', apiKey: 'synthetic-rotated' });
    assert.notEqual(rotated.discoveryRevision, first.discoveryRevision);
    for (const [save, input] of [
      [f.settings.saveProvider, classificationInput],
      [f.assistantSettings.save, assistantInput]
    ]) {
      await assert.rejects(save({ ...input, aiRevision: first.discoveryRevision }), conflict);
    }

    const classification = await f.settings.getPublicProvider();
    const assistant = await f.assistantSettings.getPublic();
    assert.equal(classification.enabled, false);
    assert.equal(assistant.enabled, false);
    assert.equal(classification.model, classificationInput.model);
    assert.equal(assistant.model, assistantInput.model);
    assert.equal(Object.hasOwn(classification, 'dailyRequestLimit'), false);
    assert.equal(Object.hasOwn(assistant, 'dailyRequestsPerUser'), false);
    await f.saveClassification(classificationInput);
    await f.saveAssistant(assistantInput);
    const restarted = sharedAiSettings({ pool: f.pool, appSecret: f.config.appSecret });
    await restarted.aiSettings.init();
    assert.equal((await restarted.settings.getProviderConfig()).llmApiKey, 'synthetic-rotated');
    assert.equal((await restarted.assistantSettings.getRuntimeConfig()).llmApiKey, 'synthetic-rotated');
    assert.equal((await restarted.assistantSettings.getRuntimeConfig()).assistantEnabled, true);
    await f.saveAi({ provider: 'openai', apiKey: '  ' });
    assert.equal(
      (await f.settings.getProviderConfig()).llmEnabled,
      true,
      'blank secrets preserve the stored credential and feature switches'
    );
    await f.saveAi({ provider: 'openai', apiKey: null });
    assert.equal((await f.settings.getProviderConfig()).llmEnabled, false);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, false);
    assert.equal((await f.aiSettings.getPublic()).configured, false);
    await f.saveAi({
      provider: 'bedrock',
      region: 'us-east-1',
      accessKeyId: 'AKIASYNTHETICSHARED',
      secretAccessKey: 'synthetic-aws-secret'
    });
    assert.equal((await f.settings.getPublicProvider()).model, '');
    assert.equal((await f.assistantSettings.getPublic()).model, '');
    assert.equal((await f.settings.getProviderConfig()).llmAccessKeyId, 'AKIASYNTHETICSHARED');
    assert.equal((await f.assistantSettings.getRuntimeConfig()).llmAccessKeyId, 'AKIASYNTHETICSHARED');
    assert(!JSON.stringify(await f.state()).includes(key));
  }
);

dbTest(
  'compatible readable old profiles migrate once with feature state preserved and only AI rows changed',
  async (t) => {
    const f = await fixture(t, { legacy: true });
    const oldAssistant = createAssistantSettings({ pool: f.pool, appSecret: f.config.appSecret });
    await f.vault.setValue('unrelated.marker', { retained: true });
    await f.vault.saveProvider({ provider: 'openai', ...classificationInput, apiKey: key });
    await oldAssistant.save({ provider: 'openai', ...assistantInput, apiKey: key });
    const financialBefore = (await f.pool.query('SELECT * FROM household_users ORDER BY id')).rows;
    await f.aiSettings.init();
    assert.equal((await f.settings.getProviderConfig()).llmEnabled, true);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, true);
    assert.equal((await f.settings.getProviderConfig()).llmModel, classificationInput.model);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).llmModel, assistantInput.model);
    const rows = (await f.pool.query('SELECT setting,provider FROM encrypted_credentials ORDER BY setting')).rows;
    assert.deepEqual(rows, [{ setting: 'ai.apiKey', provider: 'openai' }]);
    assert.deepEqual(await f.vault.getValue('unrelated.marker'), { retained: true });
    assert.deepEqual((await f.pool.query('SELECT * FROM household_users ORDER BY id')).rows, financialBefore);
    assert.equal(await f.vault.getValue('llm'), null);
    assert.equal(await f.vault.getValue('assistant.llm'), null);
    const migrated = await f.state();
    await f.aiSettings.init();
    await sharedAiSettings({ pool: f.pool, appSecret: f.config.appSecret }).aiSettings.init();
    assert.deepEqual(await f.state(), migrated, 'repeated initialization is a no-op');
  }
);

dbTest('conflicting old profiles remain untouched until an admin selects one readable credential source', async (t) => {
  const f = await fixture(t, { legacy: true });
  await f.vault.saveProvider({ provider: 'openai', ...classificationInput, apiKey: key });
  await createAssistantSettings({ pool: f.pool, appSecret: f.config.appSecret }).save({
    provider: 'openai',
    ...assistantInput,
    apiKey: 'synthetic-other-legacy-key'
  });
  const original = await f.state();
  await f.aiSettings.init();
  const current = await f.aiSettings.getPublic();
  assert.equal(current.migration.status, 'conflict');
  assert.deepEqual(current.migration.sources.map((source) => source.id).sort(), ['assistant', 'classification']);
  assert.deepEqual(await f.state(), original);
  assert.equal((await f.settings.getProviderConfig()).llmEnabled, false);
  assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, false);
  await assert.rejects(f.saveAi({ provider: 'openai' }), conflict);
  assert.deepEqual(await f.state(), original);
  const result = await f.request('/api/settings/ai', {
    method: 'PUT',
    value: { provider: 'openai', revision: current.discoveryRevision, reuseCredentialsFrom: 'classification' }
  });
  assert.equal(result.status, 200, result.text);
  assert.equal((await f.settings.getProviderConfig()).llmApiKey, key);
  assert.equal((await f.assistantSettings.getRuntimeConfig()).llmApiKey, key);
  assert.equal((await f.settings.getProviderConfig()).llmEnabled, false);
  assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, false);
  assert.equal((await f.pool.query("SELECT * FROM encrypted_credentials WHERE setting NOT LIKE 'ai.%'")).rowCount, 0);
});

dbTest('discarded envelopes are never decoded and reentry is atomic with all financial rows preserved', async (t) => {
  const f = await fixture(t, { legacy: true });
  const transaction = await f.ingest();
  await f.vault.setValue('llm', { provider: 'openai', ...classificationInput });
  await f.vault.setValue('assistant.llm', { provider: 'openai', ...assistantInput });
  for (const [setting, v] of [
    ['llm.apiKey', 1],
    ['assistant.llm.apiKey', 2]
  ]) {
    await f.pool.query("INSERT INTO encrypted_credentials(setting,provider,ciphertext) VALUES($1,'openai',$2)", [
      setting,
      {
        v,
        nonce: randomBytes(12).toString('base64'),
        tag: randomBytes(16).toString('base64'),
        data: randomBytes(32).toString('base64'),
        ...(v === 2 ? { salt: randomBytes(32).toString('base64') } : {})
      }
    ]);
  }

  const old = await f.state();
  await f.aiSettings.init();
  const state = await f.aiSettings.getPublic();
  assert.equal(state.migration.status, 'credentials-unavailable');
  assert.deepEqual(await f.state(), old);
  await assert.rejects(f.saveAi({ provider: 'openai', reuseCredentialsFrom: 'classification' }), conflict);
  assert.deepEqual(await f.state(), old);
  await f.saveAi({ provider: 'openai', apiKey: key });
  assert.equal((await f.settings.getProviderConfig()).llmApiKey, key);
  assert.equal((await f.assistantSettings.getRuntimeConfig()).llmApiKey, key);
  assert.equal((await f.store.getTransaction(transaction.id)).amountMinor, '-1234');
  assert(
    (await f.pool.query('SELECT ciphertext FROM encrypted_credentials')).rows.every((row) => row.ciphertext.v === 3)
  );
});

dbTest(
  'database rejection rolls back shared metadata, credential and both features without partial disablement',
  async (t) => {
    const f = await fixture(t);
    await f.saveAi({ provider: 'openai', apiKey: key });
    await f.saveClassification(classificationInput);
    await f.saveAssistant(assistantInput);
    const before = await f.state();
    await f.pool.query(
      "CREATE FUNCTION reject_shared_secret() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.setting LIKE 'ai.%' THEN RAISE EXCEPTION 'synthetic write failure'; END IF; RETURN NEW; END $$"
    );
    await f.pool.query(
      'CREATE TRIGGER reject_shared_secret BEFORE INSERT OR UPDATE ON encrypted_credentials FOR EACH ROW EXECUTE FUNCTION reject_shared_secret()'
    );
    await assert.rejects(f.saveAi({ provider: 'openai', apiKey: 'synthetic-rejected' }));
    assert.deepEqual(await f.state(), before);
    assert.equal((await f.settings.getProviderConfig()).llmEnabled, true);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, true);
    await f.pool.query('DROP TRIGGER reject_shared_secret ON encrypted_credentials');
  }
);

dbTest(
  'both runtime adapters read one coherent PostgreSQL snapshot during concurrent connection and feature saves',
  async (t) => {
    const f = await fixture(t);
    await f.saveAi({ provider: 'openai', apiKey: key });
    await f.saveClassification(classificationInput);
    await f.saveAssistant(assistantInput);
    for (const feature of ['classification', 'assistant']) {
      await f.saveAi({ provider: 'openai', apiKey: key });
      await f.saveClassification(classificationInput);
      await f.saveAssistant(assistantInput);
      let calls = 0;
      const reader = sharedAiSettings({
        appSecret: f.config.appSecret,
        pool: {
          async query(...args) {
            calls++;
            const result = await f.pool.query(...args);
            if (calls === 1) {
              await f.saveAi({ provider: 'openai', apiKey: 'synthetic-next-key' });
              await f.saveClassification({ ...classificationInput, model: 'next-classifier' });
              await f.saveAssistant({ ...assistantInput, model: 'next-assistant' });
            }

            return result;
          }
        }
      });
      const read =
        feature === 'classification' ? reader.settings.getProviderConfig : reader.assistantSettings.getRuntimeConfig;
      const first = await read();
      assert.equal(calls, 1, 'metadata and shared ciphertext use a single database statement');
      assert.equal(first.llmApiKey, key);
      assert.equal(first.llmModel, feature === 'classification' ? classificationInput.model : assistantInput.model);
      const second = await read();
      assert.equal(second.llmApiKey, 'synthetic-next-key');
      assert.equal(second.llmModel, feature === 'classification' ? 'next-classifier' : 'next-assistant');
    }
  }
);

dbTest(
  'classification records its cutoff once in the household zone and older settings date it from their last save',
  async (t) => {
    const f = await fixture(t);
    await f.saveAi({ provider: 'openai', apiKey: key });
    const at = (instant) =>
      sharedAiSettings({
        pool: f.pool,
        appSecret: f.config.appSecret,
        timezone: 'Australia/Brisbane',
        now: () => new Date(instant)
      });
    const first = at('2026-10-06T22:30:00Z');
    const save = (shared, input) => shared.saveClassification({ ...classificationInput, ...input });
    assert.equal((await save(first, { autoClassify: false })).classifyFrom, '');
    assert.equal((await save(first, { autoClassify: true })).classifyFrom, '2026-10-07');
    const later = at('2026-12-01T00:00:00Z');
    assert.equal((await save(later, { autoClassify: true, includeHistory: true })).classifyFrom, '2026-10-07');
    const runtime = await later.settings.getProviderConfig();
    assert.equal(runtime.llmClassifyFrom, '2026-10-07');
    assert.equal(runtime.llmIncludeHistory, true);
    await assert.rejects(save(later, { classifyFrom: '2020-01-01' }), (error) => error.status === 400);

    // A document from before the cutoff existed, still holding the removed limits.
    await f.pool.query(
      `UPDATE app_settings SET value=(value - 'classifyFrom' - 'includeHistory') || '{"dailyRequestLimit":12,"batchSize":3}'::jsonb,
        updated_at='2026-05-04T15:00:00Z' WHERE key='ai.classification'`
    );
    const legacy = await later.settings.getProviderConfig();
    assert.equal(legacy.llmEnabled, true);
    assert.equal(legacy.llmClassifyFrom, '2026-05-05');
    assert.equal(legacy.llmIncludeHistory, false);
    assert.equal(Object.hasOwn(legacy, 'llmDailyRequestLimit'), false);
    assert.equal((await save(later, { autoClassify: true })).classifyFrom, '2026-05-05');
    const stored = (await f.pool.query(`SELECT value FROM app_settings WHERE key='ai.classification'`)).rows[0].value;
    assert.equal(stored.classifyFrom, '2026-05-05');
    assert.equal(Object.hasOwn(stored, 'dailyRequestLimit'), false);
  }
);

dbTest('assistant settings saved with the removed limit fields stay enabled and save again', async (t) => {
  const f = await fixture(t);
  await f.saveAi({ provider: 'openai', apiKey: key });
  await f.saveAssistant(assistantInput);
  await f.pool.query(
    `UPDATE app_settings SET value = value || '{"dailyRequestsPerUser":7,"maxToolCalls":3,"maxRounds":2,"maxOutputTokens":512}'::jsonb WHERE key='ai.assistant'`
  );
  const runtime = await f.assistantSettings.getRuntimeConfig();
  assert.equal(runtime.assistantEnabled, true);
  assert.equal(runtime.llmModel, assistantInput.model);
  for (const field of [
    'assistantDailyRequestLimit',
    'assistantMaxToolCalls',
    'assistantMaxRounds',
    'assistantMaxOutputTokens'
  ]) {
    assert.equal(Object.hasOwn(runtime, field), false, field);
  }

  await f.saveAssistant({ ...assistantInput, model: 'next-assistant' });
  const stored = (await f.pool.query(`SELECT value FROM app_settings WHERE key='ai.assistant'`)).rows[0].value;
  assert.equal(stored.model, 'next-assistant');
  assert.equal(Object.hasOwn(stored, 'dailyRequestsPerUser'), false);
});

dbTest(
  'one saved key powers actual classification and assistant requests while grants and chats remain user-scoped',
  async (t) => {
    const f = await fixture(t);
    const visible = await f.ingest('visible-account');
    await f.ingest('private-account');
    await f.store.atomic(
      (client) =>
        validateAndSetGrants(
          client,
          f.users.member,
          { accounts: [{ accountId: 'visible-account', access: 'view' }] },
          { mode: 'live' }
        ),
      { refresh: false }
    );
    await f.saveAi({ provider: 'openai', apiKey: key });
    await f.saveClassification(classificationInput);
    await f.saveAssistant(assistantInput);
    const suggestion = await f.request(`/api/transactions/${visible.id}/suggest`, { method: 'POST', value: {} });
    assert.equal(suggestion.status, 200, suggestion.text);
    const chat = await f.request('/api/assistant/chats', { method: 'POST', value: {}, who: 'member' });
    assert.equal(chat.status, 200, chat.text);
    const answer = await f.request(`/api/assistant/chats/${chat.json.id}/messages`, {
      method: 'POST',
      who: 'member',
      value: { message: 'Show my accounts' }
    });
    assert.equal(answer.status, 200, answer.text);
    assert(f.outbound.some((call) => call.url.endsWith('/chat/completions')));
    const assistantCalls = f.outbound.filter((call) => call.url.endsWith('/responses'));
    assert.equal(assistantCalls.length, 2);
    assert(f.outbound.every((call) => call.options.headers.Authorization === `Bearer ${key}`));
    const financeInput = assistantCalls[1].body.input.find((item) => item.type === 'function_call_output');
    assert(financeInput.output.includes('visible-account'));
    assert(!financeInput.output.includes('private-account'));
    assert.equal((await f.request(`/api/assistant/chats/${chat.json.id}`, { who: 'other' })).status, 403);
    assert.equal((await f.request('/api/settings/ai', { who: 'member' })).status, 403);
    const status = await f.request('/api/assistant/status', { who: 'member' });
    assert.equal(status.status, 200);
    assert.equal(Object.hasOwn(status.json, 'credentials'), false);
  }
);

dbTest('disabled shared features perform no financial data queries or outbound provider calls', async (t) => {
  const f = await fixture(t);
  const tx = await f.ingest();
  await f.saveAi({ provider: 'openai', apiKey: key });
  await f.saveClassification({ ...classificationInput, enabled: false });
  await f.saveAssistant({ ...assistantInput, enabled: false });
  const financialQueries = [];
  const original = f.pool.query.bind(f.pool);
  f.pool.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (/\b(?:FROM|JOIN)\s+(?:transactions|accounts|budgets)\b/i.test(sql)) {
      financialQueries.push(sql);
    }

    return original(...args);
  };

  try {
    await f.classification.tick();
    await assert.rejects(f.classification.suggest(tx.id), conflict);
    const chat = await f.request('/api/assistant/chats', { method: 'POST', value: {} });
    assert.equal(chat.status, 200);
    const answer = await f.request(`/api/assistant/chats/${chat.json.id}/messages`, {
      method: 'POST',
      value: { message: 'Read my finances' }
    });
    assert.equal(answer.status, 409);
    assert.deepEqual(financialQueries, []);
    assert.equal(f.outbound.length, 0);
  } finally {
    f.pool.query = original;
  }
});

dbTest(
  'rotation or clearing during classification cannot publish a stale suggestion or apply its category',
  async (t) => {
    for (const clear of [false, true]) {
      const f = await fixture(t);
      await f.saveAi({ provider: 'openai', apiKey: key });
      const tx = await f.ingest();
      await f.saveClassification({ ...classificationInput, autoClassify: true, autoApply: true, includeHistory: true });
      let started, release;
      const ready = new Promise((resolve) => {
        started = resolve;
      });
      f.setHook(async (call) => {
        if (call.url.endsWith('/chat/completions')) {
          started();
          await new Promise((resolve) => {
            release = resolve;
          });
          return classificationResponse();
        }
      });
      const pending = f.classification.tick();
      await ready;
      await f.saveAi({ provider: 'openai', apiKey: clear ? null : 'synthetic-rotated-key' });
      release();
      await pending;
      const after = await f.store.getTransaction(tx.id);
      assert.equal(after.category, 'Uncategorized');
      const jobs = (
        await f.pool.query('SELECT status,result FROM classification_jobs WHERE transaction_id=$1', [tx.id])
      ).rows;
      assert(jobs.length > 0);
      assert(jobs.every((job) => job.status !== 'succeeded' && job.result === null));
      assert.equal(
        (
          await f.pool.query("SELECT * FROM audit_history WHERE transaction_id=$1 AND action='llm-classification'", [
            tx.id
          ])
        ).rowCount,
        0
      );
      if (clear) {
        assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, false);
      }

      f.setHook(null);
    }
  }
);

dbTest(
  'rotation or clearing during assistant execution prevents the next tool and hides the stale response',
  async (t) => {
    const f = await fixture(t);
    await f.ingest();
    for (const clear of [false, true]) {
      await f.saveAi({ provider: 'openai', apiKey: key });
      await f.saveAssistant(assistantInput);
      let started, release;
      const ready = new Promise((resolve) => {
        started = resolve;
      });
      f.setHook(async (call) => {
        if (call.url.endsWith('/responses')) {
          started();
          await new Promise((resolve) => {
            release = resolve;
          });
          return responseTool();
        }
      });
      const chat = await f.request('/api/assistant/chats', { method: 'POST', value: {} });
      const financialQueries = [];
      const original = f.pool.query.bind(f.pool);
      f.pool.query = (...args) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
        if (/\b(?:FROM|JOIN)\s+(?:transactions|accounts|budgets)\b/i.test(sql)) {
          financialQueries.push(sql);
        }

        return original(...args);
      };

      try {
        const before = f.outbound.length;
        const pending = f.request(`/api/assistant/chats/${chat.json.id}/messages`, {
          method: 'POST',
          value: { message: 'Read my accounts' }
        });
        await ready;
        await f.saveAi({ provider: 'openai', apiKey: clear ? null : 'synthetic-rotated-key' });
        release();
        const response = await pending;
        assert.equal(response.status, 409, response.text);
        assert(!response.text.includes('Synthetic verified account summary'));
        assert.equal(f.outbound.length, before + 1, 'no second model request after shared identity changed');
        assert.deepEqual(financialQueries, [], 'the first tool is fenced before querying financial data');
        const history = await f.request(`/api/assistant/chats/${chat.json.id}`);
        assert.equal(history.status, 404);
      } finally {
        f.pool.query = original;
        f.setHook(null);
      }
    }
  }
);

dbTest(
  'orphaned and inactive-provider old credentials require explicit resolution without destructive startup cleanup',
  async (t) => {
    for (const orphan of [true, false]) {
      const f = await fixture(t, { legacy: true });
      if (orphan) {
        await f.vault.setSecret('assistant.llm.apiKey', 'openai', key);
      } else {
        await f.vault.saveProvider({ provider: 'openai', ...classificationInput, apiKey: key });
        await f.vault.setSecret('llm.accessKeyId', 'bedrock', 'AKIASYNTHETICINACTIVE');
        await f.vault.setSecret('llm.secretAccessKey', 'bedrock', 'synthetic-inactive-secret');
      }

      const before = await f.state();
      await f.aiSettings.init();
      assert.equal((await f.aiSettings.getPublic()).migration.status, 'conflict');
      assert.deepEqual(await f.state(), before);
      await assert.rejects(f.saveAi({ provider: 'openai' }), conflict);
      assert.deepEqual(await f.state(), before);
      await f.saveAi({ provider: 'openai', apiKey: null });
      assert.equal((await f.aiSettings.getPublic()).migration.status, 'ready');
      assert.equal((await f.aiSettings.getPublic()).configured, false);
      assert.equal((await f.pool.query('SELECT * FROM encrypted_credentials')).rowCount, 0);
    }
  }
);

async function waitForAdvisoryWaiter(pool, key) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1::oid AND NOT granted",
      [key]
    );
    if (result.rowCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(`Expected a database transaction waiting for advisory lock ${key}`);
}

dbTest('classification keeps the shared credential lock through category, audit and result commit', async (t) => {
  const f = await fixture(t);
  const tx = await f.ingest();
  await f.saveAi({ provider: 'openai', apiKey: key });
  await f.saveClassification({ ...classificationInput, autoClassify: true, autoApply: true, includeHistory: true });
  const barrier = 17092382;
  await f.pool.query(
    `CREATE FUNCTION hold_classification_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(${barrier}); END IF; RETURN NEW; END $$`
  );
  await f.pool.query(
    'CREATE TRIGGER hold_classification_result BEFORE UPDATE ON classification_jobs FOR EACH ROW EXECUTE FUNCTION hold_classification_result()'
  );
  const blocker = await f.pool.connect();
  let classify, save;
  let saved = false;
  try {
    await blocker.query('SELECT pg_advisory_lock($1)', [barrier]);
    classify = f.classification.tick();
    await waitForAdvisoryWaiter(f.pool, barrier);
    save = f.saveAi({ provider: 'openai', apiKey: 'synthetic-concurrent-rotation' }).then((result) => {
      saved = true;
      return result;
    });
    await waitForAdvisoryWaiter(f.pool, 17092381);
    assert.equal(saved, false, 'rotation must wait until the classification result transaction commits');
    assert.equal(
      (await f.store.getTransaction(tx.id)).category,
      'Uncategorized',
      'category changes are not externally visible before job result commit'
    );
    assert.equal(
      (
        await f.pool.query("SELECT * FROM audit_history WHERE transaction_id=$1 AND action='llm-classification'", [
          tx.id
        ])
      ).rowCount,
      0
    );
    await blocker.query('SELECT pg_advisory_unlock($1)', [barrier]);
    await classify;
    await save;
    assert.equal((await f.store.getTransaction(tx.id)).category, 'Groceries');
    assert.equal(
      (await f.pool.query("SELECT * FROM classification_jobs WHERE transaction_id=$1 AND status='succeeded'", [tx.id]))
        .rowCount,
      1
    );
    assert.equal((await f.settings.getProviderConfig()).llmEnabled, false);
    assert.equal((await f.settings.getProviderConfig()).llmApiKey, 'synthetic-concurrent-rotation');
  } finally {
    await blocker.query('SELECT pg_advisory_unlock($1)', [barrier]);
    blocker.release();
    await Promise.allSettled([classify, save].filter(Boolean));
  }
});

dbTest('a rejected classification result commit rolls back category, audit and budget alerts together', async (t) => {
  const f = await fixture(t);
  const tx = await f.ingest();
  await f.store.saveBudget({ category: 'Groceries', currency: 'AUD', month: '2026-09', capMinor: '100' });
  await f.saveAi({ provider: 'openai', apiKey: key });
  await f.saveClassification({ ...classificationInput, autoClassify: true, autoApply: true, includeHistory: true });
  await f.pool.query(
    "CREATE FUNCTION reject_classification_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'synthetic result write failure'; END IF; RETURN NEW; END $$"
  );
  await f.pool.query(
    'CREATE TRIGGER reject_classification_result BEFORE UPDATE ON classification_jobs FOR EACH ROW EXECUTE FUNCTION reject_classification_result()'
  );
  await f.classification.tick();
  assert.equal((await f.store.getTransaction(tx.id)).category, 'Uncategorized');
  assert.equal(
    (await f.pool.query("SELECT * FROM audit_history WHERE transaction_id=$1 AND action='llm-classification'", [tx.id]))
      .rowCount,
    0
  );
  assert.equal((await f.pool.query('SELECT * FROM budget_alerts WHERE resolved_at IS NULL')).rowCount, 0);
  const job = (await f.pool.query('SELECT status,result FROM classification_jobs WHERE transaction_id=$1', [tx.id]))
    .rows[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.result, null);
  assert.equal(f.outbound.length, 1);
});

dbTest(
  'legacy OpenAI profiles ignore irrelevant AWS regions when migrating one or two matching credentials',
  async (t) => {
    for (const includeAssistant of [false, true]) {
      const f = await fixture(t, { legacy: true });
      await f.vault.saveProvider({ provider: 'openai', region: 'us-east-1', ...classificationInput, apiKey: key });
      if (includeAssistant) {
        await createAssistantSettings({ pool: f.pool, appSecret: f.config.appSecret }).save({
          provider: 'openai',
          region: 'ap-southeast-2',
          ...assistantInput,
          apiKey: key
        });
      }

      await f.aiSettings.init();
      const state = await f.aiSettings.getPublic();
      assert.equal(state.migration.status, 'ready');
      assert.equal(state.configured, true);
      assert.equal(state.settingsAvailable, true);
      assert.equal(Object.hasOwn(state, 'region'), false);
      assert.equal((await f.settings.getProviderConfig()).llmEnabled, true);
      assert.equal((await f.settings.getProviderConfig()).llmApiKey, key);
      if (includeAssistant) {
        assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, true);
        assert.equal((await f.assistantSettings.getRuntimeConfig()).llmApiKey, key);
      }

      assert.equal((await f.pool.query('SELECT * FROM encrypted_credentials')).rowCount, 1);
    }
  }
);

dbTest(
  'legacy AWS partial pairs and conflicting providers or regions never silently combine or pick credentials',
  async (t) => {
    for (const mismatch of ['partial', 'provider', 'region']) {
      const f = await fixture(t, { legacy: true });
      const aws = { provider: 'bedrock', region: 'us-east-1', model: 'synthetic-aws-model', enabled: false };
      if (mismatch === 'partial') {
        await f.vault.saveProvider({ ...aws, accessKeyId: 'AKIASYNTHETICPARTIAL' });
        await createAssistantSettings({ pool: f.pool, appSecret: f.config.appSecret }).save({
          ...aws,
          secretAccessKey: 'synthetic-other-half'
        });
      } else {
        await f.vault.saveProvider({
          ...aws,
          accessKeyId: 'AKIASYNTHETICCOMPLETE',
          secretAccessKey: 'synthetic-aws-secret'
        });
        await createAssistantSettings({ pool: f.pool, appSecret: f.config.appSecret }).save(
          mismatch === 'provider'
            ? { provider: 'openai', ...assistantInput, apiKey: key }
            : {
                ...aws,
                region: 'ap-southeast-2',
                accessKeyId: 'AKIASYNTHETICCOMPLETE',
                secretAccessKey: 'synthetic-aws-secret'
              }
        );
      }

      const original = await f.state();
      await f.aiSettings.init();
      assert.equal(
        (await f.aiSettings.getPublic()).migration.status,
        mismatch === 'partial' ? 'credentials-unavailable' : 'conflict'
      );
      assert.deepEqual(await f.state(), original);
      assert.equal((await f.settings.getProviderConfig()).llmEnabled, false);
      assert.equal((await f.assistantSettings.getRuntimeConfig()).assistantEnabled, false);
      await assert.rejects(
        f.saveAi({ provider: 'bedrock', region: 'us-east-1', accessKeyId: 'AKIASYNTHETICREENTRY' }),
        conflict
      );
      assert.deepEqual(await f.state(), original);
    }
  }
);

dbTest(
  'Bedrock profile and availability replies cannot launch another control or inference request after shared rotation',
  async (t) => {
    const { BedrockClient } = await import('@aws-sdk/client-bedrock');
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    let active;
    t.mock.method(BedrockClient.prototype, 'send', async function (command) {
      active.control.push(command.constructor.name);
      assert.equal((await this.config.credentials()).accessKeyId, 'AKIASYNTHETICSHARED');
      const held =
        active.stage === 'profile'
          ? command.constructor.name === 'GetInferenceProfileCommand'
          : command.constructor.name === 'GetFoundationModelAvailabilityCommand';
      if (held) {
        active.started();
        await new Promise((resolve) => {
          active.release = resolve;
        });
      }

      if (command.constructor.name === 'GetInferenceProfileCommand') {
        if (active.stage === 'profile') {
          return {
            status: 'ACTIVE',
            models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/synthetic-model' }]
          };
        }

        throw Object.assign(Error('Synthetic foundation model'), { name: 'ResourceNotFoundException' });
      }

      return {
        authorizationStatus: 'AUTHORIZED',
        entitlementAvailability: 'AVAILABLE',
        regionAvailability: 'AVAILABLE',
        agreementAvailability: { status: 'AVAILABLE' }
      };
    });
    t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => {
      active.inference++;
      throw Error('Inference after shared rotation must be blocked');
    });
    for (const feature of ['classification', 'assistant']) {
      for (const stage of ['profile', 'availability']) {
        const f = await fixture(t);
        const tx = await f.ingest();
        await f.saveAi({
          provider: 'bedrock',
          region: 'us-east-1',
          accessKeyId: 'AKIASYNTHETICSHARED',
          secretAccessKey: 'synthetic-aws-secret'
        });
        await f.saveClassification({ ...classificationInput, model: 'synthetic-model' });
        await f.saveAssistant({ ...assistantInput, model: 'synthetic-model' });
        active = { stage, control: [], inference: 0 };
        const ready = new Promise((resolve) => {
          active.started = resolve;
        });
        let pending;
        if (feature === 'classification') {
          pending = f.classification.suggest(tx.id).then(
            () => ({ status: 200 }),
            (error) => ({ status: error.status })
          );
        } else {
          const chat = await f.request('/api/assistant/chats', { method: 'POST', value: {} });
          pending = f.request(`/api/assistant/chats/${chat.json.id}/messages`, {
            method: 'POST',
            value: { message: 'Show my accounts' }
          });
        }

        await ready;
        await f.saveAi({ provider: 'bedrock', region: 'us-east-1', secretAccessKey: 'synthetic-rotated-aws-secret' });
        active.release();
        const response = await pending;
        assert([409, 503].includes(response.status), `${feature} ${stage}: ${response.status}`);
        assert.equal(active.inference, 0, `${feature} must fence Converse dispatch after ${stage}`);
        assert.deepEqual(
          active.control,
          stage === 'profile'
            ? ['GetInferenceProfileCommand']
            : ['GetInferenceProfileCommand', 'GetFoundationModelAvailabilityCommand']
        );
        assert.equal(f.outbound.length, 0);
        assert.equal((await f.store.getTransaction(tx.id)).category, 'Uncategorized');
      }
    }
  }
);
