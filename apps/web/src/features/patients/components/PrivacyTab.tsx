import {
  RIGHTS_REQUEST_KINDS,
  type ConsentResponse,
  type PatientCopyDto,
  type PatientDto,
  type RightsRequestDto,
} from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FilePlus2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { downloadJson } from '../../../shared/lib/download.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Select, Textarea } from '../../../shared/ui/input.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';
import { toast } from '../../../shared/ui/toaster.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { EditPatientDialog } from './EditPatientDialog.js';
import { Section } from './Section.js';

/** Consent to the processing of personal data and the rights of access and rectification. */
export function PrivacyTab({ patient, canWrite }: { patient: PatientDto; canWrite: boolean }) {
  return (
    <div className="grid gap-4">
      <ConsentSection patientId={patient.id} canWrite={canWrite} />
      <RightsSection patient={patient} canWrite={canWrite} />
    </div>
  );
}

function ConsentSection({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const consent = useQuery({
    queryKey: patientKeys.consent(patientId),
    queryFn: () => patientsApi(api).consent(patientId),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: patientKeys.all });
  };
  const record = useMutation({
    mutationFn: () => patientsApi(api).recordConsent(patientId),
    onSuccess: async () => {
      toast.success(t('patients:consent.recorded'));
      await refresh();
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });
  const revoke = useMutation({
    mutationFn: () => patientsApi(api).revokeConsent(patientId),
    onSuccess: async () => {
      setConfirming(false);
      toast.success(t('patients:consent.revokeDone'));
      await refresh();
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(describeError(t, error).message);
    },
  });

  if (consent.isPending) return <ListSkeleton rows={1} />;
  if (consent.isError) {
    return (
      <ErrorState
        error={consent.error}
        onRetry={() => {
          void consent.refetch();
        }}
      />
    );
  }
  const { status, current, history } = consent.data;

  return (
    <Section title={t('patients:consent.title')} description={t('patients:consent.description')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <p>
            <StatusBadge status={status === 'granted' ? 'ok' : 'warning'}>
              {t(`patients:consent.${status}`)}
            </StatusBadge>
          </p>
          {current && status === 'granted' ? (
            <p className="text-sm text-muted-foreground">
              {t('patients:consent.grantedOn', { date: formatDate(current.grantedAt) })}
            </p>
          ) : null}
          {current?.revokedAt ? (
            <p className="text-sm text-muted-foreground">
              {t('patients:consent.revokedOn', { date: formatDate(current.revokedAt) })}
            </p>
          ) : null}
        </div>
        {canWrite ? (
          status === 'granted' ? (
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t('patients:consent.revoke')}
            </Button>
          ) : (
            <Button
              loading={record.isPending}
              onClick={() => {
                record.mutate();
              }}
            >
              <ShieldCheck aria-hidden="true" />
              {t('patients:consent.record')}
            </Button>
          )
        ) : null}
      </div>
      <ConsentHistory history={history} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('patients:consent.revoke.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('patients:consent.revoke.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                revoke.mutate();
              }}
            >
              {t('patients:consent.revoke.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function ConsentHistory({ history }: { history: ConsentResponse['history'] }) {
  const { t } = useTranslation('patients');
  if (history.length === 0) return null;
  return (
    <div className="mt-4 border-t pt-4">
      <h3 className="mb-2 text-sm font-medium">{t('consent.history')}</h3>
      <ul className="grid gap-1.5 text-sm text-muted-foreground">
        {history.map((entry) => (
          <li key={entry.id} className="flex flex-wrap gap-x-3">
            <span>{t('consent.grantedOn', { date: formatDate(entry.grantedAt) })}</span>
            <span>{t('consent.version', { version: entry.textVersion })}</span>
            {entry.revokedAt ? (
              <span>{t('consent.revokedOn', { date: formatDate(entry.revokedAt) })}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RightsSection({ patient, canWrite }: { patient: PatientDto; canWrite: boolean }) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [rectifying, setRectifying] = useState<RightsRequestDto | null>(null);
  const [copy, setCopy] = useState<PatientCopyDto | null>(null);

  const requests = useQuery({
    queryKey: patientKeys.rights(patient.id),
    queryFn: () => patientsApi(api).rights(patient.id),
  });

  const fulfill = useMutation({
    mutationFn: (request: RightsRequestDto) =>
      patientsApi(api).fulfillRights(patient.id, request.id),
    onSuccess: async (result) => {
      toast.success(t('patients:rights.fulfilled'));
      setCopy(result.copy);
      await queryClient.invalidateQueries({ queryKey: patientKeys.rights(patient.id) });
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  if (requests.isPending) return <ListSkeleton rows={2} />;
  if (requests.isError) {
    return (
      <ErrorState
        error={requests.error}
        onRetry={() => {
          void requests.refetch();
        }}
      />
    );
  }

  return (
    <>
      <Section
        title={t('patients:rights.title')}
        description={t('patients:rights.description')}
        action={
          canWrite ? (
            <Button
              variant="outline"
              onClick={() => {
                setCreating(true);
              }}
            >
              <FilePlus2 aria-hidden="true" />
              {t('patients:rights.add')}
            </Button>
          ) : null
        }
      >
        {requests.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('patients:rights.empty')}</p>
        ) : (
          <ul className="grid gap-3">
            {requests.data.map((request) => (
              <li
                key={request.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t(`patients:rights.kind.${request.kind}`)}</span>
                    <StatusBadge status={request.status === 'open' ? 'pending' : 'ok'}>
                      {t(`patients:rights.status.${request.status}`)}
                    </StatusBadge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('patients:rights.requestedOn', { date: formatDate(request.requestedAt) })}
                  </p>
                  {request.note ? <p className="text-sm">{request.note}</p> : null}
                </div>
                {canWrite && request.status === 'open' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={fulfill.isPending && fulfill.variables.id === request.id}
                    onClick={() => {
                      if (request.kind === 'rectification') setRectifying(request);
                      else fulfill.mutate(request);
                    }}
                  >
                    {t('patients:rights.fulfill')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {copy ? <CopyCard copy={copy} /> : null}

      <CreateRequestDialog patientId={patient.id} open={creating} onOpenChange={setCreating} />
      {rectifying ? (
        <EditPatientDialog
          patient={patient}
          open
          fulfilling={rectifying}
          onOpenChange={(open) => {
            if (!open) setRectifying(null);
          }}
        />
      ) : null}
    </>
  );
}

/** The data of the patient in a file they can be handed. The clinical copy is a separate act. */
function CopyCard({ copy }: { copy: PatientCopyDto }) {
  const { t } = useTranslation('patients');
  return (
    <Section
      title={t('rights.copy.title')}
      description={t('rights.copy.description', { date: formatDate(copy.generatedAt) })}
    >
      <Button
        onClick={() => {
          downloadJson(`datos-${copy.patient.id}.json`, copy);
        }}
      >
        <Download aria-hidden="true" />
        {t('rights.copy.download')}
      </Button>
    </Section>
  );
}

const RequestSchema = z.object({
  kind: z.enum(RIGHTS_REQUEST_KINDS),
  note: z.string().trim().max(300),
});
type RequestValues = z.infer<typeof RequestSchema>;

function CreateRequestDialog({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<RequestValues>({
    resolver: zodResolver(RequestSchema),
    defaultValues: { kind: 'access', note: '' },
  });

  const create = useMutation({
    mutationFn: (values: RequestValues) =>
      patientsApi(api).createRights(patientId, {
        kind: values.kind,
        ...(values.note === '' ? {} : { note: values.note }),
      }),
    onSuccess: async () => {
      toast.success(t('patients:rights.created'));
      form.reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: patientKeys.rights(patientId) });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });
  const failed = create.isError && fieldErrorCount(create.error) === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          create.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <Form {...form}>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                create.mutate(values);
              })(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('patients:rights.form.title')}</DialogTitle>
              <DialogDescription>{t('patients:rights.description')}</DialogDescription>
            </DialogHeader>
            {failed ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patients:rights.form.kind')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      {RIGHTS_REQUEST_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`patients:rights.kind.${kind}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patients:rights.form.note')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormDescription>{t('patients:rights.form.noteHelp')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('patients:rights.form.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
