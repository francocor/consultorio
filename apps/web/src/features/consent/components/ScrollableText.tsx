import type { ReactNode } from 'react';

import { cn } from '../../../shared/lib/cn.js';

/**
 * A long text that scrolls inside its box: the text of a consent. A region of the page that scrolls
 * must be reachable by keyboard (so it can be read without a mouse), and a region has a name.
 */
export function ScrollableText({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a long text that scrolls must be reachable by keyboard
      tabIndex={0}
      className={cn(
        'max-h-56 overflow-y-auto whitespace-pre-line rounded-md border bg-card p-3 text-sm leading-relaxed',
        className,
      )}
    >
      {children}
    </div>
  );
}
