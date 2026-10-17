import {
  type CurrentOdontogramResponse,
  type Odontogram as OdontogramValue,
  type SurfaceFinding,
  type ToothCondition,
  type ToothRecord,
  type ToothSurface,
} from '@consultorio/contracts';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';

import {
  ARCHES,
  mesialSide,
  moveFocus,
  setTooth,
  summarizeTooth,
  type ToothSummary,
} from './geometry.js';
import { ToothPanel } from './ToothPanel.js';

type CurrentTeeth = CurrentOdontogramResponse['teeth'];

export interface OdontogramProps {
  /** What this entry records. */
  value: OdontogramValue;
  /** Present when the chart can be edited; without it the chart only shows. */
  onChange?: (next: OdontogramValue) => void;
  /** The state derived from the signed entries, drawn behind the teeth this entry does not touch. */
  current?: CurrentTeeth;
}

/** Fill of a surface by what was found on it. The word is always available too (never color alone). */
const FINDING_FILL: Record<SurfaceFinding, string> = {
  healthy: 'fill-success-soft',
  caries: 'fill-destructive',
  restoration: 'fill-info',
  fracture: 'fill-warning',
  wear: 'fill-muted-foreground',
};

/** A short mark drawn on the tooth for its condition, so the chart reads without colors. */
const CONDITION_GLYPH: Record<ToothCondition, string> = {
  healthy: 'S',
  caries: 'C',
  restoration: 'R',
  crown: 'Co',
  extraction: 'X',
  implant: 'I',
  missing: 'A',
  endodontic: 'E',
};

interface ToothPictureProps {
  code: string;
  record: ToothRecord | undefined;
  faded: boolean;
}

/** The five surfaces of a tooth: four trapezoids around the occlusal square. */
function ToothPicture({ code, record, faded }: ToothPictureProps) {
  const mesial = mesialSide(code);
  const finding = (surface: ToothSurface): string => {
    const found = record?.surfaces?.[surface]?.finding;
    return found ? FINDING_FILL[found] : 'fill-card';
  };
  const sideLeft: ToothSurface = mesial === 'left' ? 'mesial' : 'distal';
  const sideRight: ToothSurface = mesial === 'left' ? 'distal' : 'mesial';
  const stroke = 'stroke-foreground/60';
  const missing = record?.condition === 'missing' || record?.condition === 'extraction';
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-8', faded && 'opacity-50', missing && 'opacity-60')}
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="0,0 32,0 24,8 8,8" className={cn(finding('vestibular'), stroke)} />
      <polygon points="0,32 32,32 24,24 8,24" className={cn(finding('lingual'), stroke)} />
      <polygon points="0,0 8,8 8,24 0,32" className={cn(finding(sideLeft), stroke)} />
      <polygon points="32,0 24,8 24,24 32,32" className={cn(finding(sideRight), stroke)} />
      <rect x="8" y="8" width="16" height="16" className={cn(finding('occlusal'), stroke)} />
      {missing ? (
        <path d="M2 2 L30 30 M30 2 L2 30" className="stroke-foreground" strokeWidth="2" />
      ) : null}
    </svg>
  );
}

export function describeState(
  t: (key: string, options?: Record<string, unknown>) => string,
  summary: ToothSummary,
): string {
  const parts = [
    ...(summary.condition ? [t(`odontology.condition.${summary.condition}`)] : []),
    ...summary.surfaces.map((surface) => t(`odontology.surface.${surface}`).toLowerCase()),
  ];
  return parts.length === 0 ? t('odontology.tooth.untouched') : parts.join(', ');
}

/**
 * The odontogram (clinical-records, "Odontogram template"): permanent and primary dentition in FDI
 * notation. Each tooth is a button with a drawing of its five surfaces; selecting it opens its
 * editor under the chart. One tab stop for the whole chart, arrows to move, Enter to open. The rows
 * scroll sideways on a phone so a tooth stays a comfortable tap target.
 */
export function Odontogram({ value, onChange, current }: OdontogramProps) {
  const { t } = useTranslation('clinical');
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState('18');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const editable = onChange !== undefined;

  const focusTooth = (code: string) => {
    setFocused(code);
    refs.current.get(code)?.focus();
  };

  const renderTooth = (code: string) => {
    const own = value[code];
    const background = own ? undefined : current?.[code];
    const record = own ?? background;
    const summary = summarizeTooth(record);
    const state = describeState(t, summary);
    const name = t('odontology.tooth.state', {
      code,
      state: background ? `${state} ${t('odontology.tooth.currentSuffix')}` : state,
    });
    return (
      <button
        key={code}
        type="button"
        ref={(element) => {
          if (element) refs.current.set(code, element);
          else refs.current.delete(code);
        }}
        aria-label={name}
        aria-pressed={selected === code}
        tabIndex={focused === code ? 0 : -1}
        onFocus={() => {
          setFocused(code);
        }}
        onClick={() => {
          setSelected(code);
          setFocused(code);
        }}
        onKeyDown={(event) => {
          const next = moveFocus(code, event.key);
          if (next === null) return;
          event.preventDefault();
          focusTooth(next);
        }}
        className={cn(
          'flex w-11 shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-md border border-transparent py-1',
          'hover:bg-accent focus-visible:outline-2',
          selected === code && 'border-primary bg-primary-soft',
        )}
      >
        <span className="text-xs font-medium text-muted-foreground">{code}</span>
        <ToothPicture code={code} record={record} faded={background !== undefined} />
        <span aria-hidden="true" className="h-4 text-xs font-semibold">
          {summary.condition ? CONDITION_GLYPH[summary.condition] : ''}
        </span>
      </button>
    );
  };

  const row = (codes: readonly string[]) => {
    const half = codes.length / 2;
    return (
      <div className="flex min-w-max justify-center gap-0.5">
        {codes.slice(0, half).map(renderTooth)}
        <span aria-hidden="true" className="mx-1.5 w-px self-stretch bg-border" />
        {codes.slice(half).map(renderTooth)}
      </div>
    );
  };

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('odontology.chart.help')}</p>
      <div
        role="group"
        aria-label={t('odontology.chart')}
        className="grid gap-4 overflow-x-auto rounded-lg border bg-card p-3"
      >
        <section aria-label={t('odontology.permanent')} className="grid gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('odontology.permanent')}
          </h3>
          {row(ARCHES.permanentUpper)}
          {row(ARCHES.permanentLower)}
        </section>
        <section aria-label={t('odontology.primary')} className="grid gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('odontology.primary')}
          </h3>
          {row(ARCHES.primaryUpper)}
          {row(ARCHES.primaryLower)}
        </section>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(Object.keys(CONDITION_GLYPH) as ToothCondition[]).map((condition) => (
          <li key={condition}>
            <span className="font-semibold text-foreground">{CONDITION_GLYPH[condition]}</span>{' '}
            {t(`odontology.condition.${condition}`)}
          </li>
        ))}
      </ul>
      {selected && editable ? (
        <ToothPanel
          key={selected}
          code={selected}
          record={value[selected]}
          onChange={(record) => {
            onChange(setTooth(value, selected, record));
          }}
          onClose={() => {
            setSelected(null);
            refs.current.get(selected)?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
