import { readFileSync } from 'node:fs';
import { readPostgresConfig } from './postgres-config.js';
import { parseTrustedProxies } from './http/client-ip.mjs';
export function secret(env, name) {
  return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : env[name] || '';
}
// Renamed settings accept legacy deployments but never silently choose between conflicting values.
export function brandedSetting(env, suffix) {
  function value(name) {
    const direct = env[name] || '';
    const file = env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : '';
    if (direct && file && direct !== file) {
      throw Error(`Conflicting ${name} and ${name}_FILE configuration`);
    }
    return file || direct;
  }
  const current = value(`DOLPHINO_${suffix}`),
    legacy = value(`PROFE_${suffix}`);
  if (current && legacy && current !== legacy) {
    throw Error(`Conflicting DOLPHINO_${suffix} and legacy PROFE_${suffix} configuration`);
  }
  return current || legacy;
}
export function readConfig(env = process.env) {
  const mode = brandedSetting(env, 'MODE') || 'demo';
  if (!['demo', 'live'].includes(mode)) {
    throw Error('DOLPHINO_MODE must be demo or live');
  }
  const config = {
    mode,
    port: Number(env.PORT || 3001),
    host: env.HOST || '0.0.0.0',
    database: readPostgresConfig(env),
    trustProxy: parseTrustedProxies(env.TRUST_PROXY),
    bootstrapToken: brandedSetting(env, 'BOOTSTRAP_TOKEN'),
    appSecret: secret(env, 'APP_SECRET'),
    origin: env.APP_ORIGIN || 'http://localhost:3001',
    currency: brandedSetting(env, 'CURRENCY') || 'AUD',
    timezone: brandedSetting(env, 'TIMEZONE') || 'Australia/Brisbane'
  };
  let origin;
  try {
    origin = new URL(config.origin);
  } catch {
    throw Error('APP_ORIGIN must be a valid origin');
  }
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (mode === 'live' && origin.protocol !== 'https:') ||
    !['http:', 'https:'].includes(origin.protocol)
  ) {
    throw Error('APP_ORIGIN must be an origin; live mode requires HTTPS');
  }
  config.origin = origin.origin;
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  if (!/^[A-Z]{3}$/.test(config.currency)) {
    throw Error('Invalid currency');
  }
  return config;
}
