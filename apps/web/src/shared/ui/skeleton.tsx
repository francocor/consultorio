import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

/** A placeholder with the shape of the content. Decorative: the region around it says "loading". */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('rounded-md bg-muted motion-safe:animate-pulse', className)}
      {...props}
    />
  );
}
