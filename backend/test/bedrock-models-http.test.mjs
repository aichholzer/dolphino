import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { Store } from '../src/lib/store.mjs';
import { createApp } from '../src/app.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { sharedAiSettings } from './helpers/shared-ai.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';

const database = readTestPostgresConfig();
const provider = {
  provider: 'bedrock',
  region: 'ap-southeast-2',
  accessKeyId: 'AKIASYNTHETICCLASSIFIER',
  secretAccessKey: 'synthetic-classifier-secret'
};
const assistant = provider;
const fakeResponse = (command) => {
  if (command instanceof ListFoundationModelsCommand) {
    return {
      modelSummaries: [
        {
          modelId: 'provider.synthetic',
          modelName: 'Synthetic model',
          providerName: 'Synthetic',
          inputModalities: ['TEXT'],
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['ON_DEMAND'],
          modelLifecycle: { status: 'ACTIVE' }
        }
      ]
    };
  }

  assert(command instanceof ListInferenceProfilesCommand, 'no inference, identity, agreement or subscription calls');
  return { inferenceProfileSummaries: [] };
};

async function fixture(t) {
  const adminPool = new pg.Pool(database);
  const schema = `discovery_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}`, connectionTimeoutMillis: 1000 });
  const config = {
    mode: 'live',
    origin: 'https://dolphino.test',
    host: '127.0.0.1',
    port: 0,
    currency: 'AUD',
    timezone: 'Etc/UTC',
    appSecret: randomBytes(32).toString('base64')
  };
  const store = new Store(pool, { mode: 'live' });
  await store.migrate();
  const shared = sharedAiSettings({ pool, appSecret: config.appSecret });
  const { settings, assistantSettings, aiSettings } = shared;
  await settings.init();
  await aiSettings.init();
  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  const cookies = {};
  for (const role of ['admin', 'member']) {
    const user = (
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,$2,'unused') RETURNING id",
        [`${role}@example.test`, role]
      )
    ).rows[0];
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), user.id]
    );
    cookies[role] = `dolphino_session=${token}`;
  }

  const calls = [];
  let hook;
  t.mock.method(BedrockClient.prototype, 'send', async function (command, options) {
    calls.push({
      command: command.constructor.name,
      credentials: await this.config.credentials(),
      region: await this.config.region()
    });
    assert(options.abortSignal instanceof AbortSignal);
    return hook ? hook(command) : fakeResponse(command);
  });
  const servers = [];
  async function serve(overrides = {}) {
    const app = createApp({
      config,
      store,
      settings,
      assistantSettings,
      aiSettings,
      auth,
      simplefin: null,
      ...overrides
    });
    const server = await new Promise((resolve) => {
      const value = app.start(() => resolve(value));
    });
    servers.push(server);
    return async (path, { method = 'POST', value, who = 'admin', origin = config.origin } = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: {
          ...(cookies[who] ? { Cookie: cookies[who] } : {}),
          ...(origin ? { Origin: origin } : {}),
          'Content-Type': 'application/json'
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(value ?? {}) })
      });
      const text = await response.text();
      for (const secret of [
        provider.accessKeyId,
        provider.secretAccessKey,
        assistant.accessKeyId,
        assistant.secretAccessKey
      ]) {
        assert(!text.includes(secret), 'credentials must never be reflected in HTTP responses');
      }

      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, json: JSON.parse(text), headers: response.headers };
    };
  }

  const request = await serve();
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  });
  return {
    ...shared,
    pool,
    config,
    settings,
    assistantSettings,
    calls,
    request,
    serve,
    setHook(value) {
      hook = value;
    }
  };
}

const options = { skip: !database };

test(
  'real PostgreSQL/HTTP discovery is admin-only, exact-Origin protected, strict and demo-disabled',
  options,
  async (t) => {
    const f = await fixture(t);
    for (const path of ['/api/settings/ai/models', '/api/settings/provider/models', '/api/settings/assistant/models']) {
      assert.equal((await f.request(path, { who: 'anonymous' })).status, 401);
      assert.equal((await f.request(path, { who: 'member' })).status, 403);
      assert.equal((await f.request(path, { origin: null })).status, 403);
      assert.equal((await f.request(path, { origin: 'https://evil.test' })).status, 403);
    }

    for (const value of [
      {},
      { revision: 'bad' },
      { revision: 'a'.repeat(64), accessKeyId: 'browser-key' },
      { revision: 'a'.repeat(64), region: 'us-east-1' }
    ]) {
      assert.equal((await f.request('/api/settings/provider/models', { value })).status, 400);
    }

    const demo = await f.serve({ config: { ...f.config, mode: 'demo' } });
    assert.equal((await demo('/api/settings/assistant/models', { value: { revision: 'a'.repeat(64) } })).status, 409);
    assert.equal(f.calls.length, 0);
  }
);

test(
  'real PostgreSQL/HTTP saves credentials once without a model and both feature aliases discover the same provider',
  options,
  async (t) => {
    const f = await fixture(t);
    const current = await f.aiSettings.getPublic();
    const saved = await f.request('/api/settings/ai', {
      method: 'PUT',
      value: { ...provider, revision: current.discoveryRevision }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.configured, true);
    assert.match(saved.json.discoveryRevision, /^[a-f0-9]{64}$/);
    assert.equal(saved.json.credentials.accessKeyId.configured, true);
    for (const namespace of ['ai', 'provider', 'assistant']) {
      const found = await f.request(`/api/settings/${namespace}/models`, {
        value: { revision: saved.json.discoveryRevision }
      });
      assert.equal(found.status, 200);
      assert.equal(found.json.revision, saved.json.discoveryRevision);
      assert.equal(found.json.region, provider.region);
      assert.equal(found.json.models[0].id, 'provider.synthetic');
      assert.equal(found.json.models[0].compatibility, 'unverified');
      assert.equal(f.calls.at(-1).credentials.accessKeyId, provider.accessKeyId);
      assert.equal(f.calls.at(-1).credentials.secretAccessKey, provider.secretAccessKey);
    }

    for (const namespace of ['provider', 'assistant']) {
      const enabled = await f.request(`/api/settings/${namespace}`, {
        method: 'PUT',
        value: {
          aiRevision: saved.json.discoveryRevision,
          model: 'provider.synthetic',
          enabled: true,
          ...(namespace === 'assistant' ? { dataSharingAcknowledged: true } : {})
        }
      });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.json.configured, true);
      assert.equal(enabled.json.enabled, true);
    }

    assert.equal((await f.aiSettings.getPublic()).discoveryRevision, saved.json.discoveryRevision);
    const rows = (await f.pool.query('SELECT * FROM encrypted_credentials')).rows;
    assert.equal(rows.length, 2, 'one shared AWS pair is stored');
    assert(!JSON.stringify(rows).includes(provider.secretAccessKey));
    assert.equal((await f.settings.getProviderConfig()).llmAccessKeyId, provider.accessKeyId);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).llmAccessKeyId, provider.accessKeyId);
  }
);

test('real PostgreSQL/HTTP missing, cleared or undecryptable credentials cannot reach AWS', options, async (t) => {
  const f = await fixture(t);
  const missing = await f.settings.getPublicProvider();
  assert.equal(
    (await f.request('/api/settings/provider/models', { value: { revision: missing.discoveryRevision } })).status,
    409
  );
  await f.saveAi(provider);
  const wrong = sharedAiSettings({ pool: f.pool, appSecret: randomBytes(32).toString('base64') });
  const wrongRequest = await f.serve(wrong);
  const saved = await wrong.aiSettings.getPublic();
  assert.equal(saved.credentialsAvailable, false);
  assert.equal(
    (await wrongRequest('/api/settings/provider/models', { value: { revision: saved.discoveryRevision } })).status,
    409
  );
  const cleared = await f.saveAi({ ...provider, secretAccessKey: null });
  assert.equal(
    (await f.request('/api/settings/provider/models', { value: { revision: cleared.discoveryRevision } })).status,
    409
  );
  assert.equal(f.calls.length, 0);
});

test(
  'real PostgreSQL/HTTP rejects stale regions and rotation while feature-only saves preserve discovery during successful or failed discovery',
  options,
  async (t) => {
    const f = await fixture(t);
    const saved = await f.saveAi(provider);
    await f.saveAi({ ...provider, region: 'us-east-1' });
    assert.equal(
      (await f.request('/api/settings/provider/models', { value: { revision: saved.discoveryRevision } })).status,
      409
    );
    assert.equal(f.calls.length, 0);
    for (const fail of [false, true]) {
      const current = await f.saveAi(provider);
      let changed = false;
      f.setHook(async (command) => {
        if (!changed) {
          changed = true;
          await f.saveAi({ ...provider, secretAccessKey: 'synthetic-rotated-secret' });
        }

        if (fail) {
          throw Object.assign(Error(provider.secretAccessKey), { name: 'AccessDeniedException' });
        }

        return fakeResponse(command);
      });
      const found = await f.request('/api/settings/provider/models', {
        value: { revision: current.discoveryRevision }
      });
      assert.equal(found.status, 409);
      assert.match(found.json.error, /changed while/);
    }

    const first = await f.aiSettings.getPublic();
    await f.saveClassification({ model: 'provider.synthetic', enabled: false });
    await f.saveAssistant({ model: 'provider.synthetic', enabled: false });
    const second = await f.aiSettings.getPublic();
    assert.equal(first.discoveryRevision, second.discoveryRevision);
  }
);

test(
  'real PostgreSQL/HTTP discovery uses a shared five-per-minute limiter across both settings',
  options,
  async (t) => {
    const f = await fixture(t);
    const saved = await f.saveAi(provider);
    const other = await f.assistantSettings.getPublic();
    for (let index = 0; index < 5; index++) {
      const namespace = index % 2 ? 'assistant' : 'provider';
      const revision = index % 2 ? other.discoveryRevision : saved.discoveryRevision;
      assert.equal((await f.request(`/api/settings/${namespace}/models`, { value: { revision } })).status, 200);
    }

    assert.equal(
      (await f.request('/api/settings/assistant/models', { value: { revision: other.discoveryRevision } })).status,
      429
    );
    assert.equal(f.calls.length, 10);
  }
);
