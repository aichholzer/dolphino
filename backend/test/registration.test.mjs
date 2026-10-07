import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { callbackUrl, createRegistration } from '../src/lib/registration.mjs';
import { createRedbarkSettings } from '../src/lib/redbark-settings.mjs';
import { ensureRedbarkSchema } from '../src/lib/worker.mjs';
import { configurationFingerprint } from '../src/lib/redbark.mjs';
import { createSettingsStore } from '../src/lib/settings.mjs';

test('webhook callback accepts only public HTTPS origins, never arbitrary fetch paths', () => {
  assert.equal(callbackUrl('https://finance.example.com'), 'https://finance.example.com/api/webhooks/redbark');
  for (const bad of [
    'http://finance.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://finance.local',
    'https://localhost',
    'https://foo.internal',
    'https://u:p@finance.com',
    'https://finance.com/path',
    'https://finance.com/?token=x',
    'https://finance.com:8080',
    'https://finance.com/#x'
  ]) {
    assert.throws(() => callbackUrl(bad));
  }
});
const database = readTestPostgresConfig();
test(
  'registration is durable, serialized, encrypted, recoverable and never returns secrets',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `registration_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    try {
      const appSecret = randomBytes(32).toString('hex');
      const settings = createSettingsStore({
        pool,
        appSecret,
        envConfig: {}
      });
      await settings.init();
      await ensureRedbarkSchema(pool);
      const redbarkSettings = createRedbarkSettings({
        pool,
        settings,
        appSecret
      });
      await redbarkSettings.save({ apiKey: 'synthetic' });
      await pool.query('UPDATE redbark_state SET fingerprint=$1 WHERE id=1', [
        configurationFingerprint(await redbarkSettings.getRuntimeConfig())
      ]);
      let remoteDest = null,
        creates = 0,
        rotations = 0,
        loseResponse = false;
      const client = {
        list: async () =>
          remoteDest
            ? [
                {
                  ...remoteDest,
                  webhook_endpoint: {
                    url: remoteDest.webhook_endpoint.url,
                    signing_secret: null
                  }
                }
              ]
            : [],
        request: async (path, opts) => {
          assert.equal(opts.method, 'POST');
          if (path === 'event_destinations') {
            creates++;
            remoteDest = {
              id: 'ed_synthetic',
              status: 'enabled',
              webhook_endpoint: {
                url: opts.body.webhook_endpoint.url,
                signing_secret: 'fictional-signing-secret-001'
              }
            };
            if (loseResponse) {
              throw Error('provider body contains secret never return it');
            }
          }

          if (path.endsWith('/rotate_secret')) {
            rotations++;
            remoteDest.webhook_endpoint.signing_secret = 'fictional-rotated-signing-secret';
          }

          if (path === 'event_destinations/ed_synthetic' || path.endsWith('/enable')) {
            assert.equal(
              await settings.getSecret('redbark.webhook.signingSecret', 'redbark'),
              remoteDest.webhook_endpoint.signing_secret,
              'one-time secret durable before subscription/enable side effect'
            );
            assert.equal(
              (await pool.query('SELECT destination_id FROM webhook_registration')).rows[0].destination_id,
              'ed_synthetic'
            );
          }

          if (path.endsWith('/ping')) {
            return { body: { id: 'evt_synthetic' } };
          }

          return { body: remoteDest };
        }
      };
      const args = {
        pool,
        settings,
        config: { mode: 'live' },
        getRedbarkConfig: redbarkSettings.getRuntimeConfig,
        client,
        lookupImpl: async () => [{ address: '93.184.216.34' }]
      };
      const registration = createRegistration(args);
      await registration.init();
      const input = { publicBaseUrl: 'https://finance.example.com' };
      await Promise.all([registration.register(input), registration.register(input)]);
      assert.equal(creates, 1);
      assert.equal(rotations, 0);
      assert.equal(await registration.runtimeSigningSecret(), 'fictional-signing-secret-001');
      assert.ok(!JSON.stringify(await registration.status()).includes('fictional'));
      const ping = await registration.test();
      assert.equal(ping.pingReceived, false);
      await pool.query(
        "INSERT INTO redbark_receipts(event_id,body,body_hash) VALUES('evt_synthetic','{}','synthetic-hash')"
      );
      assert.equal((await registration.status()).pingReceived, true);
      await settings.clearSecret('redbark.webhook.signingSecret', 'redbark');
      await assert.rejects(registration.register(input), /signing_secret_recovery_required/);
      await registration.register({ ...input, recoverSigningSecret: true });
      assert.equal(rotations, 1);
      assert.equal(creates, 1);
      await pool.query('DELETE FROM webhook_registration');
      await settings.clearSecret('redbark.webhook.signingSecret', 'redbark');
      remoteDest = null;
      loseResponse = true;
      await assert.rejects(registration.register(input), /registration_failed/);
      assert.equal((await registration.status()).lastError, 'registration_failed');
      loseResponse = false;
      await assert.rejects(registration.register(input), /signing_secret_recovery_required/);
      await registration.register({ ...input, recoverSigningSecret: true });
      assert.equal(creates, 2);
      const wrongSecret = randomBytes(32).toString('hex');
      const wrongSettings = createSettingsStore({
        pool,
        appSecret: wrongSecret,
        envConfig: {}
      });
      const wrong = createRegistration({
        ...args,
        settings: wrongSettings,
        getRedbarkConfig: createRedbarkSettings({
          pool,
          settings: wrongSettings,
          appSecret: wrongSecret
        }).getRuntimeConfig,
        config: { ...args.config, redbarkWebhookSecret: 'must-not-fallback' }
      });
      await assert.rejects(wrong.runtimeSigningSecret());
      assert.equal((await wrong.status()).credentialsUnavailable, true);
      const blocked = createRegistration({
        ...args,
        lookupImpl: async () => [{ address: '10.1.2.3' }]
      });
      await assert.rejects(blocked.register(input), /public_dns_required/);
      assert.equal(creates, 2);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);

test('worker without a database resolver never falls back to config credentials', async () => {
  const { createRedbarkIntegration } = await import('../src/lib/worker.mjs');
  const integration = createRedbarkIntegration({
    pool: {
      query() {
        throw Error('must not query');
      }
    },
    store: {},
    config: {
      mode: 'live',
      redbarkApiKey: 'must-not-fallback',
      redbarkWebhookSecret: 'must-not-fallback'
    }
  });
  await assert.rejects(integration.testConnection(), /live_redbark_not_configured/);
});
