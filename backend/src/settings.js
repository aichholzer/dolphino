import { z } from "zod";
import { BEDROCK_REGION_CATALOG, isBedrockRegion } from "./provider-regions.js";
import { readFile } from "node:fs/promises";
import { canEncrypt, encryptSecret, decryptSecret } from "./crypto.js";
const credential = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).max(8192).nullable().optional(),
);
export const providerSettingsSchema = z
  .object({
    provider: z.enum(["openai", "bedrock"]),
    model: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^[a-zA-Z0-9._:/-]+$/),
    region: z
      .string()
      .refine(isBedrockRegion, "Choose a supported Bedrock region")
      .optional(),
    enabled: z.boolean().default(false),
    autoApply: z.boolean().default(false),
    dailyRequestLimit: z.number().int().min(1).max(1000).default(20),
    batchSize: z.number().int().min(1).max(20).default(5),
    apiKey: credential,
    accessKeyId: credential,
    secretAccessKey: credential,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.provider === "bedrock" && v.accessKeyId?.startsWith("ASIA"))
      ctx.addIssue({
        code: "custom",
        message: "Temporary AWS credentials are not supported",
        path: ["accessKeyId"],
      });
    if (v.provider === "bedrock" && !v.region)
      ctx.addIssue({
        code: "custom",
        message: "AWS region is required",
        path: ["region"],
      });
  });
const fields = ["apiKey", "accessKeyId", "secretAccessKey"];
const required = (provider) =>
  provider === "openai" ? ["apiKey"] : ["accessKeyId", "secretAccessKey"];
export function createSettingsStore({
  pool,
  appSecret,
  envConfig = {},
  providerNamespace = "llm",
  allowEnvironmentFallback = true,
  settingsSchema = providerSettingsSchema,
}) {
  if (!/^[a-z][a-z0-9_.]{0,63}$/.test(providerNamespace))
    throw Error("Invalid provider namespace");
  const fallbackConfig = allowEnvironmentFallback ? envConfig : {};
  async function setSecret(setting, provider, value, client = pool) {
    if (value === null) return clearSecret(setting, provider, client);
    const ciphertext = encryptSecret(value, appSecret, setting, provider);
    await client.query(
      "INSERT INTO encrypted_credentials(setting,provider,ciphertext) VALUES($1,$2,$3) ON CONFLICT(setting,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now()",
      [setting, provider, ciphertext],
    );
  }
  async function getSecret(setting, provider, client = pool) {
    const row = (
      await client.query(
        "SELECT ciphertext FROM encrypted_credentials WHERE setting=$1 AND provider=$2",
        [setting, provider],
      )
    ).rows[0];
    return row
      ? decryptSecret(row.ciphertext, appSecret, setting, provider)
      : null;
  }
  async function clearSecret(setting, provider, client = pool) {
    await client.query(
      "DELETE FROM encrypted_credentials WHERE setting=$1 AND provider=$2",
      [setting, provider],
    );
  }
  async function getValue(key, client = pool) {
    return (
      (await client.query("SELECT value FROM app_settings WHERE key=$1", [key]))
        .rows[0]?.value ?? null
    );
  }
  async function setValue(key, value, client = pool) {
    await client.query(
      "INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [key, value],
    );
  }
  async function getPublicProvider() {
    const stored = await getValue(providerNamespace);
    const state = stored || {
      provider: fallbackConfig.llmProvider || "openai",
      model: fallbackConfig.llmModel || "",
      enabled: !!fallbackConfig.llmApiKey,
      autoApply: !!fallbackConfig.llmAutoApply,
      dailyRequestLimit: fallbackConfig.llmDailyRequestLimit || 20,
      batchSize: fallbackConfig.llmBatchSize || 5,
    };
    const credentials = {};
    let available = true;
    for (const field of fields) {
      let configured = false;
      if (stored) {
        configured = !!(
          await pool.query(
            "SELECT 1 FROM encrypted_credentials WHERE setting=$1 AND provider=$2",
            [`${providerNamespace}.${field}`, state.provider],
          )
        ).rowCount;
        if (configured) {
          try {
            await getSecret(`${providerNamespace}.${field}`, state.provider);
          } catch {
            available = false;
          }
        }
      } else configured = field === "apiKey" && !!fallbackConfig.llmApiKey;
      credentials[field] = { configured, masked: configured ? "••••••••" : "" };
    }
    return {
      ...state,
      regionCatalog: BEDROCK_REGION_CATALOG,
      source: stored ? "database" : "environment",
      encryptionAvailable: canEncrypt(appSecret),
      credentialsAvailable: available,
      configured: required(state.provider).every(
        (f) => credentials[f].configured,
      ),
      credentials,
    };
  }
  async function saveProvider(input) {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success)
      throw Object.assign(Error("Invalid provider settings"), { status: 400 });
    const value = parsed.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(17092381)");
      for (const field of fields)
        if (value[field] !== undefined)
          await setSecret(
            `${providerNamespace}.${field}`,
            value.provider,
            value[field],
            client,
          );
      // Enabling is allowed only when every required stored credential can actually be decrypted.
      if (value.enabled)
        for (const field of required(value.provider))
          if (
            !(await getSecret(
              `${providerNamespace}.${field}`,
              value.provider,
              client,
            ))
          )
            throw Object.assign(
              Error("Configure required provider credentials before enabling"),
              { status: 409 },
            );
      const publicValue = Object.fromEntries(
        Object.entries(value).filter(([k]) => !fields.includes(k)),
      );
      await setValue(providerNamespace, publicValue, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return getPublicProvider();
  }
  async function getProviderConfig() {
    const value = await getValue(providerNamespace);
    if (!value)
      return allowEnvironmentFallback
        ? { ...envConfig }
        : {
            llmEnabled: false,
            llmAutoClassify: false,
            llmAutoApply: false,
            llmApiKey: "",
            llmAccessKeyId: "",
            llmSecretAccessKey: "",
          };
    const config = {
      ...fallbackConfig,
      llmProvider: value.provider,
      llmModel: value.model,
      llmRegion: value.region,
      llmBaseUrl:
        value.provider === "openai" ? "https://api.openai.com/v1/" : "",
      llmAutoClassify: value.enabled,
      llmAutoApply: value.autoApply,
      llmDailyRequestLimit: value.dailyRequestLimit,
      llmBatchSize: value.batchSize,
      llmApiKey: "",
      llmAccessKeyId: "",
      llmSecretAccessKey: "",
      llmEnabled: value.enabled,
    };
    try {
      const names = {
        apiKey: "llmApiKey",
        accessKeyId: "llmAccessKeyId",
        secretAccessKey: "llmSecretAccessKey",
      };
      for (const [field, name] of Object.entries(names))
        config[name] =
          (await getSecret(`${providerNamespace}.${field}`, value.provider)) ||
          "";
      if (
        value.provider === "bedrock" &&
        config.llmAccessKeyId.startsWith("ASIA")
      )
        throw Error("Temporary credentials unsupported");
      if (!required(value.provider).every((f) => config[names[f]]))
        throw Error("Missing credentials");
    } catch {
      config.llmAutoClassify = false;
      config.llmEnabled = false;
      config.llmApiKey = "";
      config.llmAccessKeyId = "";
      config.llmSecretAccessKey = "";
      config.llmCredentialsUnavailable = true;
      config.llmDisabledReason =
        "Stored credentials unavailable; verify APP_SECRET or replace credentials";
    }
    return config;
  }
  async function rotateSecrets(newSecret) {
    if (!canEncrypt(newSecret))
      throw Object.assign(
        Error("New APP_SECRET must contain strong random material"),
        { status: 400 },
      );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "LOCK TABLE encrypted_credentials IN ACCESS EXCLUSIVE MODE",
      );
      const rows = (await client.query("SELECT * FROM encrypted_credentials"))
        .rows;
      for (const row of rows)
        await client.query(
          "UPDATE encrypted_credentials SET ciphertext=$3,updated_at=now() WHERE setting=$1 AND provider=$2",
          [
            row.setting,
            row.provider,
            encryptSecret(
              decryptSecret(
                row.ciphertext,
                appSecret,
                row.setting,
                row.provider,
              ),
              newSecret,
              row.setting,
              row.provider,
            ),
          ],
        );
      await client.query("COMMIT");
      return rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    assertEncryptionReady: () => {
      if (!canEncrypt(appSecret))
        throw Object.assign(
          Error(
            "APP_SECRET must be configured with strong random material before saving credentials",
          ),
          { status: 409 },
        );
    },
    init: async () =>
      pool.query(
        await readFile(
          new URL("../migrations/005_settings.sql", import.meta.url),
          "utf8",
        ),
      ),
    getPublicProvider,
    saveProvider,
    getProviderConfig,
    setSecret,
    getSecret,
    clearSecret,
    getValue,
    setValue,
    rotateSecrets,
  };
}
