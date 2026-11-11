import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

const alertVariants = cva('flex gap-3 rounded-lg border p-4 text-sm', {
  variants: {
    tone: {
      info: 'border-info/30 bg-info-soft text-info-soft-foreground',
      success: 'border-success/30 bg-success-soft text-success-soft-foreground',
      warning: 'border-warning/40 bg-warning-soft text-warning-soft-foreground',
      danger: 'border-destructive/40 bg-danger-soft text-danger-soft-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

type Tone = NonNullable<VariantProps<typeof alertVariants>['tone']>;

const ICONS: Record<Tone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

/**
 * An inline message. The icon and the words carry the meaning, never the color alone. Danger is
 * announced immediately (`role="alert"`); the rest are polite status messages.
 */
export function Alert({
  className,
  tone = 'info',
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'role'> & VariantProps<typeof alertVariants>) {
  const resolved: Tone = tone ?? 'info';
  const Icon = ICONS[resolved];
  return (
    <div
      role={resolved === 'danger' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone: resolved }), className)}
      {...props}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">{children}</div>
    </div>
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('font-medium leading-snug', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('leading-relaxed', className)} {...props} />;
}
