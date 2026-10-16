import type { OperatorTenantDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, MailPlus, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { formatDate } from '../../shared/lib/format.js';
import { describeError } from '../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../shared/ui/alert-dialog.js';
import { Badge } from '../../shared/ui/badge.js';
import { Button } from '../../shared/ui/button.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { StatusBadge, type Status } from '../../shared/ui/states/status-badge.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shared/ui/table.js';
import { toast } from '../../shared/ui/toaster.js';

import { operatorApi, operatorKeys } from './api/operator-api.js';
import { CreateTenantDialog } from './CreateTenantDialog.js';
import { ResendInvitationDialog } from './ResendInvitationDialog.js';

const STATUS: Record<OperatorTenantDto['status'], Status> = {
  active: 'active',
  read_only: 'warning',
  cancelled: 'inactive',
};

/** The organizations of the platform: create one, resend an owner's invitation, reset a demo. */
export function TenantsPanel() {
  const { t } = useTranslation('operator');
  const api = useApi();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [resending, setResending] = useState<OperatorTenantDto | null>(null);
  const [resetting, setResetting] = useState<OperatorTenantDto | null>(null);

  const tenants = useQuery({
    queryKey: operatorKeys.tenants,
    queryFn: () => operatorApi(api).tenants(),
  });

  const reset = useMutation({
    mutationFn: (tenant: OperatorTenantDto) => operatorApi(api).demoReset(tenant.id),
    onSuccess: async () => {
      setResetting(null);
      toast.success(t('reset.done'));
      await queryClient.invalidateQueries({ queryKey: operatorKeys.tenants });
    },
    onError: (error) => {
      setResetting(null);
      toast.error(describeError(t, error).message);
    },
  });

  const createButton = (
    <Button
      onClick={() => {
        setCreating(true);
      }}
    >
      <Plus aria-hidden="true" />
      {t('tenants.create')}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
        actions={tenants.data && tenants.data.length > 0 ? createButton : null}
      />

      {tenants.isPending ? (
        <ListSkeleton rows={4} />
      ) : tenants.isError ? (
        <ErrorState
          error={tenants.error}
          onRetry={() => {
            void tenants.refetch();
          }}
        />
      ) : tenants.data.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t('tenants.empty.title')}
          description={t('tenants.empty.description')}
          action={createButton}
        />
      ) : (
        <TableContainer aria-label={t('tenants.title')}>
          <Table>
            <TableCaption>{t('tenants.title')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('tenants.col.name')}</TableHead>
                <TableHead>{t('tenants.col.address')}</TableHead>
                <TableHead>{t('tenants.col.status')}</TableHead>
                <TableHead>{t('tenants.col.created')}</TableHead>
                <TableHead>{t('tenants.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.data.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{tenant.name}</span>
                      {tenant.isDemo ? <Badge tone="info">{t('tenants.demo')}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">{tenant.slug}</TableCell>
                  <TableCell>
                    <StatusBadge status={STATUS[tenant.status]}>
                      {t(`status.${tenant.status}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {formatDate(tenant.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('resend.action', { name: tenant.name })}
                        onClick={() => {
                          setResending(tenant);
                        }}
                      >
                        <MailPlus aria-hidden="true" />
                      </Button>
                      {tenant.isDemo ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('reset.action', { name: tenant.name })}
                          onClick={() => {
                            setResetting(tenant);
                          }}
                        >
                          <RotateCcw aria-hidden="true" />
                        </Button>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <CreateTenantDialog open={creating} onOpenChange={setCreating} />
      <ResendInvitationDialog
        tenant={resending}
        onClose={() => {
          setResending(null);
        }}
      />
      <AlertDialog
        open={resetting !== null}
        onOpenChange={(open) => {
          if (!open) setResetting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('reset.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('reset.description', { name: resetting?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel', { ns: 'common' })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (resetting) reset.mutate(resetting);
              }}
            >
              {t('reset.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
