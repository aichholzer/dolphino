import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canEncrypt, decryptSecret } from './crypto.mjs';
import { REDBARK_VERSION, configurationFingerprint } from './redbark.mjs';

export const REDBARK_SETTINGS_LOCK = 71903901;

export const REDBARK_SIGNING_SECRET = 'redbark.webhook.signingSecret';

const secret = (min, max) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(min)
      .max(max)
      .regex(/^[\x21-\x7e]+$/)
      .nullable()
      .optional()
  );
export const redbarkSettingsSchema = z
  .object({
    apiKey: secret(1, 8192),
    signingSecret: secret(16, 4096),
    version: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9-]{0,39}$/)
      .default(REDBARK_VERSION),
    backfillDays: z.number().int().min(1).max(2555).default(90)
  })
  .strict();

export function redbarkAccountFingerprint(apiKey) {
  return apiKey ? createHash('sha256').update(`redbark-account\0${apiKey}`).digest('hex') : '';
}

// Settings and ciphertext are read by one MVCC statement, so a save can never
// mix a key from one revision with a version/signing secret from another.
export function createRedbarkSettings({ pool, settings, appSecret }) {
  async function snapshot(db = pool) {
    const {
      rows: [row]
    } = await db.query(`SELECT
      (SELECT value FROM app_settings WHERE key='redbark') AS value,
      (SELECT value FROM app_settings WHERE key='redbark.webhookBinding') AS binding,
      (SELECT ciphertext FROM encrypted_credentials WHERE setting='redbark.apiKey' AND provider='redbark') AS api_key,
      (SELECT ciphertext FROM encrypted_credentials WHERE setting='redbark.webhook.signingSecret' AND provider='redbark') AS signing_secret`);
    const value = row.value || {};
    const config = {
      redbarkApiKey: '',
      redbarkVersion: value.version || REDBARK_VERSION,
      redbarkBackfillDays: value.backfillDays || 90,
      redbarkRevision: value.revision || '',
      redbarkWebhookSecret: '',
      redbarkCredentialsUnavailable: false
    };
    let signingSecret = '',
      apiUnavailable = false,
      signingUnavailable = false;
    if (row.api_key) {
      try {
        config.redbarkApiKey = decryptSecret(row.api_key, appSecret, 'redbark.apiKey', 'redbark');
      } catch {
        apiUnavailable = true;
      }
    }

    if (row.signing_secret) {
      try {
        signingSecret = decryptSecret(row.signing_secret, appSecret, REDBARK_SIGNING_SECRET, 'redbark');
      } catch {
        signingUnavailable = true;
      }
    }

    config.redbarkAccountFingerprint = redbarkAccountFingerprint(config.redbarkApiKey);
    config.redbarkFingerprint = configurationFingerprint(config);
    const associated =
      !!config.redbarkAccountFingerprint && row.binding?.accountFingerprint === config.redbarkAccountFingerprint;
    if (associated && !apiUnavailable) {
      config.redbarkWebhookSecret = signingSecret;
    }

    config.redbarkCredentialsUnavailable = apiUnavailable;
    config.redbarkWebhookUnavailable = signingUnavailable;
    const credential = (configured) => ({
      configured: !!configured,
      masked: configured ? '••••••••' : ''
    });
    return {
      value,
      config,
      publicState: {
        version: config.redbarkVersion,
        backfillDays: config.redbarkBackfillDays,
        source: 'database',
        configured: !!row.api_key,
        credentialsAvailable: !apiUnavailable && !signingUnavailable,
        encryptionAvailable: canEncrypt(appSecret),
        signingSecretAssociated: associated && !!signingSecret,
        credentials: {
          apiKey: credential(row.api_key),
          signingSecret: credential(row.signing_secret)
        }
      }
    };
  }

  async function save(input) {
    const parsed = redbarkSettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw Object.assign(Error('Invalid Redbark settings'), { status: 400 });
    }

    const value = parsed.data;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Shared with registration: changing account credentials cannot race a
      // remote destination operation or bind its returned key to a new account.
      await db.query('SELECT pg_advisory_xact_lock($1)', [REDBARK_SETTINGS_LOCK]);
      const prior = await snapshot(db);
      if (value.apiKey !== undefined) {
        await settings.setSecret('redbark.apiKey', 'redbark', value.apiKey, db);
      }

      const apiKey = value.apiKey === undefined ? prior.config.redbarkApiKey : value.apiKey || '';
      const accountFingerprint = redbarkAccountFingerprint(apiKey);
      const changed =
        value.apiKey !== undefined &&
        (prior.config.redbarkApiKey !== apiKey || prior.config.redbarkCredentialsUnavailable);
      if (changed) {
        await settings.setValue('redbark.webhookBinding', { accountFingerprint: '' }, db);
      }

      if (value.signingSecret !== undefined) {
        if (value.signingSecret && !apiKey) {
          throw Object.assign(Error('Configure the Redbark API key before its signing secret'), { status: 409 });
        }

        await settings.setSecret(REDBARK_SIGNING_SECRET, 'redbark', value.signingSecret, db);
        await settings.setValue(
          'redbark.webhookBinding',
          { accountFingerprint: value.signingSecret ? accountFingerprint : '' },
          db
        );
      }

      await settings.setValue(
        'redbark',
        {
          version: value.version,
          backfillDays: value.backfillDays,
          revision:
            changed || value.version !== prior.config.redbarkVersion
              ? randomUUID()
              : prior.value.revision || randomUUID()
        },
        db
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }

    return (await snapshot()).publicState;
  }

  return {
    snapshot,
    save,
    getPublic: async () => (await snapshot()).publicState,
    getRuntimeConfig: async (db) => (await snapshot(db)).config
  };
}
