import { Slot } from 'radix-ui';
import { createContext, use, useId, type ComponentProps, type ReactNode } from 'react';
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/cn.js';
import { translateApiKey } from '../lib/translate.js';

import { Label } from './label.js';

/**
 * react-hook-form wrappers in the shadcn style. They wire the label, the description and the
 * error message to the control (`htmlFor`, `aria-describedby`, `aria-invalid`), so a screen reader
 * announces the same thing a sighted person reads next to the field.
 */
export const Form = FormProvider;

interface FieldContextValue {
  name: string;
}

interface ItemContextValue {
  id: string;
}

const FieldContext = createContext<FieldContextValue | null>(null);
const ItemContext = createContext<ItemContextValue | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FieldContext value={{ name: props.name }}>
      <Controller {...props} />
    </FieldContext>
  );
}

function useFormField() {
  const field = use(FieldContext);
  const item = use(ItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: field?.name ?? '' });
  if (!field || !item) throw new Error('Form parts must be used inside FormField and FormItem');
  const state = getFieldState(field.name, formState);
  return {
    name: field.name,
    error: state.error,
    controlId: `${item.id}-control`,
    descriptionId: `${item.id}-description`,
    messageId: `${item.id}-message`,
  };
}

export function FormItem({ className, ...props }: ComponentProps<'div'>) {
  const id = useId();
  return (
    <ItemContext value={{ id }}>
      <div className={cn('grid gap-1.5', className)} {...props} />
    </ItemContext>
  );
}

export function FormLabel({ className, ...props }: ComponentProps<typeof Label>) {
  const { controlId } = useFormField();
  return <Label htmlFor={controlId} className={className} {...props} />;
}

export function FormControl({ children }: { children: ReactNode }) {
  const { error, controlId, descriptionId, messageId } = useFormField();
  return (
    <Slot.Root
      id={controlId}
      aria-describedby={error ? `${descriptionId} ${messageId}` : descriptionId}
      aria-invalid={error ? true : undefined}
    >
      {children}
    </Slot.Root>
  );
}

export function FormDescription({ className, ...props }: ComponentProps<'p'>) {
  const { descriptionId } = useFormField();
  return (
    <p id={descriptionId} className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
}

/** The error of the field. The message is a translation key (zod or API) resolved here. */
export function FormMessage({ className, children, ...props }: ComponentProps<'p'>) {
  const { t } = useTranslation();
  const { error, messageId } = useFormField();
  const body = error ? translateApiKey(t, error.message ?? 'errors.field_invalid') : children;
  if (!body) return null;
  return (
    <p
      id={messageId}
      role={error ? 'alert' : undefined}
      className={cn('text-sm font-medium text-destructive', className)}
      {...props}
    >
      {body}
    </p>
  );
}
