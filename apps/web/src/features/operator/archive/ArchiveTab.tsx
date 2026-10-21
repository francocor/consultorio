import type {
  ArchiveOverviewDto,
  ArchiveReleaseRequestDto,
  ArchiveReleaseStatus,
  OperatorTenantDto,
} from '@consultorio/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { StatusBadge, type Status } from '../../../shared/ui/states/status-badge.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';
import { operatorApi, operatorKeys } from '../api/operator-api.js';

import { archiveApi, archiveKeys } from './archive-api.js';
import { RecordReleaseDialog } from './RecordReleaseDialog.js';
import { RejectDialog, VerifyIdentityDialog } from './ReleaseDialogs.js';

/** Megabytes with one decimal, or kilobytes when it is small: a size a person can read. */
function sizeText(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

const REQUEST_TONES: Record<ArchiveReleaseStatus, Status> = {
  requested: 'pending',
  identity_verified: 'pending',
  approved: 'warning',
  released: 'ok',
  rejected: 'inactive',
  expired: 'inactive',
  failed: 'error',
};

type Pending =
  | { kind: 'verify'; request: ArchiveReleaseRequestDto }
  | { kind: 'reject'; request: ArchiveReleaseRequestDto }
  | { kind: 'record' };

/**
 * The archive of the cancelled organizations, for the platform operator (tenancy, "Retention archive
 * after cancellation" and the break-glass release). Two lists: the state of each archive (counts and
 * dates) and the requests to release records to a patient or a verified professional. The operator
 * records a request, verifies the identity of the requester out of band and ticks the checklist; a
 * DIFFERENT operator approves. Nothing on this screen is a record, a key or the name of an object: the
 * operator never reads the archive.
 */
export function ArchiveTab() {
  const { t } = useTranslation(['export', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<unknown>(null);

  const archives = useQuery({
    queryKey: archiveKeys.archives,
    queryFn: () => archiveApi(api).archives(),
  });
  const requests = useQuery({
    queryKey: archiveKeys.requests,
    queryFn: () => archiveApi(api).requests(),
  });
  const tenants = useQuery({
    queryKey: operatorKeys.tenants,
    queryFn: () => operatorApi(api).tenants(),
  });
  const nameOf = (organization: string): string =>
    tenants.data?.find((entry: OperatorTenantDto) => entry.id === organization)?.name ??
    t('export:operator.unnamed');
  const cancelled = (tenants.data ?? []).filter((entry) => entry.status === 'cancelled');
  const close = () => {
    setPending(null);
  };

  const approve = async (request: ArchiveReleaseRequestDto) => {
    setApproving(request.id);
    setApproveError(null);
    try {
      await archiveApi(api).approve(request.id);
      await queryClient.invalidateQueries({ queryKey: archiveKeys.requests });
    } catch (error) {
      setApproveError(error);
    } finally {
      setApproving(null);
    }
  };

  return (
    <div className="grid gap-8">
      <PageHeader
        title={t('export:operator.title')}
        description={t('export:operator.description')}
      />

      <section className="grid gap-3">
        <h2 className="font-display text-lg font-semibold">
          {t('export:operator.archives.title')}
        </h2>
        {archives.isPending ? (
          <ListSkeleton rows={3} />
        ) : archives.isError ? (
          <ErrorState
            error={archives.error}
            onRetry={() => {
              void archives.refetch();
            }}
          />
        ) : archives.data.length === 0 ? (
          <EmptyState
            icon={Archive}
            title={t('export:operator.archives.empty.title')}
            description={t('export:operator.archives.empty.description')}
          />
        ) : (
          <TableContainer aria-label={t('export:operator.archives.title')}>
            <Table>
              <TableCaption>{t('export:operator.archives.title')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('export:operator.archives.col.organization')}</TableHead>
                  <TableHead>{t('export:operator.archives.col.status')}</TableHead>
                  <TableHead>{t('export:operator.archives.col.archivedAt')}</TableHead>
                  <TableHead>{t('export:operator.archives.col.objects')}</TableHead>
                  <TableHead>{t('export:operator.archives.col.size')}</TableHead>
                  <TableHead>{t('export:operator.archives.col.retainUntil')}</TableHead>
                  <TableHead>{t('export:operator.archives.col.verified')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {archives.data.map((entry: ArchiveOverviewDto) => (
                  <TableRow key={entry.organization}>
                    <TableCell className="font-medium">{nameOf(entry.organization)}</TableCell>
                    <TableCell>
                      <StatusBadge
                        status={
                          entry.status === 'written'
                            ? 'ok'
                            : entry.status === 'failed'
                              ? 'error'
                              : 'pending'
                        }
                      >
                        {t(`export:operator.archives.status.${entry.status}`)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(entry.archivedAt)}
                    </TableCell>
                    <TableCell className="tabular">{entry.objects ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{sizeText(entry.bytes)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(entry.retainUntil)}
                    </TableCell>
                    <TableCell>
                      {entry.verifyStatus === null ? (
                        <span className="text-muted-foreground">
                          {t('export:operator.archives.verify.never')}
                        </span>
                      ) : (
                        <div className="grid gap-1">
                          <StatusBadge status={entry.verifyStatus === 'ok' ? 'ok' : 'error'}>
                            {t(`export:operator.archives.verify.${entry.verifyStatus}`)}
                          </StatusBadge>
                          <span className="text-xs text-muted-foreground">
                            {formatDate(entry.verifiedAt)}
                          </span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="font-display text-lg font-semibold">
              {t('export:operator.requests.title')}
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('export:operator.requests.description')}
            </p>
          </div>
          <Button
            onClick={() => {
              setPending({ kind: 'record' });
            }}
          >
            <Plus aria-hidden="true" />
            {t('export:operator.requests.new')}
          </Button>
        </div>
        {approveError === null ? null : (
          <p role="alert" className="text-sm text-danger-soft-foreground">
            {t('export:operator.requests.approveFailed')}
          </p>
        )}
        {requests.isPending ? (
          <ListSkeleton rows={3} />
        ) : requests.isError ? (
          <ErrorState
            error={requests.error}
            onRetry={() => {
              void requests.refetch();
            }}
          />
        ) : requests.data.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t('export:operator.requests.empty.title')}
            description={t('export:operator.requests.empty.description')}
          />
        ) : (
          <TableContainer aria-label={t('export:operator.requests.title')}>
            <Table>
              <TableCaption>{t('export:operator.requests.title')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('export:operator.requests.col.requester')}</TableHead>
                  <TableHead>{t('export:operator.requests.col.scope')}</TableHead>
                  <TableHead>{t('export:operator.requests.col.organization')}</TableHead>
                  <TableHead>{t('export:operator.requests.col.status')}</TableHead>
                  <TableHead>{t('export:operator.requests.col.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.data.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="max-w-64 break-words whitespace-normal">
                      <div className="grid gap-0.5">
                        <span className="font-medium">{request.requesterName}</span>
                        <span className="text-xs text-muted-foreground">
                          {request.requesterEmail}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`export:operator.requests.kind.${request.requesterKind}`)}
                        </span>
                        <span className="text-xs">{request.reason}</span>
                      </div>
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap">{request.scope}</TableCell>
                    <TableCell>{nameOf(request.organization)}</TableCell>
                    <TableCell>
                      <div className="grid gap-1">
                        <StatusBadge status={REQUEST_TONES[request.status]}>
                          {t(`export:operator.requests.status.${request.status}`)}
                        </StatusBadge>
                        {request.status === 'approved' && request.expiresAt ? (
                          <span className="text-xs text-muted-foreground">
                            {t('export:operator.requests.until', {
                              date: formatDate(request.expiresAt),
                            })}
                          </span>
                        ) : null}
                        {request.status === 'released' && request.linkExpiresAt ? (
                          <span className="text-xs text-muted-foreground">
                            {request.downloadedAt
                              ? t('export:operator.requests.downloaded', {
                                  date: formatDate(request.downloadedAt),
                                })
                              : t('export:operator.requests.linkUntil', {
                                  date: formatDate(request.linkExpiresAt),
                                })}
                          </span>
                        ) : null}
                        {request.status === 'rejected' && request.rejectedReason ? (
                          <span className="text-xs text-muted-foreground">
                            {request.rejectedReason}
                          </span>
                        ) : null}
                        {request.status === 'failed' ? (
                          <span className="text-xs text-muted-foreground">
                            {t('export:operator.requests.failedWith', {
                              code: request.failureCode ?? '',
                            })}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {request.canVerifyIdentity ? (
                          <Button
                            size="sm"
                            aria-label={t('export:operator.requests.verifyNamed', {
                              name: request.requesterName,
                            })}
                            onClick={() => {
                              setPending({ kind: 'verify', request });
                            }}
                          >
                            {t('export:operator.requests.verify')}
                          </Button>
                        ) : null}
                        {request.status === 'identity_verified' ? (
                          request.canApprove ? (
                            <Button
                              size="sm"
                              loading={approving === request.id}
                              aria-label={t('export:operator.requests.approveNamed', {
                                name: request.requesterName,
                              })}
                              onClick={() => {
                                void approve(request);
                              }}
                            >
                              {t('export:operator.requests.approve')}
                            </Button>
                          ) : (
                            <span className="max-w-48 text-xs text-muted-foreground">
                              {t('export:operator.requests.anotherApproves')}
                            </span>
                          )
                        ) : null}
                        {request.canReject ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('export:operator.requests.rejectNamed', {
                              name: request.requesterName,
                            })}
                            onClick={() => {
                              setPending({ kind: 'reject', request });
                            }}
                          >
                            {t('export:operator.requests.reject')}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      {pending?.kind === 'record' ? (
        <RecordReleaseDialog organizations={cancelled} onClose={close} />
      ) : null}
      {pending?.kind === 'verify' ? (
        <VerifyIdentityDialog request={pending.request} onClose={close} />
      ) : null}
      {pending?.kind === 'reject' ? (
        <RejectDialog request={pending.request} onClose={close} />
      ) : null}
    </div>
  );
}
