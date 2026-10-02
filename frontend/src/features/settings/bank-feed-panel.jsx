export function BankFeedPanel({ name, description, children, open = false }) {
  return (
    <details className="bank-feed-panel" open={open}>
      <summary>
        <strong>{name}</strong>
        <span>{description}</span>
      </summary>
      <div className="bank-feed-content settings-stack">{children}</div>
    </details>
  );
}
