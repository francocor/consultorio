import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/cn.js';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 bg-popover p-6 text-popover-foreground shadow-lg',
  {
    variants: {
      side: {
        left: 'inset-y-0 left-0 h-full w-72 max-w-[85vw] border-r',
        right: 'inset-y-0 right-0 h-full w-96 max-w-[90vw] border-l',
        bottom: 'inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-xl border-t pb-8',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export function SheetContent({
  side,
  className,
  children,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & VariantProps<typeof sheetVariants>) {
  const { t } = useTranslation();
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/50" />
      <SheetPrimitive.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <SheetPrimitive.Close className="touch-target absolute right-2 top-2 inline-grid cursor-pointer place-content-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">{t('action.close')}</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      className={cn('font-display pr-8 text-lg font-semibold leading-tight', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
