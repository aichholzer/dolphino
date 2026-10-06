import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.mjs';
import { createSettingsStore } from '../src/lib/settings.mjs';
import { createAssistantSettings } from '../src/lib/assistant-settings.mjs';
import { createAssistant } from '../src/lib/assistant.mjs';
import { createClassificationIntegration } from '../src/lib/classification.mjs';
import { createRedbarkSettings } from '../src/lib/redbark-settings.mjs';
import { createRedbarkIntegration } from '../src/lib/worker.mjs';
import { createSimplefinIntegration } from '../src/lib/simplefin.mjs';
import { createNotificationIntegration } from '../src/lib/notifications.mjs';
import { createTelegramPairing } from '../src/lib/telegram.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { Store } from '../src/lib/store.mjs';
import { createApp } from '../src/app.mjs';

const database = readTestPostgresConfig();
const masterSecret = () => randomBytes(32).toString('base64');
const conflict = (error) => error.status === 409;
const preservedTables = [
  'accounts',
  'transactions',
  'source_aliases',
  'provider_observations',
  'transaction_overrides',
  'audit_history',
  'budgets',
  'rules',
  'household_users',
  'household_sessions'
];

// Deliberately opaque fixtures: discarded protocol versions need no old keys,
// branded domains, or actual credentials in order to exercise recovery.
function discardedEnvelope(version) {
  return {
    v: version,
    nonce: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    data: randomBytes(32).toString('base64'),
    ...(version === 2 ? { salt: randomBytes(32).toString('base64') } : {})
  };
}

async function snapshot(pool, tables) {
  const result = {};

  for (const table of tables) {
    result[table] = (
      await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
    ).rows;
  }

  return result;
}

async function insertDiscarded(pool, setting, provider, version) {
  await pool.query('INSERT INTO encrypted_credentials(setting,provider,ciphertext) VALUES($1,$2,$3)', [
    setting,
    provider,
    discardedEnvelope(version)
  ]);
}

async function fixture(t) {
  const admin = new pg.Pool(database);
  const schema = `credential_recovery_${randomUUID().replaceAll('-', '')}`;

  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}` });
  const cleanup = [];

  t.after(async () => {
    for (const close of cleanup.reverse()) {
      await close();
    }

    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const config = {
    mode: 'live',
    appSecret: masterSecret(),
    host: '127.0.0.1',
    port: 0,
    origin: 'https://dolphino.example.invalid',
    timezone: 'Etc/UTC',
    llmApiKey: 'synthetic-environment-fallback-must-not-run',
    llmEnabled: true,
    llmAutoClassify: true,
    llmAutoApply: true,
    redbarkApiKey: 'synthetic-environment-redbark-must-not-run'
  };
  const store = new Store(pool, config);
  const settings = createSettingsStore({ pool, appSecret: config.appSecret, envConfig: config });
  const auth = createHouseholdAuth({ pool, config });

  await store.migrate();
  await settings.init();
  await auth.init();
  await store.ingestBatch({
    account: { id: 'recovery-account', name: 'Recovery account', currency: 'AUD' },
    fetchedAt: '2026-09-01T00:00:00.000Z',
    transactions: [
      {
        sourceId: 'recovery-observation',
        accountId: 'recovery-account',
        currency: 'AUD',
        date: '2026-09-01',
        description: 'Synthetic recovery purchase',
        amountMinor: '-12345',
        status: 'posted'
      }
    ]
  });

  const transaction = (await store.listTransactions())[0];

  await pool.query('INSERT INTO transaction_overrides(transaction_id,note) VALUES($1,$2)', [
    transaction.id,
    'Keep this synthetic manual note'
  ]);
  await pool.query(
    "INSERT INTO budgets(id,mode,category,currency,month,cap_minor) VALUES($1,'live','Groceries','AUD','2026-09',40000)",
    [randomUUID()]
  );
  await pool.query("INSERT INTO rules(id,mode,contains,category) VALUES($1,'live','Synthetic rule','Groceries')", [
    randomUUID()
  ]);

  const user = (
    await pool.query(
      "INSERT INTO household_users(email,name,role,password_hash) VALUES('recovery@example.invalid','Recovery admin','admin','synthetic-unused-hash') RETURNING id"
    )
  ).rows[0];
  const token = randomBytes(32).toString('base64url');

  await pool.query(
    "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [createHash('sha256').update(token).digest('hex'), user.id]
  );
  await settings.setValue('recovery.marker', { retained: true });

  const originalData = await snapshot(pool, preservedTables);
  const unchanged = async () => assert.deepEqual(await snapshot(pool, preservedTables), originalData);
  const credentials = () => snapshot(pool, ['encrypted_credentials']);
  const state = () => snapshot(pool, ['app_settings', 'encrypted_credentials']);
  const api = async (dependencies = {}) => {
    const app = createApp({ store, settings, auth, config, ...dependencies });
    const server = await new Promise((resolve) => {
      const running = app.start(() => resolve(running));
    });

    cleanup.push(() => new Promise((resolve) => server.close(resolve)));

    return async (path, method = 'GET', value) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: {
          Cookie: `dolphino_session=${token}`,
          Origin: config.origin,
          'Content-Type': 'application/json'
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) })
      });
      const text = await response.text();

      return { status: response.status, text, value: JSON.parse(text) };
    };
  };

  return { pool, config, store, settings, auth, user, transaction, unchanged, credentials, state, api, cleanup };
}

test('v3 independently decrypts with Dolphino HKDF/AAD while discarded versions and cross-slot reuse reject safely', () => {
  const secret = masterSecret();
  const plaintext = 'synthetic-current-protocol-secret';
  const envelope = encryptSecret(plaintext, secret, 'llm.apiKey', 'openai');

  assert.equal(envelope.v, 3);
  assert.equal(Buffer.from(envelope.salt, 'base64').length, 32);
  assert.equal(Buffer.from(envelope.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);

  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(envelope.salt, 'base64'),
      Buffer.from('dolphino/settings/key/v3/AES-256-GCM credential encryption'),
      32
    )
  );
  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(envelope.nonce, 'base64'));

  decipher.setAAD(Buffer.from(JSON.stringify(['dolphino-credential', 3, 'llm.apiKey', 'openai'])));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  assert.equal(
    Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'),
    plaintext
  );

  const fresh = encryptSecret(plaintext, secret, 'llm.apiKey', 'openai');

  assert.notEqual(fresh.nonce, envelope.nonce);
  assert.notEqual(fresh.salt, envelope.salt);

  for (const rejected of [discardedEnvelope(1), discardedEnvelope(2), ...[1, 2].map((v) => ({ ...envelope, v }))]) {
    assert.throws(
      () => decryptSecret(rejected, secret, 'llm.apiKey', 'openai'),
      (error) => conflict(error) && !error.message.includes(plaintext) && !error.message.includes(secret)
    );
  }

  assert.throws(() => decryptSecret(envelope, secret, 'assistant.llm.apiKey', 'openai'), conflict);
  assert.throws(() => decryptSecret(envelope, secret, 'llm.apiKey', 'bedrock'), conflict);
  assert.throws(() => decryptSecret(envelope, masterSecret(), 'llm.apiKey', 'openai'), conflict);
});

test(
  'reinitializing real PostgreSQL preserves discarded envelopes, settings, users, sessions and financial history',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);

    await insertDiscarded(f.pool, 'llm.apiKey', 'openai', 1);
    await insertDiscarded(f.pool, 'assistant.llm.apiKey', 'openai', 2);

    const original = await f.state();
    const restarted = createSettingsStore({ pool: f.pool, appSecret: f.config.appSecret });

    await new Store(f.pool, f.config).migrate();
    await restarted.init();
    await createHouseholdAuth({ pool: f.pool, config: f.config }).init();
    await assert.rejects(restarted.getSecret('llm.apiKey', 'openai'), conflict);
    await assert.rejects(restarted.getSecret('assistant.llm.apiKey', 'openai'), conflict);
    assert.deepEqual(await f.state(), original);
    await f.unchanged();
  }
);

test(
  'legacy classification and assistant profile recovery fail closed with atomic blank saves and rotation',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const assistantSettings = createAssistantSettings({ pool: f.pool, appSecret: f.config.appSecret });
    const providerValue = {
      provider: 'openai',
      model: 'synthetic-model',
      enabled: true,
      autoClassify: true,
      autoApply: true
    };
    const assistantValue = {
      provider: 'openai',
      model: 'synthetic-model',
      enabled: true,
      dataSharingAcknowledged: true
    };

    await f.settings.setValue('llm', providerValue);
    await f.settings.setValue('assistant.llm', assistantValue);
    await insertDiscarded(f.pool, 'llm.apiKey', 'openai', 1);
    await insertDiscarded(f.pool, 'assistant.llm.apiKey', 'openai', 2);

    for (const value of [await f.settings.getPublicProvider(), await assistantSettings.getPublic()]) {
      assert.equal(value.configured, true);
      assert.equal(value.credentialsAvailable, false);
      assert.deepEqual(value.credentials.apiKey, { configured: true, masked: '••••••••', unreadable: true });
      assert(!JSON.stringify(value).includes('ciphertext'));
      assert(!JSON.stringify(value).includes('synthetic-environment'));
    }

    const runtime = await f.settings.getProviderConfig();
    const assistantRuntime = await assistantSettings.getRuntimeConfig();

    assert.equal(runtime.llmEnabled, false);
    assert.equal(runtime.llmAutoClassify, false);
    assert.equal(runtime.llmAutoApply, false);
    assert.equal(runtime.llmApiKey, '');
    assert.equal(assistantRuntime.assistantEnabled, false);
    assert.equal(assistantRuntime.llmApiKey, '');

    let externalCalls = 0;
    const unexpected = async () => {
      externalCalls++;
      throw Error('External use must remain blocked');
    };

    const classification = createClassificationIntegration({
      pool: f.pool,
      store: f.store,
      config: f.config,
      getProviderConfig: f.settings.getProviderConfig,
      fetchImpl: unexpected
    });

    await classification.init();
    await classification.tick();
    await assert.rejects(classification.suggest(f.transaction.id), conflict);

    const assistant = createAssistant({
      getProviderConfig: assistantSettings.getRuntimeConfig,
      sendTurn: unexpected,
      invokeTool: unexpected,
      tools: []
    });
    const getContext = async () => ({ user: f.user, fingerprint: 'synthetic-access', finance: {} });
    const chat = await assistant.create({ getContext });

    await assert.rejects(
      assistant.send({ chatId: chat.id, message: 'Summarize spending', acknowledgeDataSharing: true, getContext }),
      conflict
    );
    assert.equal(externalCalls, 0);

    const originalCredentials = await f.credentials();

    await f.settings.saveProvider({ ...providerValue, enabled: false, apiKey: '  ' });
    await assistantSettings.save({ ...assistantValue, enabled: false, apiKey: '' });
    assert.deepEqual(await f.credentials(), originalCredentials);

    const disabled = await f.state();

    await assert.rejects(f.settings.saveProvider({ ...providerValue, model: 'must-roll-back', apiKey: '' }), conflict);
    await assert.rejects(assistantSettings.save({ ...assistantValue, model: 'must-roll-back' }), conflict);
    assert.deepEqual(await f.state(), disabled);

    await f.settings.saveProvider({ ...providerValue, apiKey: 'synthetic-classification-replacement' });
    assert.equal((await f.settings.getProviderConfig()).llmApiKey, 'synthetic-classification-replacement');
    assert.equal((await assistantSettings.getPublic()).credentialsAvailable, false);

    const partial = await f.state();

    await assert.rejects(f.settings.rotateSecrets(masterSecret()), conflict);
    assert.deepEqual(await f.state(), partial, 'failed rotation must roll back every ciphertext and timestamp');
    await assistantSettings.save({ ...assistantValue, apiKey: 'synthetic-assistant-replacement' });
    assert.equal((await assistantSettings.getRuntimeConfig()).llmApiKey, 'synthetic-assistant-replacement');
    assert.equal((await f.settings.getProviderConfig()).llmApiKey, 'synthetic-classification-replacement');

    const nextSecret = masterSecret();

    assert.equal(await f.settings.rotateSecrets(nextSecret), 2);
    assert.equal((await f.settings.getPublicProvider()).credentialsAvailable, false);
    assert.equal(
      (await createSettingsStore({ pool: f.pool, appSecret: nextSecret }).getProviderConfig()).llmApiKey,
      'synthetic-classification-replacement'
    );
    assert.equal(
      (await createAssistantSettings({ pool: f.pool, appSecret: nextSecret }).getRuntimeConfig()).llmApiKey,
      'synthetic-assistant-replacement'
    );
    assert(
      (await f.pool.query('SELECT ciphertext FROM encrypted_credentials')).rows.every((row) => row.ciphertext.v === 3)
    );
    await f.unchanged();
  }
);

test(
  'Redbark retains unreadable API and signing credentials until separately replaced without touching financial data',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const redbark = createRedbarkSettings({ pool: f.pool, settings: f.settings, appSecret: f.config.appSecret });

    await insertDiscarded(f.pool, 'redbark.apiKey', 'redbark', 1);
    await insertDiscarded(f.pool, 'redbark.webhook.signingSecret', 'redbark', 2);

    const state = await redbark.getPublic();
    const runtime = await redbark.getRuntimeConfig();

    assert.equal(state.configured, true);
    assert.equal(state.credentialsAvailable, false);
    assert.equal(state.credentials.apiKey.masked, '••••••••');
    assert.equal(state.credentials.signingSecret.configured, true);
    assert.equal(runtime.redbarkApiKey, '');
    assert.equal(runtime.redbarkWebhookSecret, '');

    let calls = 0;
    const integration = createRedbarkIntegration({
      pool: f.pool,
      store: f.store,
      config: f.config,
      getRedbarkConfig: redbark.getRuntimeConfig,
      fetchImpl: async () => {
        calls++;
        throw Error('Unreadable Redbark credentials must not reach a provider');
      }
    });

    await integration.init();
    await integration.tick();
    await assert.rejects(integration.testConnection(), conflict);
    assert.equal(calls, 0);

    const before = await f.credentials();

    await redbark.save({ apiKey: '', signingSecret: '', backfillDays: 42 });
    assert.deepEqual(await f.credentials(), before);
    await redbark.save({ apiKey: 'synthetic-redbark-replacement' });
    assert.equal((await redbark.getRuntimeConfig()).redbarkApiKey, 'synthetic-redbark-replacement');
    assert.equal((await redbark.getRuntimeConfig()).redbarkWebhookSecret, '');
    assert.equal((await redbark.getPublic()).credentialsAvailable, false);

    const retained = (
      await f.pool.query("SELECT ciphertext FROM encrypted_credentials WHERE setting='redbark.webhook.signingSecret'")
    ).rows[0];

    assert.equal(retained.ciphertext.v, 2);
    await redbark.save({ signingSecret: 'synthetic-redbark-signing-replacement' });

    const replaced = await redbark.getPublic();

    assert.equal(replaced.credentialsAvailable, true);
    assert.equal(replaced.signingSecretAssociated, true);
    assert.equal((await redbark.getRuntimeConfig()).redbarkWebhookSecret, 'synthetic-redbark-signing-replacement');
    assert(!JSON.stringify(replaced).includes('synthetic-redbark'));
    await f.unchanged();
  }
);

test(
  'SimpleFIN unreadable connection stays paused with all history retained until explicit disconnect',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const simplefin = createSimplefinIntegration({
      pool: f.pool,
      store: f.store,
      settings: f.settings,
      config: f.config,
      request: async () => {
        calls++;
        throw Error('Unreadable SimpleFIN credentials must not reach a provider');
      }
    });
    const sourceId = randomUUID();
    const revision = randomUUID();

    await simplefin.init();
    await insertDiscarded(f.pool, 'simplefin.accessUrl', 'simplefin', 2);
    await f.settings.setValue('simplefin', { enabled: true, backfillDays: 30, sourceId, revision });
    await f.pool.query('UPDATE simplefin_state SET tested_revision=$1 WHERE id=1', [revision]);
    await f.pool.query(
      "INSERT INTO simplefin_accounts(source_id,remote_key,identity_key,metadata,local_id) VALUES($1,'remote','identity',$2,'recovery-account')",
      [sourceId, { name: 'Synthetic bank account' }]
    );
    await f.pool.query(
      "INSERT INTO simplefin_jobs(dedupe_key,source_id,remote_key,start_second,end_second) VALUES('retained-job',$1,'remote',100,200)",
      [sourceId]
    );
    await f.pool.query("INSERT INTO simplefin_fetches(source_id,remote_key,coverage,raw) VALUES($1,'remote','{}',$2)", [
      sourceId,
      { evidence: 'synthetic-retained-observation' }
    ]);

    const historyTables = ['simplefin_accounts', 'simplefin_jobs', 'simplefin_fetches'];
    const history = await snapshot(f.pool, historyTables);
    const original = await f.credentials();
    const state = await simplefin.status();

    assert.equal(state.configured, true);
    assert.equal(state.credentialsAvailable, false);
    assert.equal(state.credential.masked, '••••••••');
    assert.equal(state.verified, false);
    await simplefin.tick();
    await assert.rejects(simplefin.discover(), conflict);
    assert.equal(calls, 0);
    assert.deepEqual(await snapshot(f.pool, historyTables), history);
    await simplefin.save({ enabled: false, backfillDays: 35 });
    assert.deepEqual(await f.credentials(), original);

    const disabled = await f.state();

    await assert.rejects(simplefin.save({ enabled: true, backfillDays: 99 }), conflict);
    assert.deepEqual(await f.state(), disabled);
    await assert.rejects(simplefin.disconnect({ confirm: false }));
    assert.deepEqual(await f.credentials(), original);
    await simplefin.disconnect({ confirm: true });
    assert.equal((await simplefin.status()).configured, false);
    assert.equal(
      (await f.pool.query("SELECT 1 FROM encrypted_credentials WHERE setting='simplefin.accessUrl'")).rowCount,
      0
    );
    assert.deepEqual(await snapshot(f.pool, historyTables), history);
    await f.unchanged();
  }
);

test(
  'notification HTTP status preserves configured-but-unavailable SMTP and Telegram credentials through replacement or clear',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const forbiddenSend = async () => {
      calls++;
      throw Error('Unavailable notification credentials must not be transmitted');
    };

    const notifications = createNotificationIntegration({
      pool: f.pool,
      settings: f.settings,
      mode: 'live',
      sendSmtpImpl: forbiddenSend,
      sendTelegram: forbiddenSend
    });
    const telegram = createTelegramPairing({ pool: f.pool, settings: f.settings, fetchImpl: forbiddenSend });
    const smtp = { enabled: true, from: 'sender@example.invalid', recipients: ['recipient@example.invalid'] };

    await notifications.init();
    await f.settings.setValue('notifications.audience', { confirmed: true });
    await f.settings.setValue('notifications.smtp', smtp);
    await f.settings.setValue('notifications.telegram', {
      enabled: true,
      chatId: '-12345',
      chatTitle: 'Synthetic group'
    });
    await insertDiscarded(f.pool, 'notifications.smtp.url', 'smtp', 1);
    await insertDiscarded(f.pool, 'notifications.telegram.botToken', 'telegram', 2);

    const request = await f.api({ notifications, telegram });
    const state = await request('/api/settings/notifications');

    assert.equal(state.status, 200);

    for (const channel of ['smtp', 'telegram']) {
      assert.equal(state.value[channel].configured, true);
      assert.equal(state.value[channel].credentialConfigured, true);
      assert.equal(state.value[channel].credentialsAvailable, false);
      assert.equal((await request('/api/notifications/test', 'POST', { channel })).status, 409);
    }

    assert(!state.text.includes('ciphertext'));
    assert.equal((await request('/api/settings/telegram/pair', 'POST', {})).status, 409);
    assert.equal(calls, 0);

    const original = await f.credentials();
    const blank = await request('/api/settings/notifications', 'PUT', {
      smtp: { ...smtp, enabled: false, smtpUrl: '' },
      telegram: { enabled: false, token: '' }
    });

    assert.equal(blank.status, 200);
    assert.deepEqual(await f.credentials(), original);

    const disabled = await f.state();

    for (const value of [{ smtp }, { telegram: { enabled: true } }]) {
      const response = await request('/api/settings/notifications', 'PUT', value);

      assert.equal(response.status, 409);
      assert(!response.text.includes('ciphertext'));
      assert.deepEqual(await f.state(), disabled);
    }

    const smtpUrl = 'smtps://synthetic:replacement-password@smtp.example.com:465';
    const token = '123456:synthetic_replacement_token_123456789';
    const replaced = await request('/api/settings/notifications', 'PUT', {
      smtp: { ...smtp, smtpUrl },
      telegram: { enabled: false, token }
    });

    assert.equal(replaced.status, 200);
    assert.equal(replaced.value.smtp.credentialsAvailable, true);
    assert.equal(replaced.value.telegram.credentialsAvailable, true);
    assert.equal(replaced.value.telegram.paired, false, 'replacement requires explicit pairing again');
    assert(!replaced.text.includes(smtpUrl));
    assert(!replaced.text.includes(token));
    assert.equal(await f.settings.getSecret('notifications.smtp.url', 'smtp'), smtpUrl);
    assert.equal(await f.settings.getSecret('notifications.telegram.botToken', 'telegram'), token);

    const cleared = await request('/api/settings/notifications', 'PUT', {
      smtp: { ...smtp, enabled: false, smtpUrl: null },
      telegram: { enabled: false, token: null }
    });

    assert.equal(cleared.status, 200);
    assert.equal(cleared.value.smtp.configured, false);
    assert.equal(cleared.value.telegram.configured, false);
    assert.equal((await f.pool.query('SELECT 1 FROM encrypted_credentials')).rowCount, 0);
    assert.equal(calls, 0);
    await f.unchanged();
  }
);
