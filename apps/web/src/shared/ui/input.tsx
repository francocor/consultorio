import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

const FIELD =
  'w-full rounded-md border border-input bg-card px-3 text-base text-foreground shadow-none transition-colors ' +
  'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-destructive ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 md:text-sm';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input type={type} className={cn(FIELD, 'touch-target-md', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(FIELD, 'min-h-24 py-2', className)} {...props} />;
}

/**
 * A native select: the best experience on phones (the system picker), fully accessible and
 * trivially testable. Options are plain children.
 */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(FIELD, 'touch-target-md appearance-auto pr-8', className)} {...props}>
      {children}
    </select>
  );
}
