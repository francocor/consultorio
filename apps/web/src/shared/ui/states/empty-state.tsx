import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.js';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** The primary next action (a button or a link). */
  action?: ReactNode;
  className?: string;
}

/** A list or screen with nothing in it yet: what it is for, and what to do first. */
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: EmptyStateProps) {
  return (
    <section
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card px-6 py-12 text-center',
        className,
      )}
    >
      <span className="grid size-12 place-content-center rounded-full bg-primary-soft text-primary-ink">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </section>
  );
}
