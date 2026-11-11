import { Plus, X } from 'lucide-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { useFieldArray, useFormContext, useFormState, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { translateApiKey } from '../../../shared/lib/translate.js';
import { Button } from '../../../shared/ui/button.js';
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { numberFromInput } from '../domain/content.js';

/** Attributes a control needs to be announced with its error and hint. */
export interface ControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

interface FieldShellProps {
  name: string;
  label: string;
  hint?: string;
  /** Marks a field the template needs to sign (shown to everybody, enforced when signing). */
  required?: boolean;
  children: (props: ControlProps) => ReactElement;
}

function errorAt(errors: FieldValues, path: string): { message?: string } | undefined {
  let current: unknown = errors;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'object' && current !== null ? current : undefined;
}

/**
 * A labelled field of a note. The label, the hint and the error (a translation key from the
 * contract schema or from the API) are tied to the control, so a screen reader reads the same
 * thing a sighted person sees next to it.
 */
export function FieldShell({ name, label, hint, required = false, children }: FieldShellProps) {
  const { t } = useTranslation();
  const id = useId();
  const { errors } = useFormState();
  const error = errorAt(errors, name);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="text-destructive">
              {' '}
              *
            </span>
            <span className="sr-only">{t('clinical:field.required')}</span>
          </>
        ) : null}
      </Label>
      {children({
        id,
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
      })}
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {translateApiKey(t, error.message ?? 'errors.field_invalid')}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  name,
  label,
  hint,
  required,
  disabled,
}: Omit<FieldShellProps, 'children'> & { disabled?: boolean }) {
  const { register } = useFormContext();
  return (
    <FieldShell
      name={name}
      label={label}
      {...(hint ? { hint } : {})}
      {...(required ? { required } : {})}
    >
      {(props) => (
        <Input
          {...props}
          autoComplete="off"
          {...(disabled ? { disabled } : {})}
          {...register(name)}
        />
      )}
    </FieldShell>
  );
}

export function AreaField({
  name,
  label,
  hint,
  required,
  rows = 3,
  disabled,
}: Omit<FieldShellProps, 'children'> & { rows?: number; disabled?: boolean }) {
  const { register } = useFormContext();
  return (
    <FieldShell
      name={name}
      label={label}
      {...(hint ? { hint } : {})}
      {...(required ? { required } : {})}
    >
      {(props) => (
        <Textarea {...props} rows={rows} {...(disabled ? { disabled } : {})} {...register(name)} />
      )}
    </FieldShell>
  );
}

export function NumberField({
  name,
  label,
  hint,
  required,
  disabled,
}: Omit<FieldShellProps, 'children'> & { disabled?: boolean }) {
  const { register } = useFormContext();
  return (
    <FieldShell
      name={name}
      label={label}
      {...(hint ? { hint } : {})}
      {...(required ? { required } : {})}
    >
      {(props) => (
        <Input
          {...props}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          {...(disabled ? { disabled } : {})}
          {...register(name, {
            setValueAs: (raw: unknown) =>
              typeof raw === 'number'
                ? raw
                : numberFromInput(typeof raw === 'string' ? raw : undefined),
          })}
        />
      )}
    </FieldShell>
  );
}

export function DateField({
  name,
  label,
  required,
  disabled,
}: Omit<FieldShellProps, 'children' | 'hint'> & { disabled?: boolean }) {
  const { register } = useFormContext();
  return (
    <FieldShell name={name} label={label} {...(required ? { required } : {})}>
      {(props) => (
        <Input {...props} type="date" {...(disabled ? { disabled } : {})} {...register(name)} />
      )}
    </FieldShell>
  );
}

interface RowColumn {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'select';
  options?: readonly { value: string; label: string }[];
  className?: string;
}

/**
 * A list of rows (measurements, medications, range of motion). Rows have no identity of their
 * own: they are added at the end and removed in place; a row nobody fills in is not sent.
 */
export function RepeatableRows({
  name,
  legend,
  columns,
  addLabel,
  empty,
  disabled,
}: {
  name: string;
  legend: string;
  columns: readonly RowColumn[];
  addLabel: string;
  empty: Record<string, unknown>;
  disabled?: boolean;
}) {
  const { t } = useTranslation('clinical');
  const { control, register } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name });
  const { errors } = useFormState();
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {fields.map((row, index) => (
        <div
          key={row.id}
          className="grid gap-3 rounded-md border p-3 sm:items-end"
          style={{ gridTemplateColumns: `repeat(${String(columns.length)}, minmax(0, 1fr)) auto` }}
        >
          {columns.map((column) => {
            const path = `${name}.${String(index)}.${column.key}`;
            const error = errorAt(errors, path);
            return (
              <div key={column.key} className={`grid gap-1.5 ${column.className ?? ''}`}>
                <RowLabel htmlFor={`${row.id}-${column.key}`}>
                  {column.label}
                  <span className="sr-only">{t('list.row', { n: index + 1 })}</span>
                </RowLabel>
                {column.kind === 'select' ? (
                  <Select
                    id={`${row.id}-${column.key}`}
                    {...(disabled ? { disabled } : {})}
                    {...(error ? { 'aria-invalid': true } : {})}
                    {...register(path)}
                  >
                    {(column.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`${row.id}-${column.key}`}
                    autoComplete="off"
                    {...(disabled ? { disabled } : {})}
                    {...(error ? { 'aria-invalid': true } : {})}
                    {...(column.kind === 'number' ? { inputMode: 'decimal' as const } : {})}
                    {...register(path, {
                      ...(column.kind === 'number'
                        ? {
                            setValueAs: (raw: unknown) =>
                              typeof raw === 'number'
                                ? raw
                                : numberFromInput(typeof raw === 'string' ? raw : undefined),
                          }
                        : {}),
                    })}
                  />
                )}
              </div>
            );
          })}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('list.remove', { n: index + 1 })}
            {...(disabled ? { disabled } : {})}
            onClick={() => {
              remove(index);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        className="w-fit"
        {...(disabled ? { disabled } : {})}
        onClick={() => {
          append(empty);
        }}
      >
        <Plus aria-hidden="true" />
        {addLabel}
      </Button>
    </fieldset>
  );
}

function RowLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <Label htmlFor={htmlFor}>{children}</Label>;
}
