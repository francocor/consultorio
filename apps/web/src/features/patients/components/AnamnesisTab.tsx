import type { AnamnesisVersionDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../../shared/ui/card.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { SafetyFlag } from '../../../shared/ui/states/safety-flag.js';
import { toast } from '../../../shared/ui/toaster.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';
import {
  deriveSafetyFlags,
  EMPTY_ANAMNESIS_FORM,
  toAnamnesisContent,
  valuesFromAnamnesis,
  type AnamnesisFormValues,
} from '../domain/anamnesis.js';

import { Section } from './Section.js';

const SEVERITIES = ['mild', 'moderate', 'severe'] as const;
type Indicator = 'pregnant' | 'implantedDevice' | 'anticoagulated';
const INDICATORS: readonly Indicator[] = ['pregnant', 'implantedDevice', 'anticoagulated'];

/** Clinical history of the patient: only for professionals, and every read is audited. */
export function AnamnesisTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation('patients');
  const api = useApi();
  const anamnesis = useQuery({
    queryKey: patientKeys.anamnesis(patientId),
    queryFn: () => patientsApi(api).anamnesis(patientId),
    // A refusal is an answer, not a glitch: do not hammer a clinical record that says no.
    retry: false,
  });

  if (anamnesis.isPending) return <FormSkeleton fields={4} />;
  if (anamnesis.isError) {
    if (isApiError(anamnesis.error) && anamnesis.error.status === 403) {
      return (
        <EmptyState
          title={t('anamnesis.noRelationship.title')}
          description={t('anamnesis.noRelationship')}
        />
      );
    }
    return (
      <ErrorState
        error={anamnesis.error}
        onRetry={() => {
          void anamnesis.refetch();
        }}
      />
    );
  }
  return (
    // A new version from the server starts a fresh form: what is shown is what is on file.
    <AnamnesisForm
      key={anamnesis.data.current?.version ?? 0}
      patientId={patientId}
      current={anamnesis.data.current}
    />
  );
}

/** Replaces one row of a list, leaving the others as they were. */
function patchRow<T>(rows: readonly T[], index: number, patch: Partial<T>): T[] {
  return rows.map((row, position) => (position === index ? { ...row, ...patch } : row));
}

function withoutRow<T>(rows: readonly T[], index: number): T[] {
  return rows.filter((_, position) => position !== index);
}

function AnamnesisForm({
  patientId,
  current,
}: {
  patientId: string;
  current: AnamnesisVersionDto | null;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<AnamnesisFormValues>(
    current ? valuesFromAnamnesis(current.content) : EMPTY_ANAMNESIS_FORM,
  );
  const update = (patch: Partial<AnamnesisFormValues>) => {
    setValues((previous) => ({ ...previous, ...patch }));
  };

  const save = useMutation({
    mutationFn: () =>
      patientsApi(api).saveAnamnesis(patientId, {
        content: toAnamnesisContent(values),
        expectedVersion: current?.version ?? 0,
      }),
    onSuccess: async () => {
      toast.success(t('patients:anamnesis.saved'));
      // The alert on the record header follows the anamnesis: refresh both.
      await queryClient.invalidateQueries({ queryKey: patientKeys.all });
    },
  });

  const stale = isApiError(save.error) && save.error.code === 'stale_revision';
  const failed = save.isError && !stale;
  const flags = deriveSafetyFlags(toAnamnesisContent(values));

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('patients:anamnesis.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('patients:anamnesis.description')}</p>
        <p className="text-sm font-medium">
          {current
            ? t('patients:anamnesis.version', {
                version: current.version,
                date: formatDate(current.savedAt),
              })
            : t('patients:anamnesis.empty')}
        </p>
      </div>

      {stale ? (
        <Alert tone="warning">
          <AlertDescription className="grid gap-2">
            <p>{t('patients:anamnesis.stale')}</p>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: patientKeys.anamnesis(patientId) });
              }}
            >
              {t('patients:form.stale.action')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {failed ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <Section title={t('patients:anamnesis.allergies')}>
        <div className="grid gap-3">
          {values.allergies.map((row, index) => (
            <div
              // Rows have no identity of their own: they are added and removed in place.
              key={index}
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end"
            >
              <Field label={t('patients:anamnesis.allergy.substance')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    value={row.substance}
                    onChange={(event) => {
                      update({
                        allergies: patchRow(values.allergies, index, {
                          substance: event.target.value,
                        }),
                      });
                    }}
                  />
                )}
              </Field>
              <Field label={t('patients:anamnesis.allergy.reaction')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    value={row.reaction}
                    onChange={(event) => {
                      update({
                        allergies: patchRow(values.allergies, index, {
                          reaction: event.target.value,
                        }),
                      });
                    }}
                  />
                )}
              </Field>
              <Field label={t('patients:anamnesis.allergy.severity')}>
                {(id) => (
                  <Select
                    id={id}
                    value={row.severity}
                    onChange={(event) => {
                      const severity = SEVERITIES.find((option) => option === event.target.value);
                      update({
                        allergies: patchRow(values.allergies, index, { severity: severity ?? '' }),
                      });
                    }}
                  >
                    <option value="">{t('patients:anamnesis.severity.none')}</option>
                    {SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {t(`patients:anamnesis.severity.${severity}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <RemoveRow
                label={t('patients:anamnesis.allergy.remove', { n: index + 1 })}
                onRemove={() => {
                  update({ allergies: withoutRow(values.allergies, index) });
                }}
              />
            </div>
          ))}
          <AddRow
            label={t('patients:anamnesis.allergy.add')}
            onAdd={() => {
              update({
                allergies: [...values.allergies, { substance: '', reaction: '', severity: '' }],
              });
            }}
          />
        </div>
      </Section>

      <Section title={t('patients:anamnesis.medications')}>
        <div className="grid gap-3">
          {values.medications.map((row, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
            >
              <Field label={t('patients:anamnesis.medication.name')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    value={row.name}
                    onChange={(event) => {
                      update({
                        medications: patchRow(values.medications, index, {
                          name: event.target.value,
                        }),
                      });
                    }}
                  />
                )}
              </Field>
              <Field label={t('patients:anamnesis.medication.dose')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    value={row.dose}
                    onChange={(event) => {
                      update({
                        medications: patchRow(values.medications, index, {
                          dose: event.target.value,
                        }),
                      });
                    }}
                  />
                )}
              </Field>
              <RemoveRow
                label={t('patients:anamnesis.medication.remove', { n: index + 1 })}
                onRemove={() => {
                  update({ medications: withoutRow(values.medications, index) });
                }}
              />
              <div className="sm:col-span-3">
                <CheckboxCard
                  checked={row.anticoagulant}
                  onCheckedChange={(checked) => {
                    update({
                      medications: patchRow(values.medications, index, { anticoagulant: checked }),
                    });
                  }}
                  title={t('patients:anamnesis.medication.anticoagulant')}
                />
              </div>
            </div>
          ))}
          <AddRow
            label={t('patients:anamnesis.medication.add')}
            onAdd={() => {
              update({
                medications: [...values.medications, { name: '', dose: '', anticoagulant: false }],
              });
            }}
          />
        </div>
      </Section>

      <Section title={t('patients:anamnesis.conditions')}>
        <div className="grid gap-3">
          {values.conditions.map((row, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
            >
              <Field label={t('patients:anamnesis.condition.name')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    value={row.name}
                    onChange={(event) => {
                      update({
                        conditions: patchRow(values.conditions, index, {
                          name: event.target.value,
                        }),
                      });
                    }}
                  />
                )}
              </Field>
              <Field label={t('patients:anamnesis.condition.since')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    value={row.since}
                    onChange={(event) => {
                      update({
                        conditions: patchRow(values.conditions, index, {
                          since: event.target.value,
                        }),
                      });
                    }}
                  />
                )}
              </Field>
              <RemoveRow
                label={t('patients:anamnesis.condition.remove', { n: index + 1 })}
                onRemove={() => {
                  update({ conditions: withoutRow(values.conditions, index) });
                }}
              />
            </div>
          ))}
          <AddRow
            label={t('patients:anamnesis.condition.add')}
            onAdd={() => {
              update({ conditions: [...values.conditions, { name: '', since: '' }] });
            }}
          />
        </div>
      </Section>

      <Section title={t('patients:anamnesis.antecedents')}>
        <Field label={t('patients:anamnesis.antecedentsHelp')}>
          {(id) => (
            <Textarea
              id={id}
              rows={4}
              value={values.antecedents}
              onChange={(event) => {
                update({ antecedents: event.target.value });
              }}
            />
          )}
        </Field>
      </Section>

      <Section title={t('patients:anamnesis.indicators')}>
        <div className="grid gap-2 sm:grid-cols-3">
          {INDICATORS.map((indicator) => (
            <CheckboxCard
              key={indicator}
              checked={values[indicator]}
              onCheckedChange={(checked) => {
                update({ [indicator]: checked });
              }}
              title={t(`patients:anamnesis.indicator.${indicator}`)}
            />
          ))}
        </div>
      </Section>

      <Card>
        <CardHeader>
          <CardTitle>{t('patients:anamnesis.flag.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t('patients:anamnesis.flag.description')}
          </p>
          {flags.length === 0 ? (
            <p className="text-sm font-medium">{t('patients:anamnesis.flag.none')}</p>
          ) : (
            <SafetyFlag flags={flags} detail="kinds" />
          )}
        </CardContent>
      </Card>

      <div>
        <Button type="submit" loading={save.isPending}>
          {t('patients:anamnesis.save')}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

function AddRow({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <Button variant="outline" className="w-fit" onClick={onAdd}>
      <Plus aria-hidden="true" />
      {label}
    </Button>
  );
}

function RemoveRow({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} onClick={onRemove}>
      <X aria-hidden="true" />
    </Button>
  );
}
