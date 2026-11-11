import { REPORT_MAX_SPAN_DAYS, type ReportOptionsResponse } from '@consultorio/contracts';
import { useId, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCalendarDay } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import type { ReportQuery } from '../api/reports-api.js';
import { rangeIssue } from '../domain/period.js';

/** Which report the bar filters: each one reads the filters that mean something to it. */
export type FilterVariant = 'operational' | 'financial' | 'cash';

/** The filters of a report. A range that cannot run is explained on the field and never sent. */
export function FilterBar({
  query,
  options,
  onApply,
  variant = 'operational',
}: {
  query: ReportQuery;
  options: ReportOptionsResponse | undefined;
  onApply: (query: ReportQuery) => void;
  variant?: FilterVariant;
}) {
  const { t } = useTranslation('reports');
  const ids = {
    from: useId(),
    to: useId(),
    location: useId(),
    professional: useId(),
    specialty: useId(),
    payer: useId(),
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
  // Reception never reaches revenue by professional, so the money report does not offer the choice.
  const professionals =
    variant === 'cash' || (variant === 'financial' && !options?.canSeeRevenueByProfessional)
      ? []
      : (options?.professionals ?? []);
  const specialties = variant === 'operational' ? (options?.specialties ?? []) : [];
  const payers = variant === 'financial' ? (options?.payers ?? []) : [];

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
          {payers.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.payer}>{t('filter.payer')}</Label>
              <Select
                id={ids.payer}
                value={draft.tenantPayerId ?? ''}
                onChange={(event) => {
                  change({ tenantPayerId: event.target.value || undefined });
                }}
              >
                <option value="">{t('filter.allPayers')}</option>
                {payers.map((payer) => (
                  <option key={payer.id} value={payer.id}>
                    {payer.name}
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

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The period and the narrowing filters in words, in the order the screen writes them. */
export function appliedParts(
  query: ReportQuery,
  options: ReportOptionsResponse | undefined,
  t: Translate,
): string[] {
  const location = options?.locations.find((item) => item.id === query.locationId);
  const professional = options?.professionals.find((item) => item.id === query.professionalId);
  const payer = options?.payers.find((item) => item.id === query.tenantPayerId);
  return [
    t('applied.period', { from: formatCalendarDay(query.from), to: formatCalendarDay(query.to) }),
    ...(location ? [t('applied.location', { name: location.name })] : []),
    ...(professional
      ? [t('applied.professional', { name: professional.name ?? t('filter.unnamedProfessional') })]
      : []),
    ...(query.specialty ? [t('applied.specialty', { name: query.specialty })] : []),
    ...(payer ? [t('applied.payer', { name: payer.name })] : []),
  ];
}

/** What the report on screen covers, in words: the period, the narrowing filters and the scope. */
export function AppliedFilters({
  query,
  options,
  scope,
  scopeKey = 'applied.scope',
}: {
  query: ReportQuery;
  options: ReportOptionsResponse | undefined;
  scope: ReportOptionsResponse['scope'] | undefined;
  /** The prefix of the sentences that say whose figures these are. */
  scopeKey?: string;
}) {
  const { t } = useTranslation('reports');
  const parts = [...appliedParts(query, options, t), ...(scope ? [t(`${scopeKey}.${scope}`)] : [])];
  return (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{t('applied.title')}: </span>
      {parts.join(' · ')}
    </p>
  );
}
