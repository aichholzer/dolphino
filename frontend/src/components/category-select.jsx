export function CategorySelect({
  catalog,
  value,
  label,
  includeArchived = false,
  placeholder = 'Choose a category',
  ...props
}) {
  const entries = catalog.filter((entry) => includeArchived || !entry.archived || entry.category === value);
  const missing = value && !entries.some((entry) => entry.category === value);
  return (
    <select aria-label="Category" value={value} {...props}>
      <option value="">{placeholder}</option>
      {missing && <option value={value}>{label || (value.startsWith('cat_') ? 'Unresolved category' : value)}</option>}
      {entries.map((entry) => (
        <option key={entry.category} value={entry.category}>
          {entry.name}
          {entry.archived ? ' (archived)' : ''}
        </option>
      ))}
    </select>
  );
}
