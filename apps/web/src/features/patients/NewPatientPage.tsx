import type { CreatePatientResponse, PatientSummaryDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { cn } from '../../shared/lib/cn.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../shared/lib/form-errors.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../shared/ui/alert.js';
import { Button, buttonVariants } from '../../shared/ui/button.js';
import { Form } from '../../shared/ui/form.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { toast } from '../../shared/ui/toaster.js';

import { patientKeys, patientsApi } from './api/patients-api.js';
import { PatientFields } from './components/PatientFields.js';
import { documentText } from './components/PatientRow.js';
import {
  buildPatientSchema,
  EMPTY_PATIENT_FORM,
  toCreateRequest,
  type PatientFormValues,
} from './domain/patient-form.js';

/** Registers a patient. A document already on file blocks it; a likely duplicate only warns. */
export function NewPatientPage() {
  const { t } = useTranslation(['patients', 'common']);
  usePageTitle(t('patients:new'));
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const today = useMemo(() => new Date(), []);
  const [created, setCreated] = useState<CreatePatientResponse | null>(null);

  const form = useForm<PatientFormValues>({
    resolver: zodResolver(buildPatientSchema({ mode: 'create', today })),
    defaultValues: EMPTY_PATIENT_FORM,
  });

  const create = useMutation({
    mutationFn: (values: PatientFormValues) => patientsApi(api).create(toCreateRequest(values)),
    onSuccess: async (result) => {
      toast.success(t('patients:form.created'));
      await queryClient.invalidateQueries({ queryKey: patientKeys.all });
      if (result.possibleDuplicates.length > 0) setCreated(result);
      else await router.navigate({ to: `/patients/${result.patient.id}` });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, {
        document: 'documentNumber',
        'representative.fullName': 'representativeName',
        representative: 'representativeContact',
      });
    },
  });

  const existing = isApiError(create.error)
    ? create.error.extensions['existingPatient']
    : undefined;
  const duplicate = isPatientSummary(existing) ? existing : null;
  const failed = create.isError && !duplicate && fieldErrorCount(create.error) === 0;

  if (created) return <CreatedWithWarnings result={created} />;

  return (
    <div>
      <Link
        to="/patients"
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t('patients:detail.back')}
      </Link>
      <PageHeader
        title={t('patients:form.createTitle')}
        description={t('patients:form.createDescription')}
      />

      {duplicate ? (
        <Alert tone="danger" className="mb-5">
          <AlertTitle>{t('patients:form.duplicate.title')}</AlertTitle>
          <AlertDescription>
            <p>{t('patients:form.duplicate.description')}</p>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong>{`${duplicate.familyName}, ${duplicate.givenNames}`}</strong>
              <span className="tabular">{documentText(duplicate.document)}</span>
              <Link
                to={`/patients/${duplicate.id}`}
                className="font-medium underline underline-offset-4"
              >
                {t('patients:form.duplicate.open')}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {failed ? (
        <Alert tone="danger" className="mb-5">
          <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <Form {...form}>
        <form
          noValidate
          className="grid max-w-3xl gap-5"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              create.mutate(values);
            })(event);
          }}
        >
          <PatientFields form={form} mode="create" today={today} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={create.isPending}>
              {t('patients:form.submit.create')}
            </Button>
            <Link to="/patients" className={cn(buttonVariants({ variant: 'ghost' }))}>
              {t('patients:form.cancel')}
            </Link>
          </div>
        </form>
      </Form>
    </div>
  );
}

function isPatientSummary(value: unknown): value is PatientSummaryDto {
  return typeof value === 'object' && value !== null && 'id' in value && 'familyName' in value;
}

/** The patient is saved, and people with the same name and birth date exist: review, never block. */
function CreatedWithWarnings({ result }: { result: CreatePatientResponse }) {
  const { t } = useTranslation('patients');
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader
        title={t('patients:possibleDuplicates.title')}
        description={t('possibleDuplicates.description')}
      />
      <Alert tone="warning">
        <AlertTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4" aria-hidden="true" />
          {`${result.patient.familyName}, ${result.patient.givenNames}`}
        </AlertTitle>
        <AlertDescription>
          <ul className="grid gap-2">
            {result.possibleDuplicates.map((other) => (
              <li key={other.id}>
                <Link
                  to={`/patients/${other.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {t('possibleDuplicates.openExisting', {
                    name: `${other.familyName}, ${other.givenNames}`,
                  })}
                </Link>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
      <Link to={`/patients/${result.patient.id}`} className={cn(buttonVariants(), 'w-fit')}>
        {t('possibleDuplicates.openNew')}
      </Link>
    </div>
  );
}
