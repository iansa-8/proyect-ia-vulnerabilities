import type { ReactNode } from 'react';

export interface SectionProps {
  id?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({
  id,
  title,
  description,
  actions,
  children,
  className,
}: SectionProps) {
  return (
    <section
      id={id}
      className={['section', className].filter(Boolean).join(' ')}
      aria-labelledby={id ? `${id}-title` : undefined}
    >
      <div className="section__header">
        <div className="section__heading">
          <h2 id={id ? `${id}-title` : undefined} className="section-title">
            {title}
          </h2>
          {description ? (
            <p className="section-description">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="section__actions">{actions}</div> : null}
      </div>
      <div className="section__body">{children}</div>
    </section>
  );
}
