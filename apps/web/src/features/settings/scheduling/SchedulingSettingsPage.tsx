import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../shared/ui/tabs.js';

import { AppointmentTypesSection } from './components/AppointmentTypesSection.js';
import { BlocksSection } from './components/BlocksSection.js';
import { HolidaysSection } from './components/HolidaysSection.js';
import { OverbookingSection } from './components/OverbookingSection.js';

const SECTIONS = ['types', 'blocks', 'holidays', 'overbooking'] as const;

/** Settings > Turnos: what can be booked, when the agenda is closed, and who may be overbooked. */
export function SchedulingSettingsPage() {
  return (
    <RequirePermission anyOf={['scheduling.configure']}>
      <SchedulingSettings />
    </RequirePermission>
  );
}

function SchedulingSettings() {
  const { t } = useTranslation(['scheduling', 'settings']);
  usePageTitle(t('settings:tab.scheduling'));

  return (
    <Tabs defaultValue="types" className="grid gap-4">
      <TabsList
        aria-label={t('scheduling:config.sections')}
        className="h-auto flex-wrap justify-start"
      >
        {SECTIONS.map((section) => (
          <TabsTrigger key={section} value={section}>
            {t(`scheduling:config.tab.${section}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="types">
        <AppointmentTypesSection />
      </TabsContent>
      <TabsContent value="blocks">
        <BlocksSection />
      </TabsContent>
      <TabsContent value="holidays">
        <HolidaysSection />
      </TabsContent>
      <TabsContent value="overbooking">
        <OverbookingSection />
      </TabsContent>
    </Tabs>
  );
}
