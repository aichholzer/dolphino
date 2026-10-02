import { decimalToMinor } from '../../money.mjs';

export function budgetValues({ category, cap, allocation, rollover }, currency) {
  const capMinor = decimalToMinor(cap, currency);
  if (BigInt(capMinor) < 0n) {
    throw new Error('A cap must be positive.');
  }

  const allocationMinor = decimalToMinor(allocation, currency);
  if (BigInt(allocationMinor) < 0n) {
    throw new Error('An allocation cannot be negative.');
  }

  return { category, capMinor, allocationMinor, rolloverEnabled: rollover };
}
