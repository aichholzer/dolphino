import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, getCACertificates } from 'node:tls';

function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) {
    throw Error(`${name} is required; no database fallback exists`);
  }

  return env[name];
}

function readPassword(env) {
  const direct = env.PGPASSWORD || '';
  if (!env.PGPASSWORD_FILE) {
    if (typeof direct !== 'string' || !direct) {
      throw Error('PGPASSWORD or PGPASSWORD_FILE is required; no database fallback exists');
    }

    return direct;
  }

  if (!isAbsolute(env.PGPASSWORD_FILE)) {
    throw Error('PGPASSWORD_FILE must be an absolute path');
  }

  let file;
  try {
    file = readFileSync(env.PGPASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
  } catch {
    throw Error('PGPASSWORD_FILE must be a readable password file');
  }

  if (!file || (direct && direct !== file)) {
    throw Error('PGPASSWORD_FILE is empty or conflicts with PGPASSWORD');
  }

  return file;
}

function certificateAuthorities(path) {
  if (!path || path === 'system') {
    // Node's bundled public roots and the runtime OS store, independent of CLI flags.
    // This affects PostgreSQL only; it does not change global TLS trust.
    return [...new Set([...getCACertificates('bundled'), ...getCACertificates('system')])];
  }

  if (!isAbsolute(path)) {
    throw Error('PGSSLROOTCERT must be system or an absolute path to a PEM CA bundle');
  }

  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 1024 * 1024) {
      throw Error('Invalid certificate file');
    }

    const pem = readFileSync(path, 'utf8');
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (
      !certificates?.length ||
      /-----BEGIN (?!CERTIFICATE-----)/.test(pem) ||
      /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/.test(
        pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '')
      )
    ) {
      throw Error('Invalid certificate bundle');
    }

    for (const certificate of certificates) {
      new X509Certificate(certificate);
    }

    return certificates;
  } catch {
    throw Error('PGSSLROOTCERT must be a readable PEM CA bundle (at most 1 MiB); no TLS fallback is allowed');
  }
}

function isLoopback(host) {
  if (host === 'localhost' || host === '::1') {
    return true;
  }

  if (isIP(host) === 4) {
    return host.startsWith('127.');
  }

  // Canonicalize IPv6 and recognize its IPv4-mapped loopback form as local too.
  if (isIP(host) === 6) {
    const canonical = new URL(`http://[${host}]/`).hostname;
    return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
  }

  return false;
}

/** Explicit pg options shared by every application/maintenance entry point. */
export function readPostgresConfig(env = process.env, { warn = process.emitWarning } = {}) {
  if (env.DATABASE_URL || env.DATABASE_URL_FILE) {
    throw Error(
      'DATABASE_URL and DATABASE_URL_FILE are no longer supported; configure PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD'
    );
  }

  const host = required(env, 'PGHOST').trim();
  const labels = host.replace(/\.$/, '').split('.');
  if (
    host.includes('%') ||
    (!isIP(host) &&
      (host.length > 253 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))))
  ) {
    throw Error('PGHOST must be one hostname or IP address, without a scheme, port, list or socket path');
  }

  const port = env.PGPORT || '5432';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw Error('PGPORT must be an integer between 1 and 65535');
  }

  const database = required(env, 'PGDATABASE');
  const user = required(env, 'PGUSER');
  const password = readPassword(env);
  const mode = env.PGSSLMODE || (isLoopback(host.toLowerCase()) ? 'disable' : '');
  if (!mode) {
    throw Error('Set PGSSLMODE explicitly for off-host PostgreSQL: verify-full (recommended), require or disable');
  }

  if (!['disable', 'require', 'verify-full'].includes(mode)) {
    throw Error('PGSSLMODE must be disable, require or verify-full; fallback modes are not supported');
  }

  if (env.PGSSLROOTCERT && mode !== 'verify-full') {
    throw Error(
      'PGSSLROOTCERT requires PGSSLMODE=verify-full; remove the CA setting only if unverified TLS/plain TCP is intentional'
    );
  }

  let ssl = false;
  if (mode === 'verify-full') {
    ssl = {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ca: certificateAuthorities(env.PGSSLROOTCERT),
      // pg supplies SNI for DNS hosts but not IP literals. Always check PGHOST,
      // including IP SANs, rather than TLS's default socket hostname.
      checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate)
    };
  } else if (mode === 'require') {
    warn(
      'PGSSLMODE=require encrypts PostgreSQL traffic but does not authenticate the server. Use verify-full to prevent impersonation.',
      {
        code: 'DOLPHINO_UNVERIFIED_POSTGRES_TLS'
      }
    );
    ssl = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
  }

  return { host, port: Number(port), database, user, password, ssl };
}
