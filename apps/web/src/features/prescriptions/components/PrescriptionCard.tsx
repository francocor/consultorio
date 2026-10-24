import type { PrescriptionDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileCheck2, Pencil, RefreshCw, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatCalendarDay, formatDateTime, formatDocument } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { toast } from '../../../shared/ui/toaster.js';
import { prescriptionKeys, prescriptionsApi } from '../api/prescriptions-api.js';
import { actionsOf, displayState } from '../domain/states.js';

import { CancelPrescriptionDialog } from './CancelPrescriptionDialog.js';
import { ErrorAlert } from './ErrorAlert.js';
import { IssuePrescriptionDialog } from './IssuePrescriptionDialog.js';
import { PrescriptionStateBadge } from './PrescriptionStateBadge.js';
import { RegisterManualDialog } from './RegisterManualDialog.js';

type Dialogs = 'cancel' | 'register' | 'correct' | null;

/**
 * One prescription: where it stands (an icon and a word, never "emitida" until the provider
 * confirmed it), its medications by generic name, why it is not issued when it is not, and what the
 * prescriber can do about it. A colleague who treats the patient reads it and downloads its document.
 */
export function PrescriptionCard({
  prescription,
  professionalId,
  showPatient = false,
}: {
  prescription: PrescriptionDto;
  /** The professional looking at it: only the prescriber changes a prescription. */
  professionalId: string | null;
  /** The list of a professional crosses patients, so it names them. */
  showPatient?: boolean;
}) {
  const { t } = useTranslation(['prescriptions', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const state = displayState(prescription);
  const actions = actionsOf(prescription, professionalId);
  const titleId = `prescription-${prescription.id}`;

  const retry = useMutation({
    mutationFn: () => prescriptionsApi(api).retry(prescription.id),
    onSuccess: async (result) => {
      if (result.status === 'issued') toast.success(t('prescriptions:issue.issued'));
      else toast.warning(t('prescriptions:retry.still'));
      await queryClient.invalidateQueries({ queryKey: prescriptionKeys.all });
    },
  });
  const download = useMutation({
    mutationFn: () => prescriptionsApi(api).downloadPdf(prescription.id),
    onSuccess: (file) => {
      downloadBlob(file.blob, file.filename ?? `receta-${prescription.date}.pdf`);
    },
  });

  const coverage = prescription.patient.coverage;
  const failure = prescription.failure;

  return (
    <article aria-labelledby={titleId} className="grid gap-3 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 id={titleId} className="font-medium">
            {showPatient
              ? t('prescriptions:card.titleFor', {
                  patient: prescription.patient.fullName,
                  date: formatCalendarDay(prescription.date),
                })
              : t('prescriptions:card.title', { date: formatCalendarDay(prescription.date) })}
          </h3>
          {showPatient && prescription.patient.documentNumber !== null ? (
            <p className="text-sm text-muted-foreground">
              {t('prescriptions:card.document', {
                type: t(
                  prescription.patient.documentType === 'passport'
                    ? 'prescriptions:card.documentType.passport'
                    : 'prescriptions:card.documentType.dni',
                ),
                number: formatDocument(
                  prescription.patient.documentType === 'passport' ? 'passport' : 'dni',
                  prescription.patient.documentNumber,
                ),
              })}
            </p>
          ) : null}
        </div>
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <PrescriptionStateBadge prescription={prescription} />
          {prescription.simulated ? (
            <Badge tone="warning">{t('prescriptions:card.simulated')}</Badge>
          ) : null}
          {prescription.registeredManually ? (
            <Badge tone="neutral">{t('prescriptions:card.manual')}</Badge>
          ) : null}
        </span>
      </header>

      <ul className="grid gap-2" aria-label={t('prescriptions:card.medications')}>
        {prescription.items.map((item, index) => (
          <li key={`${item.genericName}-${String(index)}`} className="text-sm">
            <span className="font-medium">
              {t('prescriptions:card.item', {
                name: item.genericName,
                dose: item.dose,
                form: item.form,
                quantity: item.quantity,
              })}
            </span>
            <span className="block text-muted-foreground">{item.instructions}</span>
          </li>
        ))}
      </ul>

      <dl className="grid gap-1 text-sm sm:grid-cols-2">
        {prescription.externalId ? (
          <div>
            <dt className="text-muted-foreground">{t('prescriptions:card.identifier')}</dt>
            <dd className="tabular break-all">{prescription.externalId}</dd>
          </div>
        ) : null}
        {prescription.issuedAt ? (
          <div>
            <dt className="text-muted-foreground">{t('prescriptions:card.issuedAt')}</dt>
            <dd>{formatDateTime(prescription.issuedAt)}</dd>
          </div>
        ) : null}
        {coverage ? (
          <div>
            <dt className="text-muted-foreground">{t('prescriptions:card.coverage')}</dt>
            <dd>
              {coverage.planName
                ? `${coverage.payerName} - ${coverage.planName}`
                : coverage.payerName}
            </dd>
          </div>
        ) : null}
        {!actions.cancel && professionalId !== prescription.prescriber.professionalId ? (
          <div>
            <dt className="text-muted-foreground">{t('prescriptions:card.prescriber')}</dt>
            <dd>{prescription.prescriber.fullName}</dd>
          </div>
        ) : null}
      </dl>

      {state === 'pending' || state === 'attention' || state === 'refused' ? (
        <Alert tone={state === 'pending' ? 'warning' : 'danger'}>
          <AlertDescription>
            <span className="block font-medium">{t(`prescriptions:state.${state}.title`)}</span>
            <span className="block">
              {state === 'refused'
                ? t('prescriptions:state.refused.help', { message: failure?.message ?? '' })
                : t(`prescriptions:state.${state}.help`)}
            </span>
            {state === 'pending' && failure?.awaitingReconciliation ? (
              <span className="mt-1 block">{t('prescriptions:state.pending.unknown')}</span>
            ) : null}
            {state === 'pending' && failure?.nextAttemptAt ? (
              <span className="mt-1 block">
                {t('prescriptions:state.pending.next', {
                  when: formatDateTime(failure.nextAttemptAt),
                })}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {prescription.cancelReason !== null ? (
        <p className="text-sm">
          <span className="font-medium">{t('prescriptions:card.cancelReason')} </span>
          {prescription.cancelReason}
        </p>
      ) : null}

      <ErrorAlert error={retry.error ?? download.error} />

      {actions.download ||
      actions.retry ||
      actions.correct ||
      actions.register ||
      actions.cancel ? (
        <div className="flex flex-wrap gap-2">
          {actions.download ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={download.isPending}
              onClick={() => {
                download.mutate();
              }}
            >
              <Download aria-hidden="true" />
              {t('prescriptions:action.download')}
            </Button>
          ) : null}
          {actions.retry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={retry.isPending}
              onClick={() => {
                retry.mutate();
              }}
            >
              <RefreshCw aria-hidden="true" />
              {t('prescriptions:action.retry')}
            </Button>
          ) : null}
          {actions.correct ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDialog('correct');
              }}
            >
              <Pencil aria-hidden="true" />
              {t('prescriptions:action.correct')}
            </Button>
          ) : null}
          {actions.register ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDialog('register');
              }}
            >
              <FileCheck2 aria-hidden="true" />
              {t('prescriptions:action.register')}
            </Button>
          ) : null}
          {actions.cancel ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDialog('cancel');
              }}
            >
              <Undo2 aria-hidden="true" />
              {t('prescriptions:action.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog === 'cancel' ? (
        <CancelPrescriptionDialog
          prescription={prescription}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'register' ? (
        <RegisterManualDialog
          prescription={prescription}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'correct' ? (
        <IssuePrescriptionDialog
          patientId={prescription.patientId}
          correcting={prescription}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
    </article>
  );
}
