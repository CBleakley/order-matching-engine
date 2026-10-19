import { useId, type ReactNode } from 'react';

interface PanelProps {
  title: string;
  className: string;
  // Keeps the heading for screen readers when the design shows no visible title.
  hideHeading?: boolean;
  children: ReactNode;
}

// A dashboard panel: a section landmark named by its heading.
export function Panel({ title, className, hideHeading = false, children }: PanelProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`panel ${className}`}>
      <h2 id={headingId} className={hideHeading ? 'visually-hidden' : 'panel__title'}>
        {title}
      </h2>
      {children}
    </section>
  );
}
