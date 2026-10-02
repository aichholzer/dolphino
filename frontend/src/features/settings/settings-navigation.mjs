export const settingsSections = [
  { id: 'redbark', label: 'RedBark', description: 'Connection, credentials and signed events' },
  { id: 'categories', label: 'Categories', description: 'Names, new categories and archived history' },
  { id: 'members', label: 'Members', description: 'People, invitations and access' },
  { id: 'notifications', label: 'Notifications', description: 'Email and Telegram alerts' },
  { id: 'data', label: 'Data', description: 'Imports, health, history and exports' },
  { id: 'ai', label: 'AI features', description: 'Shared provider, classification and assistant' }
];

const pages = ['Overview', 'Transactions', 'Accounts', 'Budgets', 'Review', 'Rules', 'Settings'];

export function settingsSection(value) {
  return settingsSections.some((section) => section.id === value) ? value : 'redbark';
}

export function workspaceRoute(hash = '') {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [name, section] = path.split('/');
  const page = pages.find((entry) => entry.toLowerCase() === name?.toLowerCase()) || 'Overview';
  return {
    page,
    section: settingsSection(section),
    ...(page === 'Transactions' && query ? { transactionQuery: query.slice(0, 64000) } : {})
  };
}

export function workspaceHash({ page, section, transactionQuery }) {
  return page === 'Settings'
    ? `#settings/${settingsSection(section)}`
    : `#${page.toLowerCase()}${page === 'Transactions' && transactionQuery ? `?${transactionQuery}` : ''}`;
}
