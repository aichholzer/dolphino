import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { publicSmtpAddress } from './smtp-network.js';
import { decimalToMinor } from '../../shared/money.js';
import { minor } from './engine.js';

export class SimplefinError extends Error {
  constructor(code, status = 502, retryAfter = 0) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.expose = true;
  }
}
const fail = (code = 'simplefin_invalid_response', status) => {
  throw new SimplefinError(code, status);
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
// These ranges deliberately reject control bytes in provider input. Display
// text also removes bidi controls; raw records preserve tabs and newlines.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const unsafeDisplayCharacters = /[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const unsafeRecordCharacters = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function parseSimplefinUrl(input, access = false) {
  if (typeof input !== 'string' || input.length > 8192 || /[\s\\]/.test(input) || controlCharacters.test(input)) {
    fail('simplefin_invalid_url', 400);
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    fail('simplefin_invalid_url', 400);
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.hash ||
    url.search ||
    !/^[a-z0-9.-]+$/.test(host) ||
    !host.includes('.') ||
    host.endsWith('.') ||
    isIP(host) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host) ||
    /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(url.pathname) ||
    (access ? !url.username || !url.password : !!url.username || !!url.password)
  ) {
    fail('simplefin_unsafe_url', 400);
  }
  let authorization,
    secrets = [];
  if (access) {
    let username, password;
    try {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      fail('simplefin_invalid_credentials', 400);
    }
    if (username.includes(':') || controlCharacters.test(username) || controlCharacters.test(password)) {
      fail('simplefin_invalid_credentials', 400);
    }
    authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    secrets = [input, url.username, url.password, username, password, authorization, authorization.slice(6)];
    url.username = '';
    url.password = '';
  }
  return { url, authorization, secrets };
}
export function parseSetupToken(token) {
  if (
    typeof token !== 'string' ||
    token.length < 8 ||
    token.length > 12000 ||
    !/^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+={0,2})$/.test(token)
  ) {
    fail('simplefin_invalid_setup_token', 400);
  }
  const raw = Buffer.from(token, 'base64');
  if (
    raw.toString('base64url') !== token.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') ||
    (token.includes('=') && token.length % 4 !== 0)
  ) {
    fail('simplefin_invalid_setup_token', 400);
  }
  const decoded = raw.toString('utf8');
  if (!Buffer.from(decoded).equals(raw)) {
    fail('simplefin_invalid_setup_token', 400);
  }
  const { url } = parseSimplefinUrl(decoded);
  if (!/\/claim\/[^/]+$/.test(url.pathname)) {
    fail('simplefin_invalid_claim_path', 400);
  }
  return url;
}
// DNS is validated on every request, then pinned into HTTPS's lookup callback.
// No global agents, proxies, redirects or second DNS lookup can change the target.
export async function secureSimplefinRequest(
  url,
  {
    method = 'GET',
    authorization,
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 20000,
    lookupImpl = lookup,
    requestImpl = https.request
  } = {}
) {
  // Revalidate the target after query parameters have been built internally.
  const base = new URL(url);
  base.search = '';
  parseSimplefinUrl(base.href);
  let addresses, dnsTimer;
  try {
    addresses = await Promise.race([
      lookupImpl(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        dnsTimer = setTimeout(() => reject(new SimplefinError('simplefin_dns_timeout')), timeoutMs);
      })
    ]);
  } catch {
    fail('simplefin_dns_unavailable');
  } finally {
    clearTimeout(dnsTimer);
  }
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some((entry) => !publicSmtpAddress(entry.address) || isIP(entry.address) !== entry.family)
  ) {
    fail('simplefin_non_public_address', 400);
  }
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    let req,
      timer,
      settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        req?.destroy();
      } else {
        resolve(value);
      }
    };
    try {
      req = requestImpl(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method,
          servername: url.hostname,
          rejectUnauthorized: true,
          agent: false,
          lookup: (_host, options, callback) => {
            if (typeof options === 'function') {
              callback = options;
              options = {};
            }
            callback(null, options?.all ? [address] : address.address, address.family);
          },
          headers: {
            Accept: 'application/json, text/plain',
            'Accept-Encoding': 'identity',
            ...(authorization ? { Authorization: authorization } : {}),
            ...(method === 'POST' ? { 'Content-Length': '0' } : {})
          }
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            res.resume();
            return finish(new SimplefinError('simplefin_redirect_rejected'));
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              finish(new SimplefinError('simplefin_response_too_large'));
            } else {
              chunks.push(chunk);
            }
          });
          res.on('aborted', () => finish(new SimplefinError('simplefin_response_interrupted')));
          res.on('error', () => finish(new SimplefinError('simplefin_response_failed')));
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          );
        }
      );
      req.on('error', () => finish(new SimplefinError('simplefin_network_failed')));
      timer = setTimeout(() => finish(new SimplefinError('simplefin_request_timeout')), timeoutMs);
      req.end();
    } catch {
      finish(new SimplefinError('simplefin_network_failed'));
    }
  });
}
function checkResponse(response) {
  if (response.status === 429) {
    const header = response.headers?.['retry-after'];
    const seconds = /^\d+$/.test(String(header)) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
    // Never shorten a valid provider delay. Unreasonably large/unrepresentable
    // delays fail closed and require explicit reconnection instead of retrying early.
    if ((/^\d+$/.test(String(header)) && !Number.isFinite(seconds)) || seconds > 10 * 365 * 86400) {
      fail('simplefin_retry_after_out_of_range');
    }
    failWithRetry(Math.max(60, Number.isFinite(seconds) ? seconds : 60));
  }
  if (response.status !== 200) {
    fail(`simplefin_http_${Number.isInteger(response.status) ? response.status : 'failed'}`);
  }
}
const failWithRetry = (seconds) => {
  throw new SimplefinError('simplefin_http_429', 502, seconds);
};
export async function claimSetupToken(token, { request = secureSimplefinRequest } = {}) {
  const url = parseSetupToken(token);
  // Never retry this POST. A timeout after sending is ambiguous and may have consumed the token.
  const response = await request(url, { method: 'POST', maxBytes: 8192 });
  checkResponse(response);
  const accessUrl = response.body.trim();
  const parsed = parseSimplefinUrl(accessUrl, true);
  if (parsed.url.origin !== url.origin || parsed.url.pathname.replace(/\/$/, '') !== url.pathname.split('/claim/')[0]) {
    fail('simplefin_claim_origin_or_path_mismatch');
  }
  return accessUrl;
}
export function safeSimplefinText(value, secrets = [], max = 500) {
  let text = typeof value === 'string' ? value : '';
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/https?:\/\/[^\s<>]+/gi, '[link removed]')
    .replace(/<[^>]*>/g, '')
    .replace(unsafeDisplayCharacters, '')
    .slice(0, max);
}
// Preserve provider provenance separately from normalized ledger values. The
// original JSON structure is bounded, and credential material is redacted even
// when a hostile provider reflects it in keys, extras or nested records.
export function redactSimplefinRecord(record, secrets = []) {
  let nodes = 0;
  const scrub = (value, depth) => {
    if (++nodes > 100000 || depth > 12) {
      fail('simplefin_record_too_complex');
    }
    if (typeof value === 'string') {
      if (value.length > 50000) {
        fail('simplefin_record_string_too_long');
      }
      for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
        value = value.split(secret).join('[redacted]');
      }
      return value
        .replace(/https?:\/\/[^\s/@]+:[^\s/@]*@/gi, 'https://[redacted]@')
        .replace(unsafeRecordCharacters, '');
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 10000) {
        fail('simplefin_record_too_complex');
      }
      return value.map((v) => scrub(v, depth + 1));
    }
    const entries = Object.entries(value);
    if (entries.length > 200) {
      fail('simplefin_record_too_complex');
    }
    const result = Object.create(null);
    for (const [key, v] of entries) {
      result[scrub(key, depth + 1)] = scrub(v, depth + 1);
    }
    return result;
  };
  return scrub(record, 0);
}
const providerMessage = (value, secrets) =>
  safeSimplefinText(value, secrets) || 'Provider reported an error (message removed for safety)';
const idString = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 500 && !controlCharacters.test(value);
const currencies = new Set(Intl.supportedValuesOf('currency'));
export function simplefinMoney(value, currency) {
  if (!currencies.has(currency)) {
    fail('simplefin_unsupported_currency');
  }
  if (typeof value !== 'string' || value.length > 40) {
    fail('simplefin_invalid_amount');
  }
  try {
    // Permit only zero digits beyond ISO precision; never round financial data.
    const canonical = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
    const result = decimalToMinor(canonical, currency);
    minor(result);
    return result;
  } catch {
    fail('simplefin_invalid_amount');
  }
}
function timestamp(value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 253402300799) {
    fail('simplefin_invalid_timestamp');
  }
  return new Date(value * 1000).toISOString();
}
export function simplefinAccountKey(account) {
  const org = account?.org;
  if (!idString(account?.id) || !org || (!idString(org.domain) && !idString(org.id) && !idString(org.name))) {
    fail('simplefin_invalid_account_identity');
  }
  return digest(
    JSON.stringify([
      org.domain ? ['domain', org.domain.toLowerCase()] : org.id ? ['id', org.id] : ['name', org.name],
      account.id
    ])
  );
}
export function normalizeSimplefinAccount(raw, { secrets = [] } = {}) {
  const key = simplefinAccountKey(raw);
  if (!idString(raw.name) || typeof raw.currency !== 'string') {
    fail('simplefin_invalid_account');
  }
  const unsupported = !currencies.has(raw.currency);
  if (secrets.some((secret) => secret && raw.id.includes(secret))) {
    fail('simplefin_credential_in_account_identity');
  }
  const result = {
    key,
    remoteId: raw.id,
    name: safeSimplefinText(raw.name, secrets, 200) || 'Bank account',
    institution: safeSimplefinText(raw.org.name || raw.org.domain || 'Institution', secrets, 200),
    currency: unsupported ? 'Unsupported' : raw.currency,
    unsupported,
    balanceMinor: unsupported ? null : simplefinMoney(raw.balance, raw.currency),
    balanceAt: timestamp(raw['balance-date']),
    redbarkId: /^acct_[A-Za-z0-9]+$/.test(raw.extra?.redbark_account_id) ? raw.extra.redbark_account_id : null
  };
  if (!unsupported && raw['available-balance'] !== undefined) {
    simplefinMoney(raw['available-balance'], raw.currency);
  }
  return result;
}
export function normalizeSimplefinTransaction(
  raw,
  account,
  { provider, fetchedAt, timezone = 'Etc/UTC', secrets = [] }
) {
  if (
    !idString(raw?.id) ||
    !idString(raw.description) ||
    (raw.pending !== undefined && typeof raw.pending !== 'boolean')
  ) {
    fail('simplefin_invalid_transaction');
  }
  const pending = raw.pending === true;
  const posted = timestamp(raw.posted, pending);
  const effective = raw.posted === 0 ? timestamp(raw.transacted_at) : posted;
  if (raw.transacted_at !== undefined) {
    timestamp(raw.transacted_at);
  }
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(effective));
  return {
    provider,
    sourceId: digest(raw.id),
    accountId: account.localId,
    currency: account.currency,
    amountMinor: simplefinMoney(raw.amount, account.currency),
    status: pending ? 'pending' : 'posted',
    date,
    description: safeSimplefinText(raw.description, secrets, 500) || 'Transaction',
    fetchedAt
  };
}
export class SimplefinClient {
  constructor(accessUrl, { request = secureSimplefinRequest } = {}) {
    this.parsed = parseSimplefinUrl(accessUrl, true);
    this.request = request;
  }
  async accounts({ start, end, remoteId, balancesOnly = false } = {}) {
    const url = new URL(this.parsed.url);
    url.pathname = url.pathname.replace(/\/$/, '') + '/accounts';
    if (start !== undefined) {
      url.searchParams.set('start-date', String(start));
    }
    if (end !== undefined) {
      url.searchParams.set('end-date', String(end));
    }
    if (remoteId !== undefined) {
      url.searchParams.set('account', remoteId);
    }
    if (balancesOnly) {
      url.searchParams.set('balances-only', '1');
    }
    const response = await this.request(url, {
      authorization: this.parsed.authorization
    });
    checkResponse(response);
    let result;
    try {
      result = JSON.parse(response.body);
    } catch {
      fail();
    }
    if (
      !Array.isArray(result?.accounts) ||
      result.accounts.length > 1000 ||
      !Array.isArray(result.errors) ||
      result.errors.length > 100 ||
      result.errors.some((e) => typeof e !== 'string')
    ) {
      fail();
    }
    const keys = new Set();
    const accounts = result.accounts.map((raw) => {
      const account = normalizeSimplefinAccount(raw, this.parsed);
      if (keys.has(account.key)) {
        fail('simplefin_duplicate_account_identity');
      }
      keys.add(account.key);
      if (raw.transactions !== undefined && (!Array.isArray(raw.transactions) || raw.transactions.length > 10000)) {
        fail();
      }
      if (
        raw.errors !== undefined &&
        (!Array.isArray(raw.errors) || raw.errors.length > 100 || raw.errors.some((e) => typeof e !== 'string'))
      ) {
        fail();
      }
      return {
        ...account,
        errors: (raw.errors || []).map((e) => providerMessage(e, this.parsed.secrets)),
        raw: redactSimplefinRecord(raw, this.parsed.secrets),
        transactions: raw.transactions || []
      };
    });
    return {
      accounts,
      errors: result.errors.map((e) => providerMessage(e, this.parsed.secrets))
    };
  }
}
