import { createHash } from 'node:crypto';
import { currencyDigits } from '../../../shared/money.mjs';
import { minor } from './engine.mjs';
import { categoryName, tagsSchema } from './category-catalog.mjs';

// Authentication and persistence deliberately live outside this pure boundary.
// Numeric JSON lexemes must survive decoding: PocketSmith uses JSON numbers for
// monetary amounts, including amounts beyond JavaScript's exact integer range.
const currencies = new Set(Intl.supportedValuesOf('currency'));
const maxInteger = 9223372036854775807n;
const hash = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code) {
  // Never include provider text, raw records, keys or URLs in error messages.
  throw Object.assign(new Error(`pocketsmith_${code}`), { code: `pocketsmith_${code}` });
}

export function parsePocketSmithJson(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) {
    fail('invalid_json');
  }

  let result;
  try {
    result = JSON.parse(body, (_key, value, context) => {
      if (typeof value === 'number') {
        if (typeof context?.source !== 'string') {
          fail('exact_json_unavailable');
        }

        return context.source;
      }

      return value;
    });
  } catch {
    fail('invalid_json');
  }

  const stack = [];
  for (const token of body.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    const value = token[0],
      frame = stack.at(-1);
    if (value === '{' || value === '[') {
      stack.push({ object: value === '{', key: true, keys: new Set() });
    } else if (value === '}' || value === ']') {
      stack.pop();
    } else if (value === ',') {
      if (frame?.object) {
        frame.key = true;
      }
    } else if (frame?.object && frame.key) {
      const key = JSON.parse(value);
      if (frame.keys.has(key)) {
        fail('duplicate_json_key');
      }

      frame.keys.add(key);
      frame.key = false;
    }
  }

  let nodes = 0;
  const inspect = (value, depth) => {
    if (++nodes > 100000 || depth > 32) {
      fail('json_too_complex');
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > (Array.isArray(value) ? 10000 : 200)) {
        fail('json_too_complex');
      }

      for (const [key, child] of entries) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
          fail('unsafe_json_key');
        }

        inspect(child, depth + 1);
      }
    }
  };

  inspect(result, 0);
  return result;
}

export function pocketSmithId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > maxInteger) {
    fail('invalid_id');
  }

  return value;
}

export function pocketSmithMoney(value, currency) {
  if (!currencies.has(currency)) {
    fail('unsupported_currency');
  }

  if (typeof value !== 'string' || value.length > 80) {
    fail('invalid_amount');
  }

  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) {
    fail('invalid_amount');
  }

  const fraction = match[3] || '';
  const scale = currencyDigits(currency) + Number(match[4] || 0) - fraction.length;
  // Bound exponents before constructing powers. No rounding or floating point
  // money is allowed, even when the source includes fractional minor units.
  if (Math.abs(scale) > 100) {
    fail('invalid_amount');
  }

  let amount = BigInt(match[2] + fraction);
  if (scale < 0) {
    const divisor = 10n ** BigInt(-scale);
    if (amount % divisor !== 0n) {
      fail('fractional_minor_units');
    }

    amount /= divisor;
  } else {
    amount *= 10n ** BigInt(scale);
  }

  amount *= match[1] ? -1n : 1n;
  try {
    return minor(amount.toString()).toString();
  } catch {
    fail('invalid_amount');
  }
}

export function pocketSmithDate(value) {
  if (
    typeof value !== 'string' ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    fail('invalid_date');
  }

  return value;
}

export function pocketSmithTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail('invalid_timestamp');
  }

  pocketSmithDate(value.slice(0, 10));
  if (Number(value.slice(11, 13)) > 23) {
    fail('invalid_timestamp');
  }

  // Preserve the source's precision and offset for evidence/version comparisons.
  return value;
}

export function pocketSmithText(value, fallback, maxLength = 200) {
  if (typeof value !== 'string' || value.length > 50000) {
    fail('invalid_text');
  }

  return (
    value
      .replace(/[<>\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, maxLength) || fallback
  );
}

export function pocketSmithAccountId(userId, transactionAccountId) {
  return `ps_${hash(['pocketsmith', pocketSmithId(userId), pocketSmithId(transactionAccountId)])}`;
}

export function normalizePocketSmithAccount(raw, { userId, fetchedAt, group = null }) {
  if (!object(raw)) {
    fail('invalid_account');
  }

  const remoteId = pocketSmithId(raw.id);
  const currency = raw.currency_code;
  if (!currencies.has(currency)) {
    fail('unsupported_currency');
  }

  const hasBalance = raw.current_balance != null;
  const balanceDate = raw.current_balance_date == null ? null : pocketSmithDate(raw.current_balance_date);
  if (hasBalance !== (balanceDate !== null)) {
    fail('incomplete_balance');
  }

  return {
    id: pocketSmithAccountId(userId, remoteId),
    remoteId,
    userId: pocketSmithId(userId),
    name: pocketSmithText(raw.name, 'PocketSmith account'),
    currency,
    balanceMinor: hasBalance ? pocketSmithMoney(raw.current_balance, currency) : null,
    balanceType: 'PocketSmith current',
    // A provider date is not a bank timestamp. Keep the date separately instead
    // of manufacturing a midnight timestamp or claiming the fetch is bank sync.
    balanceAt: null,
    balanceDate,
    fetchedAt: pocketSmithTimestamp(fetchedAt),
    sourceUpdatedAt: raw.updated_at == null ? null : pocketSmithTimestamp(raw.updated_at),
    group,
    balanceMetadata: {
      sourceField: 'current_balance',
      semantics: 'provider-selected',
      nativeCurrency: currency,
      currentBalanceDate: balanceDate,
      currentBalanceInBaseCurrency: raw.current_balance_in_base_currency ?? null,
      currentBalanceExchangeRate: raw.current_balance_exchange_rate ?? null,
      safeBalanceMinor: raw.safe_balance == null ? null : pocketSmithMoney(raw.safe_balance, currency),
      safeBalanceInBaseCurrency: raw.safe_balance_in_base_currency ?? null
    }
  };
}

export function normalizePocketSmithAccounts(nativeAccounts, groupedAccounts, options) {
  if (
    !Array.isArray(nativeAccounts) ||
    nativeAccounts.length > 1000 ||
    !Array.isArray(groupedAccounts) ||
    groupedAccounts.length > 1000
  ) {
    fail('invalid_accounts');
  }

  const membership = new Map(),
    groups = new Set();
  for (const group of groupedAccounts) {
    if (!object(group) || !Array.isArray(group.transaction_accounts) || group.transaction_accounts.length > 1000) {
      fail('invalid_group');
    }

    const id = pocketSmithId(group.id);
    if (groups.has(id)) {
      fail('duplicate_group');
    }

    groups.add(id);
    for (const child of group.transaction_accounts) {
      const childId = pocketSmithId(child?.id);
      if (membership.has(childId)) {
        fail('ambiguous_group_membership');
      }

      membership.set(childId, {
        id,
        name: pocketSmithText(group.title, 'PocketSmith group'),
        currency: group.currency_code
      });
    }
  }

  const identities = new Set();
  return nativeAccounts.map((raw) => {
    const group = membership.get(raw?.id) || null;
    const account = normalizePocketSmithAccount(raw, { ...options, group });
    if (identities.has(account.remoteId)) {
      fail('duplicate_account');
    }

    if (group && group.currency !== account.currency) {
      fail('account_currency_mismatch');
    }

    identities.add(account.remoteId);
    // Group balances and primary_transaction_account are never summed or used
    // to create an extra local account. Only native transaction accounts are.
    return account;
  });
}

function optionalBoolean(value) {
  if (value !== undefined && typeof value !== 'boolean') {
    fail('invalid_boolean');
  }

  return value === true;
}

export function normalizePocketSmithCategory(raw) {
  if (raw == null) {
    return null;
  }

  if (!object(raw)) {
    fail('invalid_category');
  }

  const name = categoryName.safeParse(raw.title);
  if (
    !name.success ||
    ![undefined, null, 'credits_are_refunds', 'debits_are_deductions'].includes(raw.refund_behaviour)
  ) {
    fail('invalid_category');
  }

  return {
    remoteId: pocketSmithId(raw.id),
    name: name.data,
    parentId: raw.parent_id == null ? null : pocketSmithId(raw.parent_id),
    isTransfer: optionalBoolean(raw.is_transfer),
    refundBehaviour: raw.refund_behaviour || null
  };
}

export function normalizePocketSmithTransaction(raw, account, { fetchedAt }) {
  if (
    !object(raw) ||
    !['pending', 'posted'].includes(raw.status) ||
    !['debit', 'credit'].includes(raw.type) ||
    pocketSmithId(raw.transaction_account?.id) !== account.remoteId ||
    raw.transaction_account?.currency_code !== account.currency
  ) {
    fail('invalid_transaction');
  }

  const amountMinor = pocketSmithMoney(raw.amount, account.currency);
  if ((raw.type === 'debit' && BigInt(amountMinor) > 0n) || (raw.type === 'credit' && BigInt(amountMinor) < 0n)) {
    fail('inconsistent_transaction_sign');
  }

  const category = normalizePocketSmithCategory(raw.category);
  const isTransfer = optionalBoolean(raw.is_transfer) || category?.isTransfer === true;
  const labels = tagsSchema.safeParse(raw.labels ?? []);
  if (!labels.success) {
    fail('invalid_labels');
  }

  const kind = isTransfer
    ? 'transfer'
    : BigInt(amountMinor) < 0n
      ? category?.refundBehaviour === 'debits_are_deductions'
        ? 'income'
        : 'expense'
      : category?.refundBehaviour === 'credits_are_refunds'
        ? 'refund'
        : 'income';
  return {
    observation: {
      provider: `pocketsmith:${pocketSmithId(account.userId)}`,
      sourceId: pocketSmithId(raw.id),
      accountId: account.id,
      currency: account.currency,
      amountMinor,
      status: raw.status,
      date: pocketSmithDate(raw.date),
      description: pocketSmithText(raw.payee, 'PocketSmith transaction', 500),
      fetchedAt: pocketSmithTimestamp(fetchedAt),
      kind,
      // Category mapping and label writes require local precedence checks.
      // No provider note or memo is copied into a user's manual correction.
      reviewReason: optionalBoolean(raw.needs_review) ? 'PocketSmith marked this transaction for review' : null
    },
    sourceUpdatedAt: pocketSmithTimestamp(raw.updated_at),
    category,
    tags: labels.data
  };
}

export function pocketSmithTagPlan(imported, current, preferences) {
  const labels = tagsSchema.parse(imported);
  const removed = new Set(preferences.filter((entry) => entry.removed).map((entry) => entry.tag));
  const candidates = labels.filter((tag) => !current.includes(tag));
  const permitted = candidates.filter((tag) => !removed.has(tag));
  const added = permitted.slice(0, Math.max(0, 20 - current.length));
  return {
    added,
    suppressed: candidates.filter((tag) => removed.has(tag)),
    capacitySkipped: permitted.slice(added.length),
    // Imports are additive. An absent remote label cannot remove a local tag.
    tags: [...current, ...added].sort()
  };
}
