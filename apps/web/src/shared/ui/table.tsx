import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

/**
 * Wide tables scroll sideways inside this region instead of breaking the page layout. The region
 * is focusable so a keyboard user can scroll it, and it is named for assistive technology.
 */
export function TableContainer({
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'role' | 'tabIndex'> & { 'aria-label': string }) {
  return (
    <div
      role="region"
      // A scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={cn('w-full overflow-x-auto rounded-lg border bg-card', className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table className={cn('w-full caption-bottom text-sm', className)} {...props} />;
}

/** Visible only to screen readers: sighted users have the page heading. */
export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('sr-only', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('border-b bg-muted/60 [&_tr]:border-b-0', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, scope = 'col', ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope={scope}
      className={cn(
        'h-11 whitespace-nowrap px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}
