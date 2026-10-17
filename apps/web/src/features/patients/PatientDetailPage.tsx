import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { UserRoundX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { hasAnyPermission, useMe } from '../../app/session.js';
import { useSlot } from '../../app/slots.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { cn } from '../../shared/lib/cn.js';
import { buttonVariants } from '../../shared/ui/button.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { DetailSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../shared/ui/tabs.js';
import { ChartTab } from '../clinical/components/ChartTab.js';
import { DocumentsTab } from '../documents/components/DocumentsTab.js';

import { patientKeys, patientsApi } from './api/patients-api.js';
import { AccessReportTab } from './components/AccessReportTab.js';
import { AnamnesisTab } from './components/AnamnesisTab.js';
import { CareTab } from './components/CareTab.js';
import { CoverageTab } from './components/CoverageTab.js';
import { DataTab } from './components/DataTab.js';
import { EditPatientDialog } from './components/EditPatientDialog.js';
import { HistoryTab } from './components/HistoryTab.js';
import { fullNameOf, PatientHeader } from './components/PatientHeader.js';
import { PrivacyTab } from './components/PrivacyTab.js';

/** The built-in tabs. A tab a feature registers has the id `slot:<id>`. */
type TabId =
  | 'data'
  | 'coverage'
  | 'privacy'
  | 'history'
  | 'care'
  | 'documents'
  | 'chart'
  | 'anamnesis'
  | 'access';

/** The record of one patient. The address carries the id; everything else loads from it. */
export function PatientDetailPage() {
  const params: unknown = useParams({ strict: false });
  const patientId =
    typeof params === 'object' && params !== null && 'patientId' in params
      ? String(params.patientId)
      : '';
  return <PatientRecord patientId={patientId} />;
}

function PatientRecord({ patientId }: { patientId: string }) {
  const { t } = useTranslation(['patients', 'clinical', 'common']);
  const api = useApi();
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const search: { tab?: 'chart' } = useSearch({ strict: false });
  const [tab, setTab] = useState<TabId | `slot:${string}`>(search.tab ?? 'data');
  const registeredTabs = useSlot('patient-detail-tab');

  const patient = useQuery({
    queryKey: patientKeys.detail(patientId),
    queryFn: () => patientsApi(api).get(patientId),
  });
  usePageTitle(patient.data ? fullNameOf(patient.data) : t('patients:title'));

  if (patient.isPending) return <DetailSkeleton />;
  if (patient.isError) {
    if (
      isApiError(patient.error) &&
      (patient.error.status === 404 || patient.error.status === 403)
    ) {
      return (
        <EmptyState
          icon={UserRoundX}
          title={t('patients:detail.notFound.title')}
          description={t('patients:detail.notFound.description')}
          action={
            <Link to="/patients" className={cn(buttonVariants())}>
              {t('patients:detail.back')}
            </Link>
          }
        />
      );
    }
    return (
      <ErrorState
        error={patient.error}
        onRetry={() => {
          void patient.refetch();
        }}
      />
    );
  }

  const record = patient.data;
  const canWrite = hasAnyPermission(me.permissions, ['patients.write']);
  const canAdminister = hasAnyPermission(me.permissions, ['patients.administer']);
  const canReadAnamnesis = hasAnyPermission(me.permissions, ['clinical.anamnesis.read']);
  const canReadChart = hasAnyPermission(me.permissions, ['clinical.note.read']);
  const canWriteChart = hasAnyPermission(me.permissions, ['clinical.note.write']);
  const canReadAudit = hasAnyPermission(me.permissions, ['audit.read']);
  const canReadDocuments = hasAnyPermission(me.permissions, ['patients.read']);
  const canWriteClinicalDocuments = hasAnyPermission(me.permissions, ['clinical.document.write']);
  const canReadClinicalDocuments = hasAnyPermission(me.permissions, ['clinical.document.read']);

  return (
    <div>
      <PatientHeader
        patient={record}
        canEdit={canWrite}
        canAdminister={canAdminister}
        onEdit={() => {
          setEditing(true);
        }}
      />
      <Tabs
        value={tab}
        onValueChange={(next) => {
          setTab(next as TabId | `slot:${string}`);
        }}
      >
        <TabsList aria-label={t('patients:detail.sections')}>
          <TabsTrigger value="data">{t('patients:tab.data')}</TabsTrigger>
          <TabsTrigger value="coverage">{t('patients:tab.coverage')}</TabsTrigger>
          <TabsTrigger value="privacy">{t('patients:tab.privacy')}</TabsTrigger>
          <TabsTrigger value="history">{t('patients:tab.history')}</TabsTrigger>
          <TabsTrigger value="care">{t('patients:tab.care')}</TabsTrigger>
          {canReadDocuments ? (
            <TabsTrigger value="documents">{t('patients:tab.documents')}</TabsTrigger>
          ) : null}
          {canReadChart ? <TabsTrigger value="chart">{t('clinical:tab.chart')}</TabsTrigger> : null}
          {canReadAnamnesis ? (
            <TabsTrigger value="anamnesis">{t('patients:tab.anamnesis')}</TabsTrigger>
          ) : null}
          {canReadAudit ? (
            <TabsTrigger value="access">{t('patients:tab.access')}</TabsTrigger>
          ) : null}
          {registeredTabs.map((piece) => (
            <TabsTrigger key={piece.id} value={`slot:${piece.id}`}>
              {t(piece.labelKey ?? '')}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="data">
          <DataTab patient={record} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="coverage">
          <CoverageTab patientId={record.id} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="privacy">
          <PrivacyTab patient={record} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab patientId={record.id} />
        </TabsContent>
        <TabsContent value="care">
          <CareTab patientId={record.id} canAssign={canAdminister} />
        </TabsContent>
        {canReadDocuments ? (
          <TabsContent value="documents">
            <DocumentsTab
              patientId={record.id}
              canWrite={canWrite}
              canWriteClinical={canWriteClinicalDocuments}
              canReadClinical={canReadClinicalDocuments}
            />
          </TabsContent>
        ) : null}
        {canReadChart ? (
          <TabsContent value="chart">
            <ChartTab
              patientId={record.id}
              canWrite={canWriteChart}
              onOpenAnamnesis={() => {
                setTab('anamnesis');
              }}
            />
          </TabsContent>
        ) : null}
        {canReadAnamnesis ? (
          <TabsContent value="anamnesis">
            <AnamnesisTab patientId={record.id} />
          </TabsContent>
        ) : null}
        {canReadAudit ? (
          <TabsContent value="access">
            <AccessReportTab patientId={record.id} />
          </TabsContent>
        ) : null}
        {registeredTabs.map((piece) => (
          <TabsContent key={piece.id} value={`slot:${piece.id}`}>
            <piece.Component patientId={record.id} />
          </TabsContent>
        ))}
      </Tabs>
      {canWrite ? (
        <EditPatientDialog patient={record} open={editing} onOpenChange={setEditing} />
      ) : null}
    </div>
  );
}
