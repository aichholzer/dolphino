// Currency totals are exact and count every active local account once.
export function accountBalances(accounts) {
  const totals = new Map();
  for (const account of accounts) {
    if (account.includedInBalance === false || account.frozen || account.deleted) {
      continue;
    }

    const total = totals.get(account.currency) || {
      currency: account.currency,
      balance: 0n,
      unknownBalances: 0,
      accountCount: 0
    };
    total.accountCount++;
    if (account.balanceMinor == null) {
      total.unknownBalances++;
    } else {
      total.balance += BigInt(account.balanceMinor);
    }

    totals.set(account.currency, total);
  }

  return [...totals.values()].map(({ balance, ...row }) => ({ ...row, balanceMinor: balance.toString() }));
}
