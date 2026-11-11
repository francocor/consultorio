import type { PatientSummaryDto } from '@consultorio/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { cn } from '../../../shared/lib/cn.js';
import { formatAge } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { useDebouncedValue } from '../../../shared/lib/use-debounced-value.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { SafetyFlag } from '../../../shared/ui/states/safety-flag.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { documentText, initialsOf } from './PatientRow.js';

const SEARCH_DELAY_MS = 250;
const MIN_CHARACTERS = 2;

/**
 * Finds a patient by document or name while typing, and hands back the one chosen. It follows the
 * combobox pattern (arrows move, Enter chooses, Escape closes), so it works without a mouse.
 */
export function PatientPicker({
  onSelect,
  label,
  placeholder,
  className,
}: {
  onSelect: (patient: PatientSummaryDto) => void;
  label?: string;
  placeholder?: string;
  className?: string;
}) {
  const { t } = useTranslation('patients');
  const api = useApi();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const searching = query.length >= MIN_CHARACTERS;

  const results = useQuery({
    queryKey: patientKeys.search(query, 'active'),
    queryFn: () => patientsApi(api).search({ q: query, status: 'active' }),
    enabled: searching,
    placeholderData: keepPreviousData,
  });

  const patients = searching ? (results.data?.patients ?? []) : [];
  const showPopup = open && searching;
  const showList = showPopup && patients.length > 0;

  function choose(patient: PatientSummaryDto) {
    onSelect(patient);
    setText('');
    setOpen(false);
    setActive(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, Math.max(patients.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && showList) {
      event.preventDefault();
      const chosen = patients[active];
      if (chosen) choose(chosen);
    }
  }

  const optionId = (index: number) => `${baseId}-option-${String(index)}`;

  return (
    <div
      className={cn('relative', className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Label htmlFor={baseId} className={label ? undefined : 'sr-only'}>
        {label ?? t('picker.label')}
      </Label>
      <div className="relative mt-1.5">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={baseId}
          role="combobox"
          autoComplete="off"
          className="pl-9"
          placeholder={placeholder ?? t('search.placeholder')}
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optionId(active) : undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {showPopup ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover shadow-lg">
          {showList ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={t('picker.results')}
              className="max-h-80 overflow-y-auto p-1"
            >
              {patients.map((patient, index) => (
                // The keyboard is handled by the input (aria-activedescendant), as in any combobox.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={patient.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md p-2.5',
                    index === active && 'bg-accent',
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    choose(patient);
                  }}
                >
                  <PickerOption patient={patient} />
                </li>
              ))}
            </ul>
          ) : results.isError ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              {describeError(t, results.error).message}
            </p>
          ) : results.isFetching ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              {t('picker.loading')}
            </p>
          ) : (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              {t('picker.none')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PickerOption({ patient }: { patient: PatientSummaryDto }) {
  const { t } = useTranslation('patients');
  const age = formatAge(patient.birthDate);
  return (
    <>
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-content-center rounded-full bg-accent font-display text-xs font-semibold text-accent-foreground"
      >
        {initialsOf(patient.familyName, patient.givenNames)}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate font-medium">{`${patient.familyName}, ${patient.givenNames}`}</span>
        <span className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span className="tabular">{documentText(patient.document) ?? t('row.noDocument')}</span>
          {age ? <span>{age}</span> : null}
        </span>
      </span>
      <SafetyFlag flags={patient.hasSafetyFlag ? ['allergy_on_file'] : []} detail="summary" />
    </>
  );
}
