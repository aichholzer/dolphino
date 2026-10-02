import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { Store } from '../src/lib/store.mjs';
import { createApp } from '../src/app.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { createSettingsStore } from '../src/lib/settings.mjs';
import { createAssistantSettings } from '../src/lib/assistant-settings.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';

const database = readTestPostgresConfig();
const provider = {
  provider: 'bedrock',
  model: '',
  region: 'ap-southeast-2',
  enabled: false,
  accessKeyId: 'AKIASYNTHETICCLASSIFIER',
  secretAccessKey: 'synthetic-classifier-secret'
};
const assistant = { ...provider, accessKeyId: 'AKIASYNTHETICASSISTANT', secretAccessKey: 'synthetic-assistant-secret' };
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
  const settings = createSettingsStore({ pool, appSecret: config.appSecret });
  const assistantSettings = createAssistantSettings({ pool, appSecret: config.appSecret });
  await settings.init();
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
    const app = createApp({ config, store, settings, assistantSettings, auth, simplefin: null, ...overrides });
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
    for (const path of ['/api/settings/provider/models', '/api/settings/assistant/models']) {
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
  'real PostgreSQL/HTTP saves encrypted credentials without model and discovers each separate namespace',
  options,
  async (t) => {
    const f = await fixture(t);
    for (const [namespace, input] of [
      ['provider', provider],
      ['assistant', assistant]
    ]) {
      const saved = await f.request(`/api/settings/${namespace}`, { method: 'PUT', value: input });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.configured, false);
      assert.equal(saved.json.enabled, false);
      assert.match(saved.json.discoveryRevision, /^[a-f0-9]{64}$/);
      assert.equal(saved.json.credentials.accessKeyId.configured, true);
      const found = await f.request(`/api/settings/${namespace}/models`, {
        value: { revision: saved.json.discoveryRevision }
      });
      assert.equal(found.status, 200);
      assert.equal(found.json.revision, saved.json.discoveryRevision);
      assert.equal(found.json.region, input.region);
      assert.equal(found.json.models[0].id, 'provider.synthetic');
      assert.equal(found.json.models[0].compatibility, 'unverified');
      assert.equal(f.calls.at(-1).credentials.accessKeyId, input.accessKeyId);
      assert.equal(f.calls.at(-1).credentials.secretAccessKey, input.secretAccessKey);
      assert.equal(f.calls.at(-1).region, input.region);
      const enabled = await f.request(`/api/settings/${namespace}`, {
        method: 'PUT',
        value: {
          ...input,
          model: 'provider.synthetic',
          enabled: true,
          ...(namespace === 'assistant' ? { dataSharingAcknowledged: true } : {})
        }
      });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.json.configured, true);
      assert.equal(enabled.json.enabled, true);
    }

    const encrypted = JSON.stringify((await f.pool.query('SELECT * FROM encrypted_credentials')).rows);
    assert(!encrypted.includes(provider.secretAccessKey));
    assert(!encrypted.includes(assistant.secretAccessKey));
    assert.equal((await f.settings.getProviderConfig()).llmAccessKeyId, provider.accessKeyId);
    assert.equal((await f.assistantSettings.getRuntimeConfig()).llmAccessKeyId, assistant.accessKeyId);
  }
);

test('real PostgreSQL/HTTP missing, cleared or undecryptable credentials cannot reach AWS', options, async (t) => {
  const f = await fixture(t);
  const missing = await f.settings.getPublicProvider();
  assert.equal(
    (await f.request('/api/settings/provider/models', { value: { revision: missing.discoveryRevision } })).status,
    409
  );
  await f.settings.saveProvider(provider);
  const wrong = createSettingsStore({ pool: f.pool, appSecret: randomBytes(32).toString('base64') });
  const wrongRequest = await f.serve({ settings: wrong });
  const saved = await wrong.getPublicProvider();
  assert.equal(saved.credentialsAvailable, false);
  assert.equal(
    (await wrongRequest('/api/settings/provider/models', { value: { revision: saved.discoveryRevision } })).status,
    409
  );
  const cleared = await f.settings.saveProvider({ ...provider, secretAccessKey: null });
  assert.equal(
    (await f.request('/api/settings/provider/models', { value: { revision: cleared.discoveryRevision } })).status,
    409
  );
  assert.equal(f.calls.length, 0);
});

test(
  'real PostgreSQL/HTTP rejects stale regions, rotation and same-value saves during successful or failed discovery',
  options,
  async (t) => {
    const f = await fixture(t);
    const saved = await f.settings.saveProvider(provider);
    await f.settings.saveProvider({ ...provider, region: 'us-east-1' });
    assert.equal(
      (await f.request('/api/settings/provider/models', { value: { revision: saved.discoveryRevision } })).status,
      409
    );
    assert.equal(f.calls.length, 0);
    for (const fail of [false, true]) {
      const current = await f.settings.saveProvider(provider);
      let changed = false;
      f.setHook(async (command) => {
        if (!changed) {
          changed = true;
          await f.settings.saveProvider({ ...provider, secretAccessKey: 'synthetic-rotated-secret' });
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

    const first = await f.settings.saveProvider({ ...provider, accessKeyId: undefined, secretAccessKey: undefined });
    const second = await f.settings.saveProvider({ ...provider, accessKeyId: undefined, secretAccessKey: undefined });
    assert.notEqual(first.discoveryRevision, second.discoveryRevision);
  }
);

test(
  'real PostgreSQL/HTTP discovery uses a shared five-per-minute limiter across both settings',
  options,
  async (t) => {
    const f = await fixture(t);
    const saved = await f.settings.saveProvider(provider);
    await f.assistantSettings.save(assistant);
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
