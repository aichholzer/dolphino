export function ruleFromTransaction(transaction) {
  return {
    match: transaction.description.length <= 200 ? transaction.description : '',
    category: transaction.category,
    categoryDisplayLabel: transaction.categoryDisplayLabel,
    kind: transaction.kind,
    tags: [...(transaction.tags || [])],
    sourceDescription: transaction.description
  };
}

export const ruleValues = (rule) => ({
  ...(rule?.id ? { id: rule.id } : {}),
  match: rule?.match || '',
  category: rule?.category || '',
  kind: rule?.kind || (rule?.id ? undefined : 'expense'),
  priority: rule?.priority || 0,
  tags: [...(rule?.tags || [])]
});
