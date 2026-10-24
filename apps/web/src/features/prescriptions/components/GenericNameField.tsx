import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { cn } from '../../../shared/lib/cn.js';
import { useDebouncedValue } from '../../../shared/lib/use-debounced-value.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { prescriptionKeys, prescriptionsApi } from '../api/prescriptions-api.js';

/** Letters typed before the catalog is asked: one letter matches half of it. */
const MIN_CHARACTERS = 2;
/** The pause after typing before the catalog is asked, so one search is made per word. */
const PAUSE_MS = 250;

/**
 * The generic name of a medication (international nonproprietary name), with suggestions from the
 * catalog while the professional types. It is a combobox with a list: the arrows move through the
 * suggestions, Enter takes the one in focus, Escape closes the list. Whatever is typed is kept even
 * when it is not a suggestion: the provider is the one that knows its catalog.
 */
export function GenericNameField({
  id,
  label,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  invalid: boolean;
  describedBy?: string | undefined;
}) {
  const { t } = useTranslation('prescriptions');
  const api = useApi();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useDebouncedValue(value.trim(), PAUSE_MS);

  const suggestions = useQuery({
    queryKey: prescriptionKeys.catalog(typed),
    queryFn: () => prescriptionsApi(api).catalog(typed),
    enabled: open && typed.length >= MIN_CHARACTERS,
    staleTime: 5 * 60_000,
  });
  const names = open && typed.length >= MIN_CHARACTERS ? (suggestions.data?.names ?? []) : [];
  const showing = open && names.length > 0;

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="relative grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing && active >= 0 ? `${listId}-${String(active)}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        maxLength={120}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && names.length > 0) {
            event.preventDefault();
            setOpen(true);
            setActive((current) => (current + 1) % names.length);
          } else if (event.key === 'ArrowUp' && names.length > 0) {
            event.preventDefault();
            setActive((current) => (current <= 0 ? names.length - 1 : current - 1));
          } else if (event.key === 'Enter' && showing && active >= 0) {
            // Taking a suggestion must not submit the form.
            event.preventDefault();
            const name = names[active];
            if (name !== undefined) choose(name);
          } else if (event.key === 'Escape' && showing) {
            // The list closes; an open dialog around it must not.
            event.stopPropagation();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {showing ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('form.suggestions')}
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {names.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                'cursor-pointer rounded px-2 py-2',
                index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent',
              )}
              // The input would lose focus (and close the list) before a click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
