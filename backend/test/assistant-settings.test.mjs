import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSettingsStore } from '../src/lib/settings.mjs';
import { createAssistantSettings, assistantSettingsSchema } from '../src/lib/assistant-settings.mjs';
test('assistant settings require explicit sharing and enforce independent hard bounds', () => {
  const base = {
    provider: 'openai',
    model: 'synthetic-model',
    enabled: true,
    dataSharingAcknowledged: true
  };
  assert.equal(assistantSettingsSchema.safeParse(base).success, true);
  for (const patch of [
    { dataSharingAcknowledged: false },
    { dailyRequestsPerUser: 101 },
    { maxToolCalls: 9 },
    { maxRounds: 5 },
    { maxOutputTokens: 2049 },
    { maxOutputTokens: 127 },
    { autoApply: true },
    { provider: 'bedrock', region: 'us-east-1', accessKeyId: 'ASIA_TEMPORARY' },
    { provider: 'bedrock', region: 'not-region' }
  ]) {
    assert.equal(assistantSettingsSchema.safeParse({ ...base, ...patch }).success, false);
  }
});
const database = readTestPostgresConfig();
test(
  'assistant credentials are isolated, atomic, write-only and fail closed without classification fallback',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `assistant_settings_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const key = randomBytes(32).toString('base64');
    const classification = createSettingsStore({
      pool,
      appSecret: key,
      envConfig: { llmApiKey: 'synthetic-env-never-inherit', llmEnabled: true }
    });
    const assistant = createAssistantSettings({ pool, appSecret: key });
    try {
      await classification.init();
      await assistant.init();
      await classification.saveProvider({
        provider: 'openai',
        model: 'classification-only',
        apiKey: 'synthetic-classification-key',
        enabled: true
      });
      assert.equal((await assistant.getRuntimeConfig()).assistantEnabled, false);
      assert.equal((await assistant.getRuntimeConfig()).llmApiKey, '');
      assert.equal((await assistant.getPublic()).configured, false);
      const base = {
        provider: 'openai',
        model: 'assistant-only',
        enabled: true,
        dataSharingAcknowledged: true,
        dailyRequestsPerUser: 7,
        maxToolCalls: 3,
        maxRounds: 2,
        maxOutputTokens: 512
      };
      await assert.rejects(
        assistant.save({
          ...base,
          dataSharingAcknowledged: false,
          apiKey: 'synthetic-assistant-key'
        })
      );
      assert.equal((await assistant.getPublic()).configured, false);
      await assistant.save({ ...base, apiKey: 'synthetic-assistant-key' });
      const runtime = await assistant.getRuntimeConfig();
      assert.equal(runtime.assistantEnabled, true);
      assert.equal(runtime.assistantDailyRequestLimit, 7);
      assert.equal(runtime.assistantMaxToolCalls, 3);
      assert.equal(runtime.assistantMaxRounds, 2);
      assert.equal(runtime.assistantMaxOutputTokens, 512);
      assert.equal(runtime.llmApiKey, 'synthetic-assistant-key');
      assert.equal(runtime.llmAutoClassify, false);
      assert.equal((await classification.getProviderConfig()).llmApiKey, 'synthetic-classification-key');
      assert.equal((await classification.getProviderConfig()).llmModel, 'classification-only');
      const publicText = JSON.stringify(await assistant.getPublic());
      assert.ok(!publicText.includes('synthetic-assistant-key'));
      assert.equal(Object.hasOwn(await assistant.getUserStatus(), 'credentials'), false);
      await assistant.save({ ...base, apiKey: '' });
      assert.equal((await assistant.getRuntimeConfig()).llmApiKey, 'synthetic-assistant-key');
      await assert.rejects(assistant.save({ ...base, apiKey: null }));
      assert.equal((await assistant.getRuntimeConfig()).assistantEnabled, true);
      const wrong = createAssistantSettings({
        pool,
        appSecret: randomBytes(32).toString('base64')
      });
      assert.equal((await wrong.getRuntimeConfig()).assistantEnabled, false);
      assert.equal((await wrong.getRuntimeConfig()).llmApiKey, '');
      assert.equal((await wrong.getPublic()).credentialsAvailable, false);
      // Moving another namespace's encrypted envelope cannot authenticate under assistant AAD.
      await pool.query(
        "UPDATE encrypted_credentials SET ciphertext=(SELECT ciphertext FROM encrypted_credentials WHERE setting='llm.apiKey' AND provider='openai') WHERE setting='assistant.llm.apiKey' AND provider='openai'"
      );
      assert.equal((await assistant.getRuntimeConfig()).assistantEnabled, false);
      await assistant.save({ ...base, apiKey: 'synthetic-replaced' });
      await assistant.save({
        ...base,
        enabled: false,
        dataSharingAcknowledged: false,
        apiKey: null
      });
      assert.equal((await assistant.getPublic()).configured, false);
      assert.equal((await assistant.getRuntimeConfig()).assistantEnabled, false);
      assert.equal((await classification.getProviderConfig()).llmApiKey, 'synthetic-classification-key');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
