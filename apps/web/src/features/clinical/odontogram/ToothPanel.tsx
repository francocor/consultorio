import {
  SURFACE_FINDINGS,
  TOOTH_CONDITIONS,
  TOOTH_SURFACES,
  type SurfaceFinding,
  type ToothCondition,
  type ToothRecord,
  type ToothSurface,
} from '@consultorio/contracts';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/ui/button.js';
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';

interface ToothPanelProps {
  code: string;
  record: ToothRecord | undefined;
  /** The new record of the tooth; `undefined` removes it. */
  onChange: (record: ToothRecord | undefined) => void;
  onClose: () => void;
}

function asCondition(value: string): ToothCondition | undefined {
  return TOOTH_CONDITIONS.find((condition) => condition === value);
}

function asFinding(value: string): SurfaceFinding | undefined {
  return SURFACE_FINDINGS.find((finding) => finding === value);
}

/**
 * The editor of one tooth, under the chart: its condition, a finding and a treatment for each of
 * the five surfaces, and a note. Every change is applied at once; clearing everything removes the
 * tooth from the entry.
 */
export function ToothPanel({ code, record, onChange, onClose }: ToothPanelProps) {
  const { t } = useTranslation('clinical');
  const headingId = useId();
  const conditionId = useId();
  const noteId = useId();
  const current: ToothRecord = record ?? {};

  const patchSurface = (
    surface: ToothSurface,
    patch: { finding?: SurfaceFinding | undefined; treatment?: string | undefined },
  ) => {
    const before = current.surfaces?.[surface] ?? {};
    onChange({
      ...current,
      surfaces: { ...current.surfaces, [surface]: { ...before, ...patch } },
    });
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-4 rounded-lg border bg-card p-4">
      <h3 id={headingId} className="font-display text-base font-semibold">
        {t('odontology.edit.title', { code })}
      </h3>

      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor={conditionId}>{t('odontology.edit.condition')}</Label>
        <Select
          id={conditionId}
          value={current.condition ?? ''}
          onChange={(event) => {
            const condition = asCondition(event.target.value);
            onChange({ ...current, condition });
          }}
        >
          <option value="">{t('odontology.edit.condition.none')}</option>
          {TOOTH_CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>
              {t(`odontology.condition.${condition}`)}
            </option>
          ))}
        </Select>
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">{t('odontology.edit.surfaces')}</legend>
        {TOOTH_SURFACES.map((surface) => {
          const entry = current.surfaces?.[surface];
          const label = t(`odontology.surface.${surface}`);
          const surfaceName = label.toLowerCase();
          return (
            <div
              key={surface}
              className="grid gap-2 rounded-md border p-3 sm:grid-cols-[10rem_1fr_1fr] sm:items-end"
            >
              <p className="text-sm font-medium">{label}</p>
              <div className="grid gap-1.5">
                <Label htmlFor={`${headingId}-${surface}-finding`}>
                  {t('odontology.edit.findingFor', { surface: surfaceName })}
                </Label>
                <Select
                  id={`${headingId}-${surface}-finding`}
                  value={entry?.finding ?? ''}
                  onChange={(event) => {
                    patchSurface(surface, { finding: asFinding(event.target.value) });
                  }}
                >
                  <option value="">{t('odontology.edit.finding.none')}</option>
                  {SURFACE_FINDINGS.map((finding) => (
                    <option key={finding} value={finding}>
                      {t(`odontology.finding.${finding}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${headingId}-${surface}-treatment`}>
                  {t('odontology.edit.treatmentFor', { surface: surfaceName })}
                </Label>
                <Input
                  id={`${headingId}-${surface}-treatment`}
                  autoComplete="off"
                  maxLength={200}
                  value={entry?.treatment ?? ''}
                  onChange={(event) => {
                    patchSurface(surface, { treatment: event.target.value });
                  }}
                />
              </div>
            </div>
          );
        })}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor={noteId}>{t('odontology.edit.note')}</Label>
        <Textarea
          id={noteId}
          rows={2}
          maxLength={500}
          value={current.note ?? ''}
          onChange={(event) => {
            onChange({ ...current, note: event.target.value });
          }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            onChange(undefined);
          }}
        >
          {t('odontology.edit.clear')}
        </Button>
        <Button onClick={onClose}>{t('odontology.edit.close')}</Button>
      </div>
    </section>
  );
}
