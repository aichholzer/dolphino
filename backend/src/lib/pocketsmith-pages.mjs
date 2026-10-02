import { parsePocketSmithJson, pocketSmithDate, pocketSmithId, pocketSmithTimestamp } from './pocketsmith-data.mjs';

const origin = 'https://api.pocketsmith.com';
const fail = (code) => {
  throw Object.assign(new Error(`pocketsmith_${code}`), { code: `pocketsmith_${code}` });
};

export function pocketSmithTransactionUrl({ transactionAccountId, startDate, endDate, updatedSince, page = 1 }) {
  if ((startDate === undefined) !== (endDate === undefined)) {
    fail('both_dates_required');
  }

  const url = new URL(`/v2/transaction_accounts/${pocketSmithId(transactionAccountId)}/transactions`, origin);
  if (startDate !== undefined) {
    pocketSmithDate(startDate);
    pocketSmithDate(endDate);
    if (startDate > endDate || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 3660) {
      fail('invalid_date_window');
    }

    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
  }

  if (updatedSince !== undefined) {
    url.searchParams.set('updated_since', pocketSmithTimestamp(updatedSince));
  }

  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
    fail('invalid_page');
  }

  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '500');
  return url;
}

function allowedUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    fail('unsafe_page_url');
  }

  if (
    typeof input !== 'string' ||
    input.length > 2048 ||
    /[\s\\]/.test(input) ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/v2\/transaction_accounts\/[1-9]\d{0,18}\/transactions$/.test(url.pathname)
  ) {
    fail('unsafe_page_url');
  }

  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['start_date', 'end_date', 'updated_since', 'page', 'per_page'].includes(key)) ||
    url.searchParams.get('per_page') !== '500' ||
    !/^[1-9]\d{0,3}$/.test(url.searchParams.get('page') || '')
  ) {
    fail('invalid_page_query');
  }

  const expected = pocketSmithTransactionUrl({
    transactionAccountId: url.pathname.split('/')[3],
    startDate: url.searchParams.get('start_date') ?? undefined,
    endDate: url.searchParams.get('end_date') ?? undefined,
    updatedSince: url.searchParams.get('updated_since') ?? undefined,
    page: Number(url.searchParams.get('page'))
  });
  expected.searchParams.sort();
  url.searchParams.sort();
  if (url.href !== expected.href) {
    fail('invalid_page_query');
  }

  return url;
}

// Parse only the documented Link header shape. Unexpected extensions fail
// closed; splitting blindly on commas would misread quoted parameter values.
function linksFromHeader(value) {
  if (value === undefined || value === '') {
    return new Map();
  }

  if (typeof value !== 'string' || value.length > 10000) {
    fail('invalid_pagination');
  }

  const links = new Map();
  let rest = value;
  while (rest) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="(first|last|next|prev)"\s*(?:,\s*|$)/.exec(rest);
    if (!match || links.has(match[2])) {
      fail('invalid_pagination');
    }

    links.set(match[2], match[1]);
    rest = rest.slice(match[0].length);
  }

  return links;
}

export function pocketSmithNextPage(currentInput, headers, count) {
  const current = allowedUrl(currentInput);
  const nextLinks = linksFromHeader(headers.link);
  const currentPage = Number(current.searchParams.get('page'));
  if (headers['per-page'] === undefined || headers.total === undefined) {
    fail('missing_pagination_headers');
  }

  if (!Number.isSafeInteger(count) || count < 0 || count > 500) {
    fail('invalid_page_size');
  }

  const hasCounts = headers['per-page'] !== undefined || headers.total !== undefined;
  let total = null;
  if (hasCounts) {
    if (String(headers['per-page']) !== '500' || !/^\d{1,7}$/.test(String(headers.total))) {
      fail('invalid_pagination');
    }

    total = Number(headers.total);
    const expectedCount = Math.min(500, Math.max(0, total - (currentPage - 1) * 500));
    if (count !== expectedCount) {
      fail('inconsistent_page_count');
    }
  }

  for (const [relation, target] of nextLinks) {
    const linked = allowedUrl(target);
    const linkedPage = Number(linked.searchParams.get('page'));
    linked.searchParams.set('page', String(currentPage));
    linked.searchParams.sort();
    if (linked.href !== current.href) {
      fail('changed_page_scope');
    }

    if (
      (relation === 'next' && linkedPage !== currentPage + 1) ||
      (relation === 'prev' && linkedPage !== currentPage - 1) ||
      (relation === 'first' && linkedPage !== 1) ||
      (relation === 'last' && linkedPage < currentPage)
    ) {
      fail('invalid_page_sequence');
    }
  }

  const next = nextLinks.get('next');
  if (next) {
    if (!count || count < 500 || (total !== null && currentPage * 500 >= total)) {
      fail('inconsistent_pagination');
    }

    return allowedUrl(next);
  }

  if ((total !== null && currentPage * 500 < total) || (total === null && count === 500)) {
    // Missing headers must never turn a full page into a successful import.
    fail('incomplete_pagination');
  }

  return null;
}

export function pocketSmithRetryDelay(headers, attempt, now = Date.now()) {
  const retryAfter = headers['retry-after'];
  let requested = 0;
  if (retryAfter !== undefined && (typeof retryAfter !== 'string' || retryAfter.length > 80)) {
    fail('retry_after_out_of_range');
  }

  if (typeof retryAfter === 'string' && retryAfter.length <= 80) {
    requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - now) || 0;
  }

  // This is Dolphino's conservative policy, not a claimed PocketSmith limit.
  const backoff = 60000 * 2 ** Math.min(10, Math.max(0, Number.isSafeInteger(attempt) ? attempt : 0));
  if (requested > 10 * 366 * 86400000) {
    fail('retry_after_out_of_range');
  }

  return Math.max(backoff, requested);
}

// Authentication and secure HTTPS are supplied by the client; pagination never
// chooses credential destinations or constructs authentication headers.
export async function readPocketSmithTransactionPages(query, { read, maxPages = 100, maxBytes = 16 * 1024 * 1024 }) {
  if (query.startDate === undefined || query.endDate === undefined) {
    fail('bounded_window_required');
  }

  if (query.page !== undefined && query.page !== 1) {
    fail('invalid_first_page');
  }

  if (typeof read !== 'function' || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    fail('invalid_reader');
  }

  let url = pocketSmithTransactionUrl(query),
    bytes = 0,
    total = null;
  const records = [],
    pages = [],
    identities = new Set();
  const startedAt = Date.now();
  while (url) {
    if (Date.now() - startedAt > 120000) {
      fail('pagination_deadline');
    }

    if (pages.length >= maxPages) {
      fail('page_limit');
    }

    const response = await read(url);
    if (!response || response.status !== 200) {
      const code = [401, 403].includes(response?.status)
        ? 'access_denied'
        : response?.status === 429
          ? 'rate_limited'
          : 'request_failed';
      fail(code);
    }

    if (typeof response.body !== 'string' || (bytes += Buffer.byteLength(response.body, 'utf8')) > maxBytes) {
      fail('response_limit');
    }

    const rows = parsePocketSmithJson(response.body);
    if (!Array.isArray(rows)) {
      fail('invalid_transaction_page');
    }

    const headers = response.headers || {};
    if (pages.length && (headers.total ?? null) !== total) {
      // A moving collection can skip records with offset pagination. Retry the
      // complete window; callers receive no partial success or cursor here.
      fail('collection_changed');
    }

    total = headers.total ?? null;
    const next = pocketSmithNextPage(url.href, headers, rows.length);
    for (const row of rows) {
      const id = pocketSmithId(row?.id);
      if (identities.has(id) || pocketSmithId(row?.transaction_account?.id) !== query.transactionAccountId) {
        fail('inconsistent_transaction_page');
      }

      pocketSmithDate(row.date);
      if (row.date < query.startDate || row.date > query.endDate) {
        fail('transaction_outside_window');
      }

      identities.add(id);
      records.push(row);
    }

    pages.push({ url: url.href, body: response.body });
    url = next;
  }

  // Absence is never a deletion signal. A successful result conveys only the
  // records returned for this query, not proof of upstream completeness.
  return { records, pages, query: { ...query } };
}
