import type { ConsentListItemDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSignature } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi, useAppStatus } from '../../app/providers.js';
import { hasAnyPermission, useMe } from '../../app/session.js';
import { formatDateTime } from '../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { consentApi, consentKeys } from './api/consent-api.js';
import { ConsentStatusBadge } from './components/ConsentStatusBadge.js';
import { ErrorAlert } from './components/ErrorAlert.js';
import { RequestConsentDialog } from './components/RequestConsentDialog.js';
import { RevokeDialog } from './components/RevokeDialog.js';
import { SignedRecordDialog } from './components/SignedRecordDialog.js';
import { SigningDialog } from './components/SigningDialog.js';

type Dialogue =
  | { kind: 'request' }
  | { kind: 'sign'; requestId: string }
  | { kind: 'revoke'; requestId: string }
  | { kind: 'record'; requestId: string };

/** The line that says when, in the words of the state. */
function whenOf(item: ConsentListItemDto): { key: string; date: string } {
  if (item.status === 'revoked' && item.revokedAt) {
    return { key: 'item.revokedAt', date: item.revokedAt };
  }
  if (item.status === 'signed' && item.signedAt) {
    return { key: 'item.signedAt', date: item.signedAt };
  }
  if (item.status === 'declined' && item.closedAt) {
    return { key: 'item.declinedAt', date: item.closedAt };
  }
  if (item.status === 'expired') {
    return { key: 'item.expiredAt', date: item.closedAt ?? item.expiresAt };
  }
  return { key: 'item.expiresAt', date: item.expiresAt };
}

/**
 * The consents of a patient, as a tab of the patient record (informed-consent, "Visibility and
 * access control"). Everything shown here comes from the server already decided by role: a title
 * only for who may see it, and under the neutral label ("Consentimiento") for everyone else, with
 * the status and the dates. Asking, signing on this device, recording a revocation and declining
 * are for who holds `consent.request`; opening the signed record is for who the server says can.
 */
export function PatientConsentsTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation(['consent', 'common']);
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Dialogue | null>(null);
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const mayRequest = hasAnyPermission(me.permissions, ['consent.request']);

  const list = useQuery({
    queryKey: consentKeys.patient(patientId),
    queryFn: () => consentApi(api).ofPatient(patientId),
  });

  const decline = useMutation({
    mutationFn: (requestId: string) => consentApi(api).decline(requestId),
    onSuccess: async () => {
      toast.success(t('consent:decline.done'));
      await queryClient.invalidateQueries({ queryKey: consentKeys.patient(patientId) });
    },
  });

  if (list.isPending) return <ListSkeleton rows={3} />;
  if (list.isError) {
    return (
      <ErrorState
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }

  const consents = list.data.consents;
  const requestButton = mayRequest ? (
    <Button
      type="button"
      disabled={readOnly}
      onClick={() => {
        setOpen({ kind: 'request' });
      }}
    >
      {t('consent:tab.request')}
    </Button>
  ) : null;

  return (
    <div className="grid gap-4">
      {readOnly && mayRequest ? (
        <Alert tone="info">
          <AlertDescription>{t('consent:tab.readOnly')}</AlertDescription>
        </Alert>
      ) : null}
      {consents.length === 0 ? (
        <EmptyState
          icon={FileSignature}
          title={t('consent:tab.empty.title')}
          description={t('consent:tab.empty.description')}
          action={requestButton}
        />
      ) : (
        <>
          {requestButton ? <div className="flex justify-end">{requestButton}</div> : null}
          <ul aria-label={t('consent:tab.listLabel')} className="grid gap-2">
            {consents.map((item) => {
              const when = whenOf(item);
              const name = item.title ?? t('consent:neutralLabel');
              return (
                <li
                  key={item.id}
                  className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-[1fr_auto]"
                >
                  <div className="min-w-0 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>{name}</span>
                      {item.versionNumber === null ? null : (
                        <span className="text-xs font-normal text-muted-foreground">
                          {t('consent:signing.version', { number: item.versionNumber })}
                        </span>
                      )}
                      <ConsentStatusBadge status={item.status} />
                    </p>
                    <p className="text-muted-foreground">
                      {t('consent:item.requestedAt', { date: formatDateTime(item.createdAt) })} ·{' '}
                      {t(`consent:${when.key}`, { date: formatDateTime(when.date) })} ·{' '}
                      {t(`consent:method.${item.method}`)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                    {item.status === 'pending' && item.method === 'in_person' && mayRequest ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={readOnly}
                          onClick={() => {
                            setOpen({ kind: 'sign', requestId: item.id });
                          }}
                        >
                          {t('consent:item.sign')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={readOnly}
                          loading={decline.isPending && decline.variables === item.id}
                          onClick={() => {
                            decline.mutate(item.id);
                          }}
                        >
                          {t('consent:item.decline')}
                        </Button>
                      </>
                    ) : null}
                    {item.canOpen ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setOpen({ kind: 'record', requestId: item.id });
                        }}
                      >
                        {t('consent:item.open')}
                      </Button>
                    ) : null}
                    {item.status === 'signed' && mayRequest ? (
                      // Withdrawing a consent protects the patient: it works in a read-only organization.
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setOpen({ kind: 'revoke', requestId: item.id });
                        }}
                      >
                        {t('consent:item.revoke')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ErrorAlert error={decline.error} />

      {open?.kind === 'request' ? (
        <RequestConsentDialog
          patientId={patientId}
          onClose={() => {
            setOpen(null);
          }}
          onRequested={(request) => {
            setOpen({ kind: 'sign', requestId: request.id });
          }}
        />
      ) : null}
      {open?.kind === 'sign' ? (
        <SigningDialog
          requestId={open.requestId}
          patientId={patientId}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open?.kind === 'revoke' ? (
        <RevokeDialog
          requestId={open.requestId}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open?.kind === 'record' ? (
        <SignedRecordDialog
          requestId={open.requestId}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}
