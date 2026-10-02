import { readFileSync } from 'node:fs';
import { readPostgresConfig } from './postgres-config.mjs';
import { parseTrustedProxies } from '../http/client-ip.mjs';
export function secret(env, name) {
  return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : env[name] || '';
}

// Deployment values use one canonical name; disagreeing direct/file inputs fail closed.
export function deploymentSetting(env, suffix) {
  const name = `DOLPHINO_${suffix}`;
  const direct = env[name] || '';
  const file = env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : '';
  if (direct && file && direct !== file) {
    throw Error(`Conflicting ${name} and ${name}_FILE configuration`);
  }

  return file || direct;
}

export function readConfig(env = process.env) {
  const mode = deploymentSetting(env, 'MODE') || 'demo';
  if (!['demo', 'live'].includes(mode)) {
    throw Error('DOLPHINO_MODE must be demo or live');
  }

  const config = {
    mode,
    port: Number(env.PORT || 3001),
    host: env.HOST || '0.0.0.0',
    database: readPostgresConfig(env),
    trustProxy: parseTrustedProxies(env.TRUST_PROXY),
    bootstrapToken: deploymentSetting(env, 'BOOTSTRAP_TOKEN'),
    appSecret: secret(env, 'APP_SECRET'),
    origin: env.APP_ORIGIN || 'http://localhost:3001',
    currency: deploymentSetting(env, 'CURRENCY') || 'AUD',
    timezone: deploymentSetting(env, 'TIMEZONE') || 'Australia/Brisbane'
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
