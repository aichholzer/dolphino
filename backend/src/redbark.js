import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const REDBARK_VERSION = '2026-10-01.wattle';
const BASE = 'https://api.redbark.com/v2/';
const listSchema = z.object({
  data: z.array(z.unknown()),
  next_page_url: z.string().nullable()
});
const moneySchema = z.object({
  amount: z.number().int().safe(),
  currency: z.string().regex(/^[a-zA-Z]{3}$/)
});
const transactionSchema = z
  .object({
    id: z.string().startsWith('txn_'),
    account: z.string(),
    amount: moneySchema,
    status: z.enum(['posted', 'pending']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string(),
    provider_category: z.string().nullable().optional(),
    category: z.string().nullable().optional()
  })
  .passthrough();
export class RedbarkError extends Error {
  constructor(code, status = 502, retryAfter = 60) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export function verifyRedbarkSignature(header, rawBody, secret, now = Date.now()) {
  if (!secret || typeof header !== 'string' || header.length > 2048) {
    return false;
  }
  const parts = header.split(',').map((s) => s.trim());
  const timestamps = parts.filter((p) => p.startsWith('t='));
  if (timestamps.length !== 1 || !/^t=\d+$/.test(timestamps[0])) {
    return false;
  }
  const timestamp = timestamps[0].slice(2);
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(rawBody)
    .digest();
  return parts
    .filter((p) => /^v1=[a-fA-F0-9]{64}$/.test(p))
    .some((p) => timingSafeEqual(Buffer.from(p.slice(3), 'hex'), expected));
}
export function parseThinEvent(rawBody) {
  let value;
  try {
    value = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new RedbarkError('invalid_event', 400);
  }
  const parsed = z
    .object({
      id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
      object: z.literal('event'),
      type: z.string().max(100),
      created: z.string().datetime(),
      livemode: z.boolean()
    })
    .passthrough()
    .safeParse(value);
  if (!parsed.success || value.data?.new || value.data?.updated) {
    throw new RedbarkError('thin_events_only', 400);
  }
  return parsed.data;
}
// Only documented provider vocabulary is authoritative; custom category names are labels.
const EXPENSE_CATEGORIES = new Set([
  'BANK_FEES',
  'ENTERTAINMENT',
  'FOOD_AND_DRINK',
  'GOVERNMENT_AND_NON_PROFIT',
  'HOME_IMPROVEMENT',
  'MEDICAL',
  'MERCHANDISE',
  'PERSONAL_CARE',
  'RENT_AND_UTILITIES',
  'SERVICES',
  'TRANSPORTATION',
  'TRAVEL'
]);
export function providerClassification(t) {
  const category = t.provider_category;
  if (category === 'TRANSFER_IN' || category === 'TRANSFER_OUT') {
    return {
      kind: 'transfer',
      reviewReason: 'Classification review: confirm provider transfer is internal or a card repayment'
    };
  }
  if (category === 'INCOME' && t.amount.amount >= 0) {
    return { kind: 'income' };
  }
  if (EXPENSE_CATEGORIES.has(category)) {
    return t.amount.amount > 0
      ? {
          kind: 'refund',
          reviewReason:
            'Classification review: credit in spending category treated as provisional refund; confirm category and kind'
        }
      : { kind: 'expense' };
  }
  return {
    kind: t.amount.amount < 0 ? 'expense' : 'income',
    reviewReason:
      category === 'LOAN_PAYMENTS'
        ? 'Classification review: loan payment may include principal, interest or card repayment; set kind or split explicitly'
        : 'Classification review: provider gives insufficient evidence to distinguish income, refund, spending or transfer'
  };
}
export function normalizeTransaction(raw, accountId, fetchedAt) {
  const parsed = transactionSchema.safeParse(raw);
  if (!parsed.success || raw.account !== accountId) {
    throw new RedbarkError('invalid_provider_transaction');
  }
  const t = parsed.data;
  const classification = providerClassification(t);
  const date = t.status === 'posted' && t.post_date ? t.post_date : t.date;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) {
    throw new RedbarkError('invalid_provider_date');
  }
  return {
    provider: 'redbark',
    sourceId: t.id,
    accountId,
    amountMinor: String(t.amount.amount),
    currency: t.amount.currency.toUpperCase(),
    status: t.status,
    date,
    ...classification,
    description: t.description,
    category: t.category || t.provider_category || undefined,
    fetchedAt,
    raw,
    mode: 'live'
  };
}
export function configurationFingerprint(config) {
  return createHash('sha256')
    .update(
      `${config.redbarkApiKey || ''}\0${config.redbarkVersion || REDBARK_VERSION}\0${config.redbarkRevision || ''}`
    )
    .digest('hex');
}
export function boundedDates(from, to) {
  const valid = (s) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366 * 7) {
    throw new RedbarkError('invalid_backfill_window', 400);
  }
}
export class RedbarkClient {
  constructor({ apiKey, version = REDBARK_VERSION, fetchImpl }) {
    this.apiKey = apiKey;
    this.version = version;
    this.fetch = fetchImpl || fetch;
    this.minInterval = fetchImpl ? 0 : 2100;
    this.lastRequestAt = 0;
  }
  async request(path, { method = 'GET', body: requestBody, idempotencyKey } = {}) {
    const url = new URL(path, BASE);
    // Never send credentials to a URL supplied by event payloads or cross-origin pagination.
    if (url.origin !== new URL(BASE).origin || !url.pathname.startsWith('/v2/') || url.username || url.password) {
      throw new RedbarkError('unsafe_provider_url');
    }
    const wait = this.lastRequestAt + this.minInterval - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
    let response;
    try {
      response = await this.fetch(url.href, {
        method,
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
        headers: {
          ...(requestBody === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          Authorization: `Bearer ${this.apiKey}`,
          'Redbark-Version': this.version
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw new RedbarkError('provider_unreachable');
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds =
        retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : 60;
      throw new RedbarkError(
        `provider_http_${response.status}`,
        response.status,
        Number.isFinite(seconds) ? Math.max(1, seconds) : 60
      );
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RedbarkError('invalid_provider_json');
    }
    return {
      body,
      truncated: response.headers.get('x-redbark-truncated') === 'true'
    };
  }
  async list(path) {
    const result = [];
    const seen = new Set();
    while (path) {
      if (seen.has(path) || seen.size >= 10000) {
        throw new RedbarkError('pagination_loop');
      }
      seen.add(path);
      const { body } = await this.request(path);
      const parsed = listSchema.safeParse(body);
      if (!parsed.success) {
        throw new RedbarkError('invalid_provider_list');
      }
      result.push(...parsed.data.data);
      path = parsed.data.next_page_url;
    }
    return result;
  }
  async accounts() {
    return this.list('accounts?limit=100');
  }
  async balance(id) {
    return (await this.request(`accounts/${encodeURIComponent(id)}/balance`)).body;
  }
  async transactions(accountId, from, to) {
    boundedDates(from, to);
    const rows = [];
    const seen = new Set();
    let path = `transactions?${new URLSearchParams({ account: accountId, from, to, limit: '100', include_pending: 'true' })}`;
    while (path) {
      if (seen.has(path) || seen.size >= 10000) {
        throw new RedbarkError('pagination_loop');
      }
      seen.add(path);
      const { body, truncated } = await this.request(path);
      if (truncated) {
        if (from === to) {
          throw new RedbarkError('single_day_truncated');
        }
        const midpoint = Math.floor((Date.parse(from) + Date.parse(to)) / 2 / 86400000) * 86400000;
        const middle = new Date(midpoint).toISOString().slice(0, 10);
        const next = new Date(midpoint + 86400000).toISOString().slice(0, 10);
        return [
          ...(await this.transactions(accountId, from, middle)),
          ...(await this.transactions(accountId, next, to))
        ];
      }
      const parsed = listSchema.safeParse(body);
      if (!parsed.success) {
        throw new RedbarkError('invalid_provider_list');
      }
      rows.push(...parsed.data.data);
      path = parsed.data.next_page_url;
    }
    return rows;
  }
}
