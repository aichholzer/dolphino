// UI capabilities mirror server-issued grants. The API remains the authority for access.
export function workspaceAccess(session) {
  const isAdmin = !!session?.demo || session?.user?.role === 'admin';
  const hasAccountAccess = isAdmin || !!session?.permissions?.accountAccess || !!session?.permissions?.accounts?.length;
  const hasBudgetAccess = isAdmin || !!session?.permissions?.budgetAccess || !!session?.permissions?.budgets?.length;
  const hasFinancialAccess = isAdmin || hasAccountAccess || hasBudgetAccess;

  function canEditAccount(id) {
    return (
      isAdmin || session?.permissions?.accounts?.some((grant) => grant.accountId === id && grant.access === 'edit')
    );
  }

  function canNavigate(name) {
    if (isAdmin) {
      return true;
    }

    if (['Overview', 'Transactions', 'Accounts'].includes(name)) {
      return hasAccountAccess;
    }

    if (name === 'Budgets') {
      return hasBudgetAccess;
    }

    if (name === 'Review') {
      return session?.permissions?.accounts?.some((grant) => grant.access === 'edit');
    }

    return false;
  }

  return { isAdmin, hasAccountAccess, hasBudgetAccess, hasFinancialAccess, canEditAccount, canNavigate };
}

export function workspaceIdentity(session) {
  if (session?.demo) {
    return 'demo';
  }

  return JSON.stringify([
    session?.user?.id || session?.user?.email || 'loading',
    session?.user?.role || '',
    session?.permissions || {}
  ]);
}
