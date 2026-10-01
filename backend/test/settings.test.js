import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv, hkdfSync } from 'node:crypto';
import pg from 'pg';
import { canEncrypt, encryptSecret, decryptSecret } from '../src/crypto.js';
import { createSettingsStore, providerSettingsSchema } from '../src/settings.js';
const secret = () => randomBytes(32).toString('base64');
test('credential AEAD uses random nonces, AAD, authenticated tamper protection and safe errors', () => {
  const key = secret();
  const a = encryptSecret('synthetic-only', key, 'llm.apiKey', 'openai');
  assert.notDeepEqual(a, encryptSecret('synthetic-only', key, 'llm.apiKey', 'openai'));
  assert.equal(a.v, 2);
  assert.equal(Buffer.from(a.salt, 'base64').length, 32);
  assert.equal(Buffer.from(a.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(a.tag, 'base64').length, 16);
  const b = encryptSecret('synthetic-only', key, 'llm.apiKey', 'openai');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(decryptSecret(a, key, 'llm.apiKey', 'openai'), 'synthetic-only');
  for (const [cipher, k, setting, provider] of [
    [a, secret(), 'llm.apiKey', 'openai'],
    [a, key, 'other', 'openai'],
    [a, key, 'llm.apiKey', 'bedrock'],
    [{ ...a, data: 'AAAA' }, key, 'llm.apiKey', 'openai'],
    [{ ...a, v: 999 }, key, 'llm.apiKey', 'openai'],
    ...['salt', 'nonce', 'tag'].flatMap((field) => [
      [
        {
          ...a,
          [field]: randomBytes(field === 'salt' ? 32 : field === 'nonce' ? 12 : 16).toString('base64')
        },
        key,
        'llm.apiKey',
        'openai'
      ],
      [{ ...a, [field]: 'AAAA' }, key, 'llm.apiKey', 'openai'],
      [{ ...a, [field]: a[field] + '!' }, key, 'llm.apiKey', 'openai']
    ]),
    [{ ...a, salt: undefined }, key, 'llm.apiKey', 'openai'],
    [{ ...a, data: '' }, key, 'llm.apiKey', 'openai']
  ]) {
    assert.throws(
      () => decryptSecret(cipher, k, setting, provider),
      (e) => e.status === 409 && !e.message.includes('synthetic-only')
    );
  }
  for (const bad of [undefined, '', 'short', 'a'.repeat(64), 'replace-with-your-secret'.repeat(3)]) {
    assert.equal(canEncrypt(bad), false);
  }
});
test('provider settings runtime schema rejects unsafe shape and unbounded costs', () => {
  assert.equal(
    providerSettingsSchema.safeParse({
      provider: 'bedrock',
      model: 'anthropic.model'
    }).success,
    false
  );
  assert.equal(
    providerSettingsSchema.safeParse({
      provider: 'openai',
      model: 'gpt-test',
      dailyRequestLimit: 1001
    }).success,
    false
  );
  assert.equal(
    providerSettingsSchema.safeParse({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: null
    }).success,
    true
  );
  assert.equal(
    providerSettingsSchema.safeParse({
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://arbitrary.example'
    }).success,
    false
  );
});
const database = readTestPostgresConfig();
test(
  'PostgreSQL settings atomic credentials, redaction, fail closed, clear, concurrent overwrite and key rotation',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `settings_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const key = secret();
    const s = createSettingsStore({
      pool,
      appSecret: key,
      envConfig: { llmApiKey: 'ENV-MUST-NOT-FALLBACK' }
    });
    try {
      await s.init();
      const base = {
        provider: 'openai',
        model: 'synthetic-model',
        enabled: true
      };
      const state = await s.saveProvider({
        ...base,
        apiKey: 'synthetic-sensitive'
      });
      assert.equal(state.credentials.apiKey.configured, true);
      assert.ok(!JSON.stringify(state).includes('synthetic-sensitive'));
      assert.equal((await s.getProviderConfig()).llmApiKey, 'synthetic-sensitive');
      assert.ok(!JSON.stringify((await pool.query('SELECT * FROM app_settings')).rows).includes('synthetic-sensitive'));
      assert.ok(
        !JSON.stringify((await pool.query('SELECT * FROM encrypted_credentials')).rows).includes('synthetic-sensitive')
      );
      await assert.rejects(s.saveProvider({ ...base, apiKey: null }));
      assert.equal((await s.getProviderConfig()).llmApiKey, 'synthetic-sensitive');
      await s.saveProvider({ ...base, model: 'changed', apiKey: '' });
      assert.equal((await s.getProviderConfig()).llmApiKey, 'synthetic-sensitive');
      const wrong = createSettingsStore({
        pool,
        appSecret: secret(),
        envConfig: { llmApiKey: 'ENV-MUST-NOT-FALLBACK' }
      });
      assert.equal((await wrong.getPublicProvider()).credentialsAvailable, false);
      assert.equal((await wrong.getProviderConfig()).llmApiKey, '');
      assert.equal((await wrong.getProviderConfig()).llmAutoClassify, false);
      await wrong.saveProvider({ ...base, enabled: false }); // ordinary settings accessible with missing key
      await s.saveProvider({ ...base, apiKey: 'synthetic-restored' });
      await Promise.all([
        s.saveProvider({ ...base, apiKey: 'synthetic-A' }),
        s.saveProvider({ ...base, apiKey: 'synthetic-B' })
      ]);
      assert.ok(['synthetic-A', 'synthetic-B'].includes((await s.getProviderConfig()).llmApiKey));
      await s.setSecret('redbark.webhook.signingSecret', 'redbark', 'synthetic-signing');
      const next = secret();
      assert.equal(await s.rotateSecrets(next), 2);
      assert.equal((await s.getProviderConfig()).llmCredentialsUnavailable, true);
      const rotated = createSettingsStore({ pool, appSecret: next });
      assert.equal(await rotated.getSecret('redbark.webhook.signingSecret', 'redbark'), 'synthetic-signing');
      await assert.rejects(s.rotateSecrets(secret()));
      assert.equal(await rotated.getSecret('redbark.webhook.signingSecret', 'redbark'), 'synthetic-signing');
      await rotated.saveProvider({ ...base, enabled: false, apiKey: null });
      assert.equal((await rotated.getPublicProvider()).credentials.apiKey.configured, false);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);

test('Bedrock settings restrict credentials to permanent keys and catalogued runtime regions', () => {
  const base = {
    provider: 'bedrock',
    model: 'anthropic.example',
    region: 'ap-southeast-2',
    accessKeyId: 'AKIA_SYNTHETIC',
    secretAccessKey: 'synthetic'
  };
  assert.equal(providerSettingsSchema.safeParse(base).success, true);
  for (const patch of [{ sessionToken: 'unsupported' }, { accessKeyId: 'ASIA_SYNTHETIC' }, { region: 'xx-future-1' }]) {
    assert.equal(providerSettingsSchema.safeParse({ ...base, ...patch }).success, false);
  }
});

test('legacy version 1 envelope remains readable and re-encryption upgrades to version 2', () => {
  const master = secret();
  const nonce = randomBytes(12);
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(master, 'utf8'),
      Buffer.from('profe/settings/key/v1'),
      Buffer.from('AES-256-GCM credential encryption'),
      32
    )
  );
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['profe-credential', 1, 'test.slot', 'test.provider'])));
  const data = Buffer.concat([cipher.update('synthetic-legacy', 'utf8'), cipher.final()]);
  const legacy = {
    v: 1,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  const plaintext = decryptSecret(legacy, master, 'test.slot', 'test.provider');
  assert.equal(plaintext, 'synthetic-legacy');
  const upgraded = encryptSecret(plaintext, master, 'test.slot', 'test.provider');
  assert.equal(upgraded.v, 2);
  assert.equal(decryptSecret(upgraded, master, 'test.slot', 'test.provider'), plaintext);
  assert.throws(() =>
    decryptSecret({ ...legacy, v: 2, salt: randomBytes(32).toString('base64') }, master, 'test.slot', 'test.provider')
  );
});
