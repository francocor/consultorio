import { REPORT_MAX_SPAN_DAYS, type ReportOptionsResponse } from '@consultorio/contracts';
import { useId, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCalendarDay } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import type { ReportQuery } from '../api/reports-api.js';
import { rangeIssue } from '../domain/period.js';

/** The filters of the dashboard. A range that cannot run is explained on the field and never sent. */
export function FilterBar({
  query,
  options,
  onApply,
}: {
  query: ReportQuery;
  options: ReportOptionsResponse | undefined;
  onApply: (query: ReportQuery) => void;
}) {
  const { t } = useTranslation('reports');
  const ids = {
    from: useId(),
    to: useId(),
    location: useId(),
    professional: useId(),
    specialty: useId(),
    error: useId(),
  };
  const [draft, setDraft] = useState<ReportQuery>(query);
  const [issue, setIssue] = useState<ReturnType<typeof rangeIssue>>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const found = rangeIssue(draft);
    setIssue(found);
    if (found === null) onApply(draft);
  };
  const change = (patch: Partial<ReportQuery>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const text = issue === null ? '' : t(`range.${issue}`, { days: REPORT_MAX_SPAN_DAYS });
  const locations = options?.locations ?? [];
  const professionals = options?.professionals ?? [];
  const specialties = options?.specialties ?? [];

  return (
    <form noValidate onSubmit={submit} className="grid gap-3 rounded-lg border bg-card p-4">
      <fieldset className="grid min-w-0 gap-3">
        <legend className="sr-only">{t('filter.legend')}</legend>
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-5">
          <div className="grid gap-1.5">
            <Label htmlFor={ids.from}>{t('filter.from')}</Label>
            <Input
              id={ids.from}
              type="date"
              value={draft.from}
              aria-invalid={issue !== null}
              aria-describedby={issue === null ? undefined : ids.error}
              onChange={(event) => {
                change({ from: event.target.value });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.to}>{t('filter.to')}</Label>
            <Input
              id={ids.to}
              type="date"
              value={draft.to}
              aria-invalid={issue !== null}
              aria-describedby={issue === null ? undefined : ids.error}
              onChange={(event) => {
                change({ to: event.target.value });
              }}
            />
          </div>
          {locations.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.location}>{t('filter.location')}</Label>
              <Select
                id={ids.location}
                value={draft.locationId ?? ''}
                onChange={(event) => {
                  change({ locationId: event.target.value || undefined });
                }}
              >
                <option value="">{t('filter.allLocations')}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {professionals.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.professional}>{t('filter.professional')}</Label>
              <Select
                id={ids.professional}
                value={draft.professionalId ?? ''}
                onChange={(event) => {
                  change({ professionalId: event.target.value || undefined });
                }}
              >
                <option value="">{t('filter.allProfessionals')}</option>
                {professionals.map((professional) => (
                  <option key={professional.id} value={professional.id}>
                    {professional.name ?? t('filter.unnamedProfessional')}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {specialties.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.specialty}>{t('filter.specialty')}</Label>
              <Select
                id={ids.specialty}
                value={draft.specialty ?? ''}
                onChange={(event) => {
                  change({ specialty: event.target.value || undefined });
                }}
              >
                <option value="">{t('filter.allSpecialties')}</option>
                {specialties.map((specialty) => (
                  <option key={specialty} value={specialty}>
                    {specialty}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        {issue === null ? null : (
          <p id={ids.error} role="alert" className="text-sm font-medium text-destructive">
            {text}
          </p>
        )}
        <div>
          <Button type="submit">{t('filter.apply')}</Button>
        </div>
      </fieldset>
    </form>
  );
}

/** What the report on screen covers, in words: the period, the narrowing filters and the scope. */
export function AppliedFilters({
  query,
  options,
  scope,
}: {
  query: ReportQuery;
  options: ReportOptionsResponse | undefined;
  scope: ReportOptionsResponse['scope'] | undefined;
}) {
  const { t } = useTranslation('reports');
  const location = options?.locations.find((item) => item.id === query.locationId);
  const professional = options?.professionals.find((item) => item.id === query.professionalId);
  const parts = [
    t('applied.period', { from: formatCalendarDay(query.from), to: formatCalendarDay(query.to) }),
    ...(location ? [t('applied.location', { name: location.name })] : []),
    ...(professional
      ? [t('applied.professional', { name: professional.name ?? t('filter.unnamedProfessional') })]
      : []),
    ...(query.specialty ? [t('applied.specialty', { name: query.specialty })] : []),
    ...(scope ? [t(`applied.scope.${scope}`)] : []),
  ];
  return (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{t('applied.title')}: </span>
      {parts.join(' · ')}
    </p>
  );
}
