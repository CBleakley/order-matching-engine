import { useId, type ReactNode } from 'react';

interface PanelProps {
  title: string;
  className: string;
  // Keeps the heading for screen readers when the design shows no visible title.
  hideHeading?: boolean;
  // Shown beside the title, outside the heading, so the panel's name stays the title.
  count?: number;
  // Controls at the right of the header row.
  actions?: ReactNode;
  children: ReactNode;
}

// A dashboard panel: a section landmark named by its heading.
export function Panel({
  title,
  className,
  hideHeading = false,
  count,
  actions,
  children,
}: PanelProps) {
  const headingId = useId();
  const heading = (
    <h2 id={headingId} className={hideHeading ? 'visually-hidden' : 'panel__title'}>
      {title}
    </h2>
  );
  return (
    <section aria-labelledby={headingId} className={`panel ${className}`}>
      {count === undefined && actions === undefined ? (
        heading
      ) : (
        <div className="panel__header">
          <div className="panel__heading">
            {heading}
            {count !== undefined && <span className="num panel__count">{count}</span>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
