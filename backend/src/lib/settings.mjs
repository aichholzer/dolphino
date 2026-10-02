import { z } from 'zod';
import { BEDROCK_REGION_CATALOG, isBedrockRegion } from './provider-regions.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canEncrypt, encryptSecret, decryptSecret } from './crypto.mjs';
const credential = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^\r\n\0]+$/)
    .nullable()
    .optional()
);
export const providerSettingsSchema = z
  .object({
    provider: z.enum(['openai', 'bedrock']),
    model: z
      .string()
      .trim()
      .max(500)
      .regex(/^[a-zA-Z0-9._:/-]*$/),
    region: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().refine(isBedrockRegion, 'Choose a supported Bedrock region').optional()
    ),
    enabled: z.boolean().default(false),
    autoClassify: z.boolean().default(false),
    autoApply: z.boolean().default(false),
    dailyRequestLimit: z.number().int().min(1).max(1000).default(20),
    batchSize: z.number().int().min(1).max(20).default(5),
    apiKey: credential,
    accessKeyId: credential,
    secretAccessKey: credential
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.model && (v.provider !== 'bedrock' || v.enabled)) {
      ctx.addIssue({ code: 'custom', message: 'Choose a model before enabling', path: ['model'] });
    }

    if (v.provider === 'bedrock' && v.accessKeyId?.startsWith('ASIA')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Temporary AWS credentials are not supported',
        path: ['accessKeyId']
      });
    }

    if (v.provider === 'bedrock' && !v.region) {
      ctx.addIssue({
        code: 'custom',
        message: 'AWS region is required',
        path: ['region']
      });
    }
  });

const fields = ['apiKey', 'accessKeyId', 'secretAccessKey'];
const names = {
  apiKey: 'llmApiKey',
  accessKeyId: 'llmAccessKeyId',
  secretAccessKey: 'llmSecretAccessKey'
};
export const defaultProviderSettings = Object.freeze({
  provider: 'openai',
  model: '',
  enabled: false,
  autoClassify: false,
  autoApply: false,
  dailyRequestLimit: 20,
  batchSize: 5
});

export const disabledProviderConfig = Object.freeze({
  llmProvider: 'openai',
  llmModel: '',
  llmRegion: undefined,
  llmBaseUrl: 'https://api.openai.com/v1/',
  llmEnabled: false,
  llmAutoClassify: false,
  llmAutoApply: false,
  llmDailyRequestLimit: 20,
  llmBatchSize: 5,
  llmApiKey: '',
  llmAccessKeyId: '',
  llmSecretAccessKey: '',
  llmConfigured: false,
  llmCredentialsUnavailable: false,
  llmDisabledReason: 'Configure a provider and credentials in Settings'
});

const required = (provider) => (provider === 'openai' ? ['apiKey'] : ['accessKeyId', 'secretAccessKey']);
export function createSettingsStore({
  pool,
  appSecret,
  providerNamespace = 'llm',
  settingsSchema = providerSettingsSchema,
  defaultSettings = defaultProviderSettings
}) {
  if (!/^[a-z][a-z0-9_.]{0,63}$/.test(providerNamespace)) {
    throw Error('Invalid provider namespace');
  }

  async function setSecret(setting, provider, value, client = pool) {
    if (value === null) {
      return clearSecret(setting, provider, client);
    }

    const ciphertext = encryptSecret(value, appSecret, setting, provider);
    await client.query(
      'INSERT INTO encrypted_credentials(setting,provider,ciphertext) VALUES($1,$2,$3) ON CONFLICT(setting,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now()',
      [setting, provider, ciphertext]
    );
  }

  async function getSecret(setting, provider, client = pool) {
    const row = (
      await client.query('SELECT ciphertext FROM encrypted_credentials WHERE setting=$1 AND provider=$2', [
        setting,
        provider
      ])
    ).rows[0];
    return row ? decryptSecret(row.ciphertext, appSecret, setting, provider) : null;
  }

  async function clearSecret(setting, provider, client = pool) {
    await client.query('DELETE FROM encrypted_credentials WHERE setting=$1 AND provider=$2', [setting, provider]);
  }

  async function getValue(key, client = pool) {
    return (await client.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]?.value ?? null;
  }

  async function setValue(key, value, client = pool) {
    await client.query(
      'INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',
      [key, value]
    );
  }

  async function getProviderSnapshot(client = pool) {
    // A single PostgreSQL statement gives settings and ciphertexts one MVCC
    // snapshot. Reading the rows separately can mix a model from one save with
    // credentials from another, even when writers use transactions.
    const row = (
      await client.query(
        `SELECT s.value, s.updated_at::text AS revision_time, COALESCE((
          SELECT jsonb_object_agg(c.setting,c.ciphertext)
          FROM encrypted_credentials c
          WHERE c.provider=s.value->>'provider' AND c.setting=ANY($2::text[])
        ), '{}'::jsonb) AS secrets
        FROM app_settings s WHERE s.key=$1`,
        [providerNamespace, fields.map((field) => `${providerNamespace}.${field}`)]
      )
    ).rows[0];
    let value = { ...defaultSettings };
    let settingsAvailable = true;
    if (row) {
      const stored = row.value;
      const candidate = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : null;
      // Old database settings used enabled for both switches. Preserve that
      // persisted behavior once; new writes have two independent booleans.
      if (candidate && providerNamespace === 'llm' && !Object.hasOwn(candidate, 'autoClassify')) {
        candidate.autoClassify = candidate.enabled === true;
      }

      const parsed = settingsSchema.safeParse(candidate);
      settingsAvailable = parsed.success && !fields.some((field) => Object.hasOwn(candidate || {}, field));
      if (settingsAvailable) {
        value = parsed.data;
      }
    }

    const credentials = {};
    const secrets = {};
    let credentialsAvailable = true;
    for (const field of fields) {
      const setting = `${providerNamespace}.${field}`;
      const configured = Object.hasOwn(row?.secrets || {}, setting);
      let unreadable = false;
      if (configured) {
        try {
          secrets[field] = decryptSecret(row.secrets[setting], appSecret, setting, value.provider);
          if (!secrets[field] || (field === 'accessKeyId' && secrets[field].startsWith('ASIA'))) {
            throw Error('Unsupported stored credentials');
          }
        } catch {
          unreadable = true;
          credentialsAvailable = false;
        }
      }

      credentials[field] = {
        configured,
        masked: configured ? '••••••••' : '',
        unreadable
      };
    }

    const credentialsConfigured =
      settingsAvailable && !!row && required(value.provider).every((field) => credentials[field].configured);
    const configured = credentialsConfigured && !!value.model;
    const usableCredentials = credentialsConfigured && credentialsAvailable;
    const usable = configured && credentialsAvailable;
    // Hash only stored ciphertext and public settings, never decrypted secrets.
    // The timestamp fences same-value saves and region changes away and back.
    const discoveryRevision = createHash('sha256')
      .update(
        JSON.stringify([
          providerNamespace,
          row?.revision_time,
          row?.value,
          fields.map((field) => row?.secrets?.[`${providerNamespace}.${field}`])
        ])
      )
      .digest('hex');
    const disabledReason = !settingsAvailable
      ? 'Stored provider settings are invalid; save valid settings to continue'
      : !credentialsAvailable
        ? 'Stored credentials unavailable; verify APP_SECRET or replace credentials'
        : !credentialsConfigured
          ? 'Configure a provider and credentials in Settings'
          : !value.model
            ? 'Credentials saved; load models or enter a model ID before enabling'
            : !value.enabled
              ? 'Provider is disabled'
              : null;
    const config = {
      ...disabledProviderConfig,
      llmProvider: value.provider,
      llmModel: value.model,
      llmRegion: value.region,
      llmBaseUrl: value.provider === 'openai' ? 'https://api.openai.com/v1/' : '',
      llmEnabled: usable && value.enabled === true,
      llmAutoClassify: usable && value.autoClassify === true,
      llmAutoApply: usable && value.autoApply === true,
      llmDailyRequestLimit: value.dailyRequestLimit ?? 20,
      llmBatchSize: value.batchSize ?? 5,
      llmConfigured: configured,
      llmCredentialsUnavailable: !!row && !usableCredentials,
      llmDisabledReason: disabledReason
    };
    if (usableCredentials) {
      for (const field of required(value.provider)) {
        config[names[field]] = secrets[field];
      }
    }

    return {
      value,
      config,
      publicState: {
        ...value,
        discoveryRevision,
        regionCatalog: BEDROCK_REGION_CATALOG,
        source: 'database',
        encryptionAvailable: canEncrypt(appSecret),
        settingsAvailable,
        credentialsAvailable,
        configured,
        disabledReason,
        credentials
      }
    };
  }

  async function getPublicProvider() {
    return (await getProviderSnapshot()).publicState;
  }

  async function saveProvider(input) {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) {
      throw Object.assign(Error('Invalid provider settings'), { status: 400 });
    }

    const value = parsed.data;
    const client = await pool.connect();
    let publicState;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(17092381)');
      for (const field of fields) {
        if (value[field] !== undefined) {
          await setSecret(`${providerNamespace}.${field}`, value.provider, value[field], client);
        }
      }

      // Enabling is allowed only when required stored credentials decrypt and
      // satisfy provider restrictions, including blank-preserved legacy keys.
      if (value.enabled) {
        for (const field of required(value.provider)) {
          const plaintext = await getSecret(`${providerNamespace}.${field}`, value.provider, client);
          if (!plaintext || (field === 'accessKeyId' && plaintext.startsWith('ASIA'))) {
            throw Object.assign(Error('Configure required provider credentials before enabling'), { status: 409 });
          }
        }
      }

      const publicValue = Object.fromEntries(Object.entries(value).filter(([k]) => !fields.includes(k)));
      await setValue(providerNamespace, publicValue, client);
      publicState = (await getProviderSnapshot(client)).publicState;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return publicState;
  }

  async function getProviderConfig(client = pool) {
    return (await getProviderSnapshot(client)).config;
  }

  async function rotateSecrets(newSecret) {
    if (!canEncrypt(newSecret)) {
      throw Object.assign(Error('New APP_SECRET must contain strong random material'), { status: 400 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE encrypted_credentials IN ACCESS EXCLUSIVE MODE');
      const rows = (await client.query('SELECT * FROM encrypted_credentials')).rows;
      for (const row of rows) {
        await client.query(
          'UPDATE encrypted_credentials SET ciphertext=$3,updated_at=now() WHERE setting=$1 AND provider=$2',
          [
            row.setting,
            row.provider,
            encryptSecret(
              decryptSecret(row.ciphertext, appSecret, row.setting, row.provider),
              newSecret,
              row.setting,
              row.provider
            )
          ]
        );
      }

      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    assertEncryptionReady: () => {
      if (!canEncrypt(appSecret)) {
        throw Object.assign(
          Error('APP_SECRET must be configured with strong random material before saving credentials'),
          { status: 409 }
        );
      }
    },
    init: async () => pool.query(await readFile(new URL('../../migrations/005_settings.sql', import.meta.url), 'utf8')),
    getPublicProvider,
    saveProvider,
    getProviderConfig,
    getProviderSnapshot,
    setSecret,
    getSecret,
    clearSecret,
    getValue,
    setValue,
    rotateSecrets
  };
}
