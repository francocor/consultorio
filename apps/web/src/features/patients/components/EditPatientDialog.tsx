import type { PatientDto, RightsRequestDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Form } from '../../../shared/ui/form.js';
import { toast } from '../../../shared/ui/toaster.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';
import {
  buildPatientSchema,
  toUpdateRequest,
  valuesFromPatient,
  type PatientFormValues,
} from '../domain/patient-form.js';

import { PatientFields } from './PatientFields.js';

/**
 * Edits the personal data. It can also carry out a rectification request of the patient: the same
 * form, and saving applies the correction and closes the request.
 */
export function EditPatientDialog({
  patient,
  open,
  onOpenChange,
  fulfilling,
}: {
  patient: PatientDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fulfilling?: RightsRequestDto | undefined;
}) {
  const { t } = useTranslation('patients');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('form.editTitle')}</DialogTitle>
          <DialogDescription>
            {fulfilling ? t('form.rectificationDescription') : t('form.editDescription')}
          </DialogDescription>
        </DialogHeader>
        {/* A fresh form per version: after a refresh the fields show what is now on file. */}
        <EditPatientForm
          key={patient.version}
          patient={patient}
          fulfilling={fulfilling}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditPatientForm({
  patient,
  fulfilling,
  onDone,
}: {
  patient: PatientDto;
  fulfilling: RightsRequestDto | undefined;
  onDone: () => void;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const today = useMemo(() => new Date(), []);
  const form = useForm<PatientFormValues>({
    resolver: zodResolver(buildPatientSchema({ mode: 'edit', today })),
    defaultValues: valuesFromPatient(patient),
  });

  const save = useMutation({
    mutationFn: async (changes: ReturnType<typeof toUpdateRequest>) => {
      if (fulfilling) await patientsApi(api).fulfillRights(patient.id, fulfilling.id, changes);
      else await patientsApi(api).update(patient.id, changes);
    },
    onSuccess: async () => {
      toast.success(t(fulfilling ? 'patients:rights.fulfilled' : 'patients:detail.updated'));
      onDone();
      await queryClient.invalidateQueries({ queryKey: patientKeys.all });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { document: 'documentNumber' });
    },
  });

  const stale = isApiError(save.error) && save.error.code === 'stale_revision';
  const failed = save.isError && !stale && fieldErrorCount(save.error) === 0;

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            const changes = toUpdateRequest(values, patient);
            // `expectedVersion` alone is no change: there is nothing to send.
            if (Object.keys(changes).length === 1) onDone();
            else save.mutate(changes);
          })(event);
        }}
      >
        {stale ? (
          <Alert tone="warning">
            <AlertTitle>{t('patients:form.stale.title')}</AlertTitle>
            <AlertDescription className="grid gap-2">
              <p>{t('patients:form.stale.description')}</p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: patientKeys.detail(patient.id) });
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

        <PatientFields form={form} mode="edit" today={today} />

        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            {t('common:action.cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('patients:form.submit.save')}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
