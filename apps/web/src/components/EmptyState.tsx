import type { ReactNode } from 'react';

export interface EmptyStateProps {
  message: string;
  action?: ReactNode;
}

export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      <p className="empty-state__message">{message}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
