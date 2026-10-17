import type { SettingsDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { describeError } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import { Switch } from '../../../../shared/ui/checkbox.js';
import { Input } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { settingsApi, settingsKeys } from '../../api/settings-api.js';
import {
  draftOf,
  patchOf,
  validateRules,
  type RulesDraft,
  type RulesField,
} from '../domain/rules-form.js';

const FIELDS: readonly { field: RulesField; label: string; help: string }[] = [
  { field: 'minLeadHours', label: 'rules.lead', help: 'rules.leadHelp' },
  { field: 'horizonDays', label: 'rules.horizon', help: 'rules.horizonHelp' },
  { field: 'dailyCap', label: 'rules.cap', help: 'rules.capHelp' },
  { field: 'rescheduleDeadlineHours', label: 'rules.deadline', help: 'rules.deadlineHelp' },
];

/**
 * The `onlineBooking` section of the organization settings: how far ahead and how soon a visitor
 * can book, how many bookings a professional takes a day, until when a patient can change or
 * cancel, and whether every booking waits for approval. Saves only what changed.
 */
export function RulesSection({
  settings,
  canEdit,
  readOnly,
}: {
  settings: SettingsDto;
  /** Whoever changes the settings of the organization. Others see the rules, not the controls. */
  canEdit: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation(['bookingAdmin', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RulesDraft>(() => draftOf(settings.onlineBooking));
  const [attempted, setAttempted] = useState(false);

  const check = validateRules(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings.onlineBooking));
  const disabled = !canEdit || readOnly;

  const save = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof patchOf>>) =>
      settingsApi(api).update({ onlineBooking: body }),
    onSuccess: (updated) => {
      toast.success(t('bookingAdmin:rules.saved'));
      setDraft(draftOf(updated.onlineBooking));
      setAttempted(false);
      queryClient.setQueryData(settingsKeys.all, updated);
    },
  });

  const submit = () => {
    setAttempted(true);
    if (!check.values) return;
    const patch = patchOf(settings.onlineBooking, check.values);
    if (patch) save.mutate(patch);
  };

  return (
    <form
      aria-labelledby="rules-title"
      className="grid gap-3 rounded-lg border bg-card p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-0.5">
        <h3 id="rules-title" className="font-medium">
          {t('bookingAdmin:rules.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('bookingAdmin:rules.description')}</p>
      </div>

      {canEdit ? null : (
        <p className="text-sm text-muted-foreground">{t('bookingAdmin:rules.noEdit')}</p>
      )}
      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(({ field, label, help }) => {
          const error = attempted ? check.errors[field] : undefined;
          const id = `rules-${field}`;
          return (
            <div key={field} className="grid content-start gap-1.5">
              <Label htmlFor={id}>{t(`bookingAdmin:${label}`)}</Label>
              <Input
                id={id}
                inputMode="numeric"
                value={draft[field]}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
                onChange={(event) => {
                  setDraft({ ...draft, [field]: event.target.value });
                }}
              />
              <p id={`${id}-help`} className="text-xs text-muted-foreground">
                {t(`bookingAdmin:${help}`)}
              </p>
              {error ? (
                <p id={`${id}-error`} className="text-sm text-destructive">
                  {t(error)}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <Label htmlFor="rules-approval">{t('bookingAdmin:rules.approval')}</Label>
          <p className="text-sm text-muted-foreground">{t('bookingAdmin:rules.approvalHelp')}</p>
        </div>
        <Switch
          id="rules-approval"
          checked={draft.requireApproval}
          disabled={disabled}
          onCheckedChange={(on) => {
            setDraft({ ...draft, requireApproval: on });
          }}
        />
      </div>

      {canEdit ? (
        <div>
          <Button type="submit" disabled={!dirty || readOnly} loading={save.isPending}>
            {t('bookingAdmin:rules.save')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
