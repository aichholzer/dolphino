import { Inbox } from 'lucide-react';

export function Empty({ title, detail, icon: Icon = Inbox }) {
  return (
    <div className="empty">
      <div>
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
