import { readFileSync } from "node:fs";
export function secret(env, name) {
  return env[`${name}_FILE`]
    ? readFileSync(env[`${name}_FILE`], "utf8").trim()
    : env[name] || "";
}
export function readConfig(env = process.env) {
  const mode = env.PROFE_MODE || "demo";
  if (!["demo", "live"].includes(mode))
    throw Error("PROFE_MODE must be demo or live");
  const config = {
    mode,
    port: Number(env.PORT || 3001),
    host: env.HOST || "0.0.0.0",
    databaseUrl: secret(env, "DATABASE_URL"),
    bootstrapToken: secret(env, "PROFE_BOOTSTRAP_TOKEN"),
    appSecret: secret(env, "APP_SECRET"),
    origin: env.APP_ORIGIN || "http://localhost:3001",
    currency: env.PROFE_CURRENCY || "AUD",
    timezone: env.PROFE_TIMEZONE || "Australia/Brisbane",
    redbarkApiKey: secret(env, "REDBARK_API_KEY"),
    redbarkWebhookSecret: secret(env, "REDBARK_WEBHOOK_SECRET"),
    redbarkVersion: env.REDBARK_VERSION || "2026-10-01.wattle",
    redbarkBackfillDays: Number(env.REDBARK_BACKFILL_DAYS || 90),
    llmApiKey: secret(env, "LLM_API_KEY"),
    llmBaseUrl: env.LLM_BASE_URL || "",
    llmModel: env.LLM_MODEL || "",
    llmAutoClassify: env.LLM_AUTO_CLASSIFY !== "false",
    llmAutoApply: env.LLM_AUTO_APPLY === "true",
    llmDailyRequestLimit: Number(env.LLM_DAILY_REQUEST_LIMIT || 20),
    llmBatchSize: Number(env.LLM_BATCH_SIZE || 5),
  };
  for (const [name, value, max] of [
    ["LLM_DAILY_REQUEST_LIMIT", config.llmDailyRequestLimit, 1000],
    ["LLM_BATCH_SIZE", config.llmBatchSize, 20],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw Error(`${name} must be an integer from 1 to ${max}`);
  }
  for (const name of ["LLM_AUTO_CLASSIFY", "LLM_AUTO_APPLY"])
    if (env[name] !== undefined && !["true", "false"].includes(env[name]))
      throw Error(`${name} must be true or false`);
  if (!config.databaseUrl)
    throw Error(
      "DATABASE_URL or DATABASE_URL_FILE is required; no database fallback exists",
    );
  let origin;
  try {
    origin = new URL(config.origin);
  } catch {
    throw Error("APP_ORIGIN must be a valid origin");
  }
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (mode === "live" && origin.protocol !== "https:") ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw Error("APP_ORIGIN must be an origin; live mode requires HTTPS");
  config.origin = origin.origin;
  new Intl.DateTimeFormat("en", { timeZone: config.timezone });
  if (!/^[A-Z]{3}$/.test(config.currency)) throw Error("Invalid currency");
  return config;
}
