import { useId, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

import { Checkbox } from './checkbox.js';
import { Label } from './label.js';

/**
 * A choice presented as a card: a checkbox with a title and an explanation, where the whole card
 * is the click target and the selected one is visibly highlighted. The text labels the checkbox,
 * so a screen reader announces the title and the explanation together.
 */
export function CheckboxCard({
  checked,
  onCheckedChange,
  disabled = false,
  title,
  description,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 transition-colors',
        'has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft',
        disabled && 'opacity-70',
        className,
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          onCheckedChange(next === true);
        }}
        className="mt-0.5"
      />
      <Label
        htmlFor={id}
        className={cn(
          'grid flex-1 gap-0.5 font-normal',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span className="font-medium">{title}</span>
        {description ? <span className="text-muted-foreground">{description}</span> : null}
      </Label>
    </div>
  );
}
