import type { ClinicalTemplateKind } from '@consultorio/contracts';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCalendarDay, formatNumber } from '../../../shared/lib/format.js';
import { fieldsOf } from '../domain/content.js';
import { summarizeTooth } from '../odontogram/geometry.js';
import { describeState, Odontogram } from '../odontogram/Odontogram.js';

interface ContentViewProps {
  kind: ClinicalTemplateKind;
  content: Record<string, unknown>;
  derived?: Record<string, unknown>;
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap text-sm">{children}</dd>
    </div>
  );
}

/**
 * A note read as a list of labelled values, in the order of its template. The same component serves
 * a signed note, a draft read by its author while the organization is read-only, and the timeline.
 */
export function ContentView({ kind, content, derived = {} }: ContentViewProps) {
  const { t } = useTranslation('clinical');

  const renderField = (name: string): ReactNode => {
    const value = content[name];
    if (value === undefined) return null;
    const label = t(`field.${name}`);

    if (name === 'odontogram' && isRecord(value)) {
      const teeth = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
      return (
        <div key={name} className="grid gap-2">
          <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
          <dd className="grid gap-3">
            <Odontogram value={value as never} />
            {teeth.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('odontology.summary.none')}</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {teeth.map(([code, record]) => (
                  <li key={code}>
                    <span className="font-medium">{t('odontology.tooth', { code })}</span>
                    {': '}
                    {describeState(
                      (key, options) => t(key as never, options as never) as unknown as string,
                      summarizeTooth(record as never),
                    )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      );
    }
    if (name === 'measurements') {
      return (
        <Item key={name} label={label}>
          <ul className="grid gap-0.5">
            {rows(value).map((row, index) => (
              <li key={index}>
                {`${text(row['name'])}: ${text(row['value'])} ${text(row['unit'])}`.trim()}
              </li>
            ))}
          </ul>
        </Item>
      );
    }
    if (name === 'medications') {
      return (
        <Item key={name} label={label}>
          <ul className="grid gap-0.5">
            {rows(value).map((row, index) => (
              <li key={index}>
                {[text(row['name']), text(row['dose']), text(row['frequency'])]
                  .filter((part) => part !== '')
                  .join(' · ')}
              </li>
            ))}
          </ul>
        </Item>
      );
    }
    if (name === 'rangeOfMotion') {
      return (
        <Item key={name} label={label}>
          <ul className="grid gap-0.5">
            {rows(value).map((row, index) => (
              <li key={index}>
                {`${text(row['joint'])}: ${typeof row['value'] === 'number' ? formatNumber(row['value']) : ''} ${t(`physiotherapy.rom.unit.${text(row['unit'])}`, { defaultValue: text(row['unit']) })}`.trim()}
              </li>
            ))}
          </ul>
        </Item>
      );
    }
    if (name === 'modality')
      return (
        <Item key={name} label={label}>
          {t(`psychology.modality.${text(value)}`)}
        </Item>
      );
    if (name === 'risk')
      return (
        <Item key={name} label={label}>
          {t(`psychology.risk.${text(value)}`)}
        </Item>
      );
    if (name === 'sessionDate')
      return (
        <Item key={name} label={label}>
          {formatCalendarDay(text(value))}
        </Item>
      );
    if (name === 'painIntensity' && typeof value === 'number') {
      return (
        <Item key={name} label={label}>
          {`${formatNumber(value)} / 10`}
        </Item>
      );
    }
    if (typeof value === 'number') {
      return (
        <Item key={name} label={label}>
          {formatNumber(value)}
        </Item>
      );
    }
    return isText(value) ? (
      <Item key={name} label={label}>
        {value}
      </Item>
    ) : null;
  };

  const bmi = derived['bmi'];
  return (
    <dl className="grid gap-3">
      {fieldsOf(kind).map(renderField)}
      {typeof bmi === 'number' ? <Item label={t('nutrition.bmi')}>{formatNumber(bmi)}</Item> : null}
    </dl>
  );
}
