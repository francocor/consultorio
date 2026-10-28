import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

export const buttonVariants = cva(
  [
    'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'text-sm font-medium transition-colors touch-target-md',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary px-4 text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary px-4 text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-card px-4 hover:bg-accent hover:text-accent-foreground',
        ghost: 'px-3 hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive px-4 text-destructive-foreground hover:bg-destructive/90',
        link: 'link-target min-h-0 min-w-0 px-0 text-primary-ink underline-offset-4 hover:underline',
      },
      size: {
        default: '',
        sm: 'px-3 text-sm md:min-h-9',
        lg: 'px-6 text-base',
        icon: 'px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/**
 * For a button whose label carries a name or a file name from the data (`Ver cobro de <patient>`):
 * the label wraps inside the button instead of keeping one line, so a long name never makes the
 * page wider than a phone.
 */
export const WRAPPING_LABEL = 'h-auto max-w-full whitespace-normal break-words py-2 text-left';

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Renders the child element (a link) with the look of a button. */
  asChild?: boolean;
  /** Shows progress and blocks repeated clicks while a request is in flight. */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
