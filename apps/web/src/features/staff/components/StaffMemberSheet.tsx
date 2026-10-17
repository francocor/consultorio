import type { Role, StaffMemberDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../shared/ui/sheet.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../shared/ui/tabs.js';

import { LocationsTab } from './LocationsTab.js';
import { PermissionsTab } from './PermissionsTab.js';
import { ProfileTab } from './ProfileTab.js';
import { RolesTab } from './RolesTab.js';

/** Everything that can be changed about one person, in four tabs inside a side sheet. */
export function StaffMemberSheet({
  member,
  team,
  viewerRoles,
  isSelf,
  onClose,
}: {
  member: StaffMemberDto | null;
  team: readonly StaffMemberDto[];
  viewerRoles: readonly Role[];
  isSelf: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('staff');
  const professionals = team.flatMap((person) =>
    person.professional?.status === 'active'
      ? [{ id: person.professional.id, name: person.displayName ?? t('member.noName') }]
      : [],
  );

  return (
    <Sheet
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:w-[36rem] sm:max-w-[36rem]">
        {member ? (
          <>
            <div className="grid gap-1 pr-6">
              <SheetTitle>{member.displayName ?? t('member.noName')}</SheetTitle>
              <SheetDescription>{t('sheet.description')}</SheetDescription>
            </div>
            <Tabs defaultValue="summary">
              <TabsList aria-label={member.displayName ?? t('member.noName')}>
                <TabsTrigger value="summary">{t('tab.summary')}</TabsTrigger>
                <TabsTrigger value="profile">{t('tab.profile')}</TabsTrigger>
                <TabsTrigger value="permissions">{t('tab.permissions')}</TabsTrigger>
                <TabsTrigger value="locations">{t('tab.locations')}</TabsTrigger>
              </TabsList>
              <TabsContent value="summary">
                <RolesTab member={member} viewerRoles={viewerRoles} isSelf={isSelf} />
              </TabsContent>
              <TabsContent value="profile">
                <ProfileTab member={member} viewerRoles={viewerRoles} isSelf={isSelf} />
              </TabsContent>
              <TabsContent value="permissions">
                <PermissionsTab member={member} professionals={professionals} />
              </TabsContent>
              <TabsContent value="locations">
                <LocationsTab member={member} />
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
