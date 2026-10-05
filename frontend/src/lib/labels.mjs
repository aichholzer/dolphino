// Display names for stored enum values; the values themselves never change.
export const KIND_LABELS = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
  refund: 'Refund',
  opening: 'Opening balance',
  adjustment: 'Balance adjustment'
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}

// Machine states such as not_registered read as "Not registered".
export function stateLabel(value) {
  if (!value) {
    return value;
  }

  const text = String(value).replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
