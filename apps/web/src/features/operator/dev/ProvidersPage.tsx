import type { DevProviderDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../shared/ui/tabs.js';

import { REGISTERED_TABS, type DevTab } from './tabs.js';

const OVERVIEW = 'overview';

const ADAPTER_TONE: Record<DevProviderDto['adapter'], BadgeTone> = {
  local: 'info',
  real: 'success',
  off: 'neutral',
};

/**
 * The provider console: which adapter serves customers for each external provider, and one tab per
 * simulator with its controls. It exists only on deployments that turn `LOCAL_PROVIDERS_CONSOLE` on.
 */
export function ProvidersPage({
  providers,
  tabs = REGISTERED_TABS,
}: {
  providers: readonly DevProviderDto[];
  tabs?: readonly DevTab[];
}) {
  const { t } = useTranslation('operator');

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t('providers.title')}
        description={t('providers.description')}
        className="mb-0"
      />
      <Tabs defaultValue={OVERVIEW} className="grid gap-4">
        <TabsList aria-label={t('providers.tabs')} className="justify-start">
          <TabsTrigger value={OVERVIEW}>{t('providers.overview')}</TabsTrigger>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={OVERVIEW}>
          <TableContainer aria-label={t('providers.table')}>
            <Table>
              <TableCaption>{t('providers.table')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('providers.col.provider')}</TableHead>
                  <TableHead>{t('providers.col.adapter')}</TableHead>
                  <TableHead>{t('providers.col.mode')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell className="font-medium">{provider.label}</TableCell>
                    <TableCell>
                      <Badge tone={ADAPTER_TONE[provider.adapter]}>
                        {t(`providers.adapter.${provider.adapter}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{provider.mode ?? t('providers.noMode')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </TabsContent>
        {tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id}>
            <tab.Component />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
