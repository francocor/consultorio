import { useQuery } from '@tanstack/react-query';
import { UserPlus, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { Button } from '../../shared/ui/button.js';
import { Switch } from '../../shared/ui/checkbox.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { staffApi, staffKeys } from './api/staff-api.js';
import { InviteStaffDialog } from './components/InviteStaffDialog.js';
import { StaffMemberCard } from './components/StaffMemberCard.js';
import { StaffMemberSheet } from './components/StaffMemberSheet.js';

/** The team: who is in it, what they can do and where. Owner and admin only. */
export function StaffPage() {
  const { t } = useTranslation(['staff', 'common']);
  usePageTitle(t('staff:title'));
  const api = useApi();
  const me = useMe();
  const [includeDeactivated, setIncludeDeactivated] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const staff = useQuery({
    queryKey: staffKeys.list(includeDeactivated),
    queryFn: () => staffApi(api).list(includeDeactivated),
  });

  const members = staff.data ?? [];
  const selected = members.find((member) => member.membershipId === selectedId) ?? null;
  const isSelf = (email: string | null) =>
    email !== null && email.toLowerCase() === me.user.email.toLowerCase();

  const inviteButton = (
    <Button
      onClick={() => {
        setInviting(true);
      }}
    >
      <UserPlus aria-hidden="true" />
      {t('staff:invite.action')}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title={t('staff:title')}
        description={t('staff:description')}
        actions={inviteButton}
      />

      {staff.isPending ? (
        <ListSkeleton rows={4} />
      ) : staff.isError ? (
        <ErrorState
          error={staff.error}
          onRetry={() => {
            void staff.refetch();
          }}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('staff:count', { count: members.length })}
            </p>
            <div className="flex items-center gap-2">
              <Switch
                id="include-deactivated"
                checked={includeDeactivated}
                onCheckedChange={setIncludeDeactivated}
              />
              <Label htmlFor="include-deactivated">{t('staff:showDeactivated')}</Label>
            </div>
          </div>
          {members.length === 0 ? (
            <EmptyState
              icon={UsersRound}
              title={t('staff:empty.title')}
              description={t('staff:empty.description')}
              action={inviteButton}
            />
          ) : (
            <ul className="grid gap-4 lg:grid-cols-2">
              {members.map((member) => (
                <StaffMemberCard
                  key={member.membershipId}
                  member={member}
                  isSelf={isSelf(member.email)}
                  onManage={() => {
                    setSelectedId(member.membershipId);
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <InviteStaffDialog open={inviting} onOpenChange={setInviting} inviterRoles={me.roles} />
      <StaffMemberSheet
        member={selected}
        team={members}
        viewerRoles={me.roles}
        isSelf={selected ? isSelf(selected.email) : false}
        onClose={() => {
          setSelectedId(null);
        }}
      />
    </div>
  );
}
