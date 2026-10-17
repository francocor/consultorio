import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

import { Label } from './label.js';

/** A group of mutually exclusive choices. Arrow keys move between them. */
export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-2', className)} {...props} />;
}

/**
 * One choice presented as a card: the whole card is the click target, the selected one is
 * highlighted, and the text labels the radio button (title and explanation are read together).
 */
export function RadioCard({
  value,
  title,
  description,
  disabled,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 transition-colors',
        'has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft',
        disabled && 'opacity-70',
      )}
    >
      <RadioGroupPrimitive.Item
        id={id}
        value={value}
        {...(disabled === undefined ? {} : { disabled })}
        className={cn(
          'relative mt-0.5 grid size-5 shrink-0 cursor-pointer place-content-center rounded-full border border-input bg-card',
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
          'after:absolute after:-inset-3 after:content-[""]',
        )}
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-primary-foreground" />
      </RadioGroupPrimitive.Item>
      <Label htmlFor={id} className="grid flex-1 cursor-pointer gap-0.5 font-normal">
        <span className="font-medium">{title}</span>
        {description ? <span className="text-muted-foreground">{description}</span> : null}
      </Label>
    </div>
  );
}
