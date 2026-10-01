import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSettingsStore } from '../src/settings.js';
import { createAssistantSettings } from '../src/assistant-settings.js';

const database = readTestPostgresConfig();
async function fixture(run) {
  const admin = new pg.Pool(database);
  const schema = `provider_db_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    ...database,
    options: `-c search_path=${schema}`,
    max: 1,
    connectionTimeoutMillis: 1000
  });
  const appSecret = randomBytes(32).toString('base64');
  const store = createSettingsStore({
    pool,
    appSecret,
    envConfig: {
      llmProvider: 'openai',
      llmEnabled: true,
      llmAutoClassify: true,
      llmApiKey: 'synthetic-env-never-use',
      llmModel: 'environment-model',
      llmBaseUrl: 'https://arbitrary.invalid/',
      llmDailyRequestLimit: 999
    },
    allowEnvironmentFallback: true
  });
  try {
    await store.init();
    await run({ pool, appSecret, store });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const base = {
  provider: 'openai',
  model: 'synthetic-model',
  region: '',
  enabled: true,
  autoClassify: false,
  autoApply: false,
  dailyRequestLimit: 12,
  batchSize: 3
};

test(
  'database provider defaults, independent switches, legacy documents and damaged state never fall back to environment',
  { skip: !database },
  async () =>
    fixture(async ({ store, pool, appSecret }) => {
      const fresh = await store.getProviderSnapshot();
      assert.equal(fresh.publicState.source, 'database');
      assert.equal(fresh.publicState.configured, false);
      assert.equal(fresh.config.llmEnabled, false);
      assert.equal(fresh.config.llmAutoClassify, false);
      assert.equal(fresh.config.llmApiKey, '');
      assert.equal(fresh.config.llmModel, '');
      assert.equal(fresh.config.llmDailyRequestLimit, 20);
      await store.saveProvider({ ...base, apiKey: 'synthetic-db-only' });
      assert.equal((await store.getProviderConfig()).llmEnabled, true);
      assert.equal((await store.getProviderConfig()).llmAutoClassify, false);
      assert.equal((await store.getPublicProvider()).region, undefined);
      let stored = await store.getValue('llm');
      assert.equal(Object.hasOwn(stored, 'region'), false);
      assert.equal(stored.autoClassify, false);
      assert.equal((await store.getProviderConfig()).llmDailyRequestLimit, 12);
      assert.equal((await store.getProviderConfig()).llmBatchSize, 3);
      delete stored.autoClassify;
      await store.setValue('llm', stored);
      assert.equal((await store.getPublicProvider()).autoClassify, true);
      assert.equal((await store.getProviderConfig()).llmAutoClassify, true);
      assert.equal(Object.hasOwn(await store.getValue('llm'), 'autoClassify'), false);
      await store.saveProvider({
        ...base,
        enabled: false,
        autoClassify: true,
        apiKey: '   '
      });
      const disabled = await store.getProviderSnapshot();
      assert.equal(disabled.publicState.enabled, false);
      assert.equal(disabled.publicState.autoClassify, true);
      assert.equal(disabled.config.llmEnabled, false);
      assert.equal(disabled.config.llmApiKey, 'synthetic-db-only');
      const wrong = createSettingsStore({
        pool,
        appSecret: randomBytes(32).toString('base64'),
        envConfig: { llmApiKey: 'must-not-use' }
      });
      const unreadable = await wrong.getProviderSnapshot();
      assert.equal(unreadable.publicState.configured, true);
      assert.equal(unreadable.publicState.credentials.apiKey.unreadable, true);
      assert.equal(unreadable.publicState.credentials.apiKey.masked, '••••••••');
      assert.equal(unreadable.config.llmApiKey, '');
      assert.equal(unreadable.config.llmAutoClassify, false);
      assert.equal(unreadable.config.llmEnabled, false);
      assert(!JSON.stringify(unreadable.publicState).includes('synthetic-db-only'));
      // Plaintext and unknown data in a malformed database row must never reach an API response.
      await store.setValue('llm', {
        ...stored,
        apiKey: 'synthetic-plaintext-corruption',
        dailyRequestLimit: 1000000
      });
      const invalid = await store.getProviderSnapshot();
      assert.equal(invalid.publicState.settingsAvailable, false);
      assert.equal(invalid.config.llmEnabled, false);
      assert.equal(invalid.config.llmApiKey, '');
      assert(!JSON.stringify(invalid.publicState).includes('synthetic-plaintext-corruption'));
      // Valid replacement and key rotation remain restart-safe in the existing namespace.
      await store.saveProvider({
        ...base,
        autoClassify: true,
        apiKey: 'synthetic-replaced'
      });
      const restarted = createSettingsStore({ pool, appSecret });
      assert.equal((await restarted.getProviderConfig()).llmApiKey, 'synthetic-replaced');
      await restarted.saveProvider({ ...base, enabled: false, apiKey: null });
      assert.equal((await restarted.getPublicProvider()).configured, false);
      assert.equal((await restarted.getProviderConfig()).llmEnabled, false);
      assert.equal((await restarted.getProviderConfig()).llmApiKey, '');
    })
);

test(
  'one MVCC read prevents classification settings and credential mixtures across concurrent saves',
  { skip: !database },
  async () =>
    fixture(async ({ pool, appSecret, store }) => {
      await store.saveProvider({
        ...base,
        model: 'version-a',
        apiKey: 'synthetic-key-a'
      });
      let calls = 0,
        armed = true;
      const interleavedPool = {
        async query(...args) {
          calls++;
          const result = await pool.query(...args);
          if (armed) {
            armed = false;
            await store.saveProvider({
              ...base,
              model: 'version-b',
              apiKey: 'synthetic-key-b',
              dailyRequestLimit: 17
            });
          }
          return result;
        }
      };
      const reader = createSettingsStore({ pool: interleavedPool, appSecret });
      const first = await reader.getProviderConfig();
      assert.equal(calls, 1, 'runtime settings and all ciphertexts use one database statement');
      assert.equal(first.llmModel, 'version-a');
      assert.equal(first.llmApiKey, 'synthetic-key-a');
      assert.equal(first.llmDailyRequestLimit, 12);
      const second = await reader.getProviderConfig();
      assert.equal(second.llmModel, 'version-b');
      assert.equal(second.llmApiKey, 'synthetic-key-b');
      assert.equal(second.llmDailyRequestLimit, 17);
      armed = true;
      calls = 0;
      const publicState = await reader.getPublicProvider();
      assert.equal(calls, 1, 'public masked status uses the same coherent read');
      assert.equal(publicState.credentials.apiKey.configured, true);
      assert(!JSON.stringify(publicState).includes('synthetic-key'));
    })
);

test(
  'assistant settings, consent, request limits and secrets are read from the same isolated snapshot',
  { skip: !database },
  async () =>
    fixture(async ({ pool, appSecret, store }) => {
      await store.saveProvider({ ...base, apiKey: 'classification-only' });
      const assistant = createAssistantSettings({ pool, appSecret });
      const firstState = {
        provider: 'openai',
        model: 'assistant-a',
        region: '',
        enabled: true,
        dataSharingAcknowledged: true,
        dailyRequestsPerUser: 7,
        maxToolCalls: 3,
        maxRounds: 2,
        maxOutputTokens: 512
      };
      await assistant.save({ ...firstState, apiKey: 'synthetic-assistant-a' });
      let calls = 0,
        armed = true;
      const reader = createAssistantSettings({
        appSecret,
        pool: {
          async query(...args) {
            calls++;
            const result = await pool.query(...args);
            if (armed) {
              armed = false;
              await assistant.save({
                ...firstState,
                model: 'assistant-b',
                dailyRequestsPerUser: 2,
                enabled: false,
                dataSharingAcknowledged: false,
                apiKey: 'synthetic-assistant-b'
              });
            }
            return result;
          }
        }
      });
      const first = await reader.getRuntimeConfig();
      assert.equal(calls, 1);
      assert.equal(first.assistantEnabled, true);
      assert.equal(first.llmModel, 'assistant-a');
      assert.equal(first.llmApiKey, 'synthetic-assistant-a');
      assert.equal(first.assistantDailyRequestLimit, 7);
      const second = await reader.getRuntimeConfig();
      assert.equal(second.assistantEnabled, false);
      assert.equal(second.assistantDataSharingAcknowledged, false);
      assert.equal(second.llmModel, 'assistant-b');
      assert.equal(second.llmApiKey, 'synthetic-assistant-b');
      assert.equal(second.assistantDailyRequestLimit, 2);
      assert.equal((await store.getProviderConfig()).llmApiKey, 'classification-only');
    })
);
