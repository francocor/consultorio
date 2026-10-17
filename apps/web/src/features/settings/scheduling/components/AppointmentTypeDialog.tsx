import type { AppointmentTypeDto } from '@consultorio/contracts';
import { APPOINTMENT_MODES } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { describeError } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import { Checkbox } from '../../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../shared/ui/dialog.js';
import { Input, Select, Textarea } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { toast } from '../../../../shared/ui/toaster.js';
import type { SchedulingProfessional } from '../../../calendar/containers/use-scheduling-people.js';
import { schedulingSettingsApi, schedulingSettingsKeys } from '../api/scheduling-settings-api.js';
import {
  diffType,
  typeToForm,
  validateType,
  type TypeFormField,
  type TypeFormValues,
} from '../domain/type-form.js';

/** An example of the format, not a word: it is the same in every language. */
const EXAMPLE_COLOR = '#0f766e';

const BLANK: TypeFormValues = {
  name: '',
  description: '',
  durationMinutes: '',
  bufferMinutes: '0',
  mode: 'in_person',
  requiresApproval: false,
  color: '',
  professionalIds: [],
};

/** Creates an appointment type, or edits one when `type` is given. */
export function AppointmentTypeDialog({
  type,
  professionals,
  onClose,
}: {
  /** `null` creates; a type edits it. */
  type: AppointmentTypeDto | null;
  professionals: readonly SchedulingProfessional[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<TypeFormValues>(type ? typeToForm(type) : BLANK);
  const [errors, setErrors] = useState<Partial<Record<TypeFormField, string>>>({});

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const checked = validateType(values);
      if (!checked.ok) {
        setErrors(checked.errors);
        return;
      }
      setErrors({});
      if (type) {
        const patch = diffType(type, checked.request);
        if (Object.keys(patch).length > 0)
          await schedulingSettingsApi(api).updateType(type.id, patch);
      } else {
        await schedulingSettingsApi(api).createType(checked.request);
      }
      toast.success(
        t(type ? 'scheduling:config.types.updated' : 'scheduling:config.types.created'),
      );
      await queryClient.invalidateQueries({ queryKey: schedulingSettingsKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'types'] });
      onClose();
    },
  });

  function set<K extends keyof TypeFormValues>(key: K, value: TypeFormValues[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  const message = (field: TypeFormField) =>
    errors[field] ? t(`scheduling:config.types.errors.${errors[field]}`) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(type ? 'scheduling:config.types.editTitle' : 'scheduling:config.types.newTitle')}
          </DialogTitle>
          <DialogDescription>{t('scheduling:config.types.formHelp')}</DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {save.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
            </Alert>
          ) : null}

          <Field id="type-name" label={t('scheduling:config.types.name')} error={message('name')}>
            <Input
              id="type-name"
              autoComplete="off"
              value={values.name}
              aria-invalid={errors.name !== undefined}
              onChange={(event) => {
                set('name', event.target.value);
              }}
            />
          </Field>
          <Field
            id="type-description"
            label={t('scheduling:config.types.descriptionField')}
            error={null}
          >
            <Textarea
              id="type-description"
              rows={2}
              maxLength={300}
              value={values.description}
              onChange={(event) => {
                set('description', event.target.value);
              }}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="type-duration"
              label={t('scheduling:config.types.duration')}
              error={message('durationMinutes')}
            >
              <Input
                id="type-duration"
                inputMode="numeric"
                value={values.durationMinutes}
                aria-invalid={errors.durationMinutes !== undefined}
                onChange={(event) => {
                  set('durationMinutes', event.target.value);
                }}
              />
            </Field>
            <Field
              id="type-buffer"
              label={t('scheduling:config.types.buffer')}
              error={message('bufferMinutes')}
              help={t('scheduling:config.types.bufferHelp')}
            >
              <Input
                id="type-buffer"
                inputMode="numeric"
                value={values.bufferMinutes}
                aria-invalid={errors.bufferMinutes !== undefined}
                onChange={(event) => {
                  set('bufferMinutes', event.target.value);
                }}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="type-mode" label={t('scheduling:config.types.mode')} error={null}>
              <Select
                id="type-mode"
                value={values.mode}
                onChange={(event) => {
                  set('mode', event.target.value === 'virtual' ? 'virtual' : 'in_person');
                }}
              >
                {APPOINTMENT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`scheduling:config.types.modeOption.${mode}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="type-color"
              label={t('scheduling:config.types.color')}
              error={message('color')}
              help={t('scheduling:config.types.colorHelp')}
            >
              <Input
                id="type-color"
                autoComplete="off"
                placeholder={EXAMPLE_COLOR}
                value={values.color}
                aria-invalid={errors.color !== undefined}
                onChange={(event) => {
                  set('color', event.target.value);
                }}
              />
            </Field>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="type-approval"
              checked={values.requiresApproval}
              onCheckedChange={(checked) => {
                set('requiresApproval', checked === true);
              }}
            />
            <Label htmlFor="type-approval" className="font-normal leading-snug">
              {t('scheduling:config.types.requiresApproval')}
            </Label>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">
              {t('scheduling:config.types.professionals')}
            </legend>
            <p className="text-sm text-muted-foreground">
              {t('scheduling:config.types.professionalsHelp')}
            </p>
            {professionals.map((professional) => (
              <div key={professional.id} className="flex items-center gap-2">
                <Checkbox
                  id={`type-pro-${professional.id}`}
                  checked={values.professionalIds.includes(professional.id)}
                  onCheckedChange={(checked) => {
                    set(
                      'professionalIds',
                      checked === true
                        ? [...values.professionalIds, professional.id]
                        : values.professionalIds.filter((id) => id !== professional.id),
                    );
                  }}
                />
                <Label htmlFor={`type-pro-${professional.id}`} className="font-normal">
                  {professional.name}
                </Label>
              </div>
            ))}
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t(type ? 'scheduling:config.types.save' : 'scheduling:config.types.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <p className="text-sm text-muted-foreground">{help}</p> : null}
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
