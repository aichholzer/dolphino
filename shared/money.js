// Keep all money in integer minor units. Never coerce monetary values to Number.
export function currencyDigits(currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency
  }).resolvedOptions().maximumFractionDigits;
}
export function money(value = '0', currency = 'AUD') {
  if (value == null) {
    return '—';
  }
  let amount;
  try {
    amount = BigInt(value);
  } catch {
    return '—';
  }
  const negative = amount < 0n;
  if (negative) {
    amount = -amount;
  }
  const digits = currencyDigits(currency);
  const factor = 10n ** BigInt(digits);
  const formatter = new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency
  });
  const rendered = formatter
    .formatToParts(amount / factor)
    .map((part) => (part.type === 'fraction' ? String(amount % factor).padStart(digits, '0') : part.value))
    .join('');
  return `${negative ? '−' : ''}${rendered}`;
}
export function decimalToMinor(value, currency = 'AUD') {
  const digits = currencyDigits(currency);
  const pattern = new RegExp(`^-?\\d+${digits ? `(\\.\\d{1,${digits}})?` : ''}$`);
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(
      `Enter an amount with ${digits ? `up to ${digits} decimal places` : 'no decimal places'} for ${currency}.`
    );
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  return (
    (BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0')) *
    (negative ? -1n : 1n)
  ).toString();
}
export function minorToDecimal(value, currency = 'AUD') {
  let amount = BigInt(value || 0);
  const negative = amount < 0n;
  if (negative) {
    amount = -amount;
  }
  const digits = currencyDigits(currency);
  const factor = 10n ** BigInt(digits);
  return `${negative ? '-' : ''}${amount / factor}${digits ? `.${String(amount % factor).padStart(digits, '0')}` : ''}`;
}
