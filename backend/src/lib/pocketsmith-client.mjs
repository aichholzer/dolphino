import { secureSimplefinRequest } from './simplefin-client.mjs';
import { parsePocketSmithJson, pocketSmithId } from './pocketsmith-data.mjs';
import { pocketSmithRetryDelay, readPocketSmithTransactionPages } from './pocketsmith-pages.mjs';

export class PocketSmithError extends Error {
  constructor(code, status = 502, retryAfter = 0) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    // Only fixed local codes reach HTTP clients; provider response bodies and
    // unexpected database/transport errors remain private.
    this.expose = /^pocketsmith_[a-z_]+$/.test(code);
  }
}

export function pocketSmithKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(key)) {
    throw new PocketSmithError('pocketsmith_invalid_developer_key', 400);
  }

  return key;
}

export function pocketSmithReadUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new PocketSmithError('pocketsmith_unsafe_url', 400);
  }

  if (
    typeof input !== 'string' ||
    /[\s\\]/.test(input) ||
    url.origin !== 'https://api.pocketsmith.com' ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/v2\/(?:me|users\/[1-9]\d{0,18}\/(?:accounts|transaction_accounts)|transaction_accounts\/[1-9]\d{0,18}(?:\/transactions)?)$/.test(
      url.pathname
    )
  ) {
    throw new PocketSmithError('pocketsmith_unsafe_url', 400);
  }

  if (url.search && !url.pathname.endsWith('/transactions')) {
    throw new PocketSmithError('pocketsmith_unsafe_query', 400);
  }

  return url;
}

export async function securePocketSmithRequest(url, { key, ...dependencies }) {
  const target = pocketSmithReadUrl(url.href);
  try {
    // Reuse the existing DNS validation, TLS pinning, no-redirect transport.
    // All methods and credential destinations are fixed by this wrapper.
    return await secureSimplefinRequest(target, {
      ...dependencies,
      method: 'GET',
      authorization: undefined,
      headers: { 'X-Developer-Key': pocketSmithKey(key) },
      maxBytes: 2 * 1024 * 1024
    });
  } catch (error) {
    throw new PocketSmithError(
      /^simplefin_[a-z_]+$/.test(error.code || '')
        ? error.code.replace('simplefin_', 'pocketsmith_')
        : 'pocketsmith_request_failed'
    );
  }
}

function redactBody(body, key) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) {
    throw new PocketSmithError('pocketsmith_invalid_response');
  }

  // Decode and scrub string tokens, including Unicode-escaped key echoes,
  // while preserving every numeric lexeme for exact amounts and evidence.
  try {
    const scrubbed = body.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
      const value = JSON.parse(token);
      return JSON.stringify(value.split(key).join('[redacted]'));
    });
    if (scrubbed.includes(key)) {
      throw Error('Invalid response');
    }

    return scrubbed;
  } catch {
    throw new PocketSmithError('pocketsmith_invalid_response');
  }
}

export class PocketSmithClient {
  constructor(key, { request = securePocketSmithRequest } = {}) {
    this.key = pocketSmithKey(key);
    this.request = request;
  }
  async read(url) {
    pocketSmithReadUrl(url.href);
    let response;
    try {
      response = await this.request(url, { key: this.key });
    } catch (error) {
      throw new PocketSmithError(error instanceof PocketSmithError ? error.code : 'pocketsmith_request_failed');
    }

    if (response?.status !== 200) {
      const status = response?.status;
      throw new PocketSmithError(
        [401, 403].includes(status)
          ? 'pocketsmith_access_denied'
          : status === 429
            ? 'pocketsmith_rate_limited'
            : status === 404
              ? 'pocketsmith_source_missing'
              : 'pocketsmith_request_failed',
        502,
        [429, 503].includes(status) ? pocketSmithRetryDelay(response.headers || {}, 0) : 0
      );
    }

    return { ...response, body: redactBody(response.body, this.key) };
  }
  async json(path) {
    return parsePocketSmithJson((await this.read(new URL(path, 'https://api.pocketsmith.com'))).body);
  }
  async discover() {
    const user = await this.json('/v2/me');
    const userId = pocketSmithId(user?.id);
    // Sequential requests keep this client conservative without asserting an
    // undocumented provider rate limit.
    const native = await this.json(`/v2/users/${userId}/transaction_accounts`);
    const groups = await this.json(`/v2/users/${userId}/accounts`);
    return { userId, native, groups };
  }
  async account(id) {
    return this.json(`/v2/transaction_accounts/${pocketSmithId(id)}`);
  }
  async transactions(query) {
    return readPocketSmithTransactionPages(query, { read: (url) => this.read(url) });
  }
}
