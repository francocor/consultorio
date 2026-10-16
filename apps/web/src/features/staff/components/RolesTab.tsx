import {
  canGrantRoles,
  rolesInviterMayGrant,
  STAFF_ROLES,
  type Role,
  type StaffMemberDto,
  type StaffRole,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserRoundCheck, UserRoundX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../api/staff-api.js';

/** Roles of the person, and whether they can sign in at all (deactivate and reactivate). */
export function RolesTab({
  member,
  viewerRoles,
  isSelf,
}: {
  member: StaffMemberDto;
  viewerRoles: readonly Role[];
  isSelf: boolean;
}) {
  const { t } = useTranslation(['staff', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const offered: StaffRole[] = rolesInviterMayGrant(viewerRoles);
  const [roles, setRoles] = useState<StaffRole[]>(member.roles);
  const [confirming, setConfirming] = useState(false);
  const name = member.displayName ?? t('staff:member.noName');
  const deactivated = member.status === 'deactivated';
  // Nobody changes their own roles, and nobody edits a person above their own level.
  const locked = isSelf || !canGrantRoles(viewerRoles, member.roles);
  const refresh = () => queryClient.invalidateQueries({ queryKey: staffKeys.all });

  const save = useMutation({
    mutationFn: () =>
      staffApi(api).changeRoles(
        member.membershipId,
        STAFF_ROLES.filter((role) => roles.includes(role)),
      ),
    onSuccess: async () => {
      toast.success(t('staff:roles.saved'));
      await refresh();
    },
  });

  const status = useMutation({
    mutationFn: () =>
      deactivated
        ? staffApi(api).reactivate(member.membershipId)
        : staffApi(api).deactivate(member.membershipId),
    onSuccess: async () => {
      toast.success(deactivated ? t('staff:status.reactivated') : t('staff:status.deactivated'));
      setConfirming(false);
      await refresh();
    },
  });

  const forbidden = isApiError(save.error) && save.error.status === 403;
  const changed =
    roles.length !== member.roles.length || roles.some((role) => !member.roles.includes(role));

  return (
    <div className="grid gap-6">
      <section className="grid gap-3" aria-labelledby="roles-title">
        <div className="grid gap-1">
          <h3 id="roles-title" className="font-display text-base font-semibold">
            {t('staff:roles.title')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('staff:roles.description')}</p>
        </div>
        {save.isError ? (
          <Alert tone="danger">
            <AlertDescription>
              {forbidden ? t('staff:roles.error.forbidden') : describeError(t, save.error).message}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-2">
          {offered.map((role) => (
            <CheckboxCard
              key={role}
              checked={roles.includes(role)}
              disabled={locked || deactivated}
              onCheckedChange={(checked) => {
                setRoles((current) =>
                  checked ? [...current, role] : current.filter((entry) => entry !== role),
                );
              }}
              title={t(`staff:role.${role}`)}
              description={t(`staff:role.help.${role}`)}
            />
          ))}
        </div>
        <Button
          className="justify-self-start"
          loading={save.isPending}
          disabled={locked || deactivated || roles.length === 0 || !changed}
          onClick={() => {
            save.mutate();
          }}
        >
          {t('staff:roles.save')}
        </Button>
      </section>

      {isSelf ? null : (
        <section className="border-t pt-5">
          {deactivated ? (
            <Button
              variant="outline"
              loading={status.isPending}
              onClick={() => {
                status.mutate();
              }}
            >
              <UserRoundCheck aria-hidden="true" />
              {t('staff:status.reactivate')}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <UserRoundX aria-hidden="true" />
              {t('staff:status.deactivate')}
            </Button>
          )}
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('staff:status.deactivate.title', { name })}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('staff:status.deactivate.description')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
                <AlertDialogDestructiveAction
                  onClick={(event) => {
                    event.preventDefault();
                    status.mutate();
                  }}
                >
                  {t('staff:status.deactivate.confirm')}
                </AlertDialogDestructiveAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      )}
    </div>
  );
}
