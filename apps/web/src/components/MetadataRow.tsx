import type { ReactNode } from 'react';

export interface MetadataRowProps {
  label: string;
  children: ReactNode;
  mono?: boolean;
}

export function MetadataRow({ label, children, mono }: MetadataRowProps) {
  return (
    <div className="metadata-row">
      <dt className="metadata-row__label">{label}</dt>
      <dd
        className={
          mono ? 'metadata-row__value mono' : 'metadata-row__value'
        }
      >
        {children}
      </dd>
    </div>
  );
}

export interface MetadataListProps {
  children: ReactNode;
  className?: string;
}

export function MetadataList({ children, className }: MetadataListProps) {
  return (
    <dl className={['metadata-list', className].filter(Boolean).join(' ')}>
      {children}
    </dl>
  );
}
