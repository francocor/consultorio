import { GRANTABLE, type StaffMemberDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import { Switch } from '../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../api/staff-api.js';

const DELEGATED = 'scheduling.delegated_calendar';

/**
 * The extra permissions an owner or admin can hand out, one switch each. Clinical permissions are
 * not here and cannot be: the server only lists what is grantable, and refuses anything else.
 */
export function PermissionsTab({
  member,
  professionals,
}: {
  member: StaffMemberDto;
  /** Active professionals, for the delegated calendar. */
  professionals: { id: string; name: string }[];
}) {
  const { t } = useTranslation(['staff', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);

  const grants = useQuery({
    queryKey: staffKeys.grants(member.membershipId),
    queryFn: () => staffApi(api).grants(member.membershipId),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: staffKeys.grants(member.membershipId) });

  const toggle = useMutation({
    mutationFn: async (input: { permission: string; on: boolean; professionalIds?: string[] }) => {
      if (!input.on) {
        await staffApi(api).revoke(member.membershipId, input.permission);
        return;
      }
      await staffApi(api).grant(
        member.membershipId,
        input.permission,
        input.professionalIds ? { professionalIds: input.professionalIds } : undefined,
      );
    },
    onSuccess: async (_result, input) => {
      toast.success(input.on ? t('staff:permissions.granted') : t('staff:permissions.revoked'));
      setPicking(false);
      setChosen([]);
      await refresh();
    },
  });

  if (grants.isPending) return <FormSkeleton fields={3} />;
  if (grants.isError) {
    return (
      <ErrorState
        error={grants.error}
        onRetry={() => {
          void grants.refetch();
        }}
      />
    );
  }

  const active = new Set<string>(grants.data.grants.map((grant) => grant.permission));
  // Only what the server says is grantable, and only what this build knows how to describe.
  const offered = grants.data.grantable.filter((permission) => GRANTABLE.includes(permission));

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="font-display text-base font-semibold">{t('staff:permissions.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('staff:permissions.description')}</p>
      </div>
      {toggle.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, toggle.error).message}</AlertDescription>
        </Alert>
      ) : null}
      {offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('staff:permissions.none')}</p>
      ) : (
        <ul className="grid gap-2">
          {offered.map((permission) => {
            const on = active.has(permission);
            const titleId = `permission-${permission}`;
            return (
              <li
                key={permission}
                className="flex items-start justify-between gap-4 rounded-md border p-3"
              >
                <div className="grid gap-0.5 text-sm">
                  <p id={titleId} className="font-medium">
                    {t(`staff:permission.${permission}.title`)}
                  </p>
                  <p className="text-muted-foreground">
                    {t(`staff:permission.${permission}.description`)}
                  </p>
                </div>
                <Switch
                  checked={on}
                  aria-labelledby={titleId}
                  disabled={toggle.isPending}
                  onCheckedChange={(next) => {
                    if (next && permission === DELEGATED) setPicking(true);
                    else toggle.mutate({ permission, on: next });
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
          if (!open) setChosen([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('staff:permissions.delegatedPick')}</DialogTitle>
            <DialogDescription>{t(`staff:permission.${DELEGATED}.description`)}</DialogDescription>
          </DialogHeader>
          {professionals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('staff:permissions.delegatedNone')}</p>
          ) : (
            <ul className="grid gap-2">
              {professionals.map((professional) => (
                <li key={professional.id}>
                  <CheckboxCard
                    checked={chosen.includes(professional.id)}
                    onCheckedChange={(checked) => {
                      setChosen((current) =>
                        checked
                          ? [...current, professional.id]
                          : current.filter((id) => id !== professional.id),
                      );
                    }}
                    title={professional.name}
                  />
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPicking(false);
              }}
            >
              {t('common:action.cancel')}
            </Button>
            <Button
              loading={toggle.isPending}
              disabled={chosen.length === 0}
              onClick={() => {
                toggle.mutate({ permission: DELEGATED, on: true, professionalIds: chosen });
              }}
            >
              {t('staff:permissions.delegatedConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
