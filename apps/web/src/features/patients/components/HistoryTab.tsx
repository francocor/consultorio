import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { Section } from './Section.js';

/** Every change of the personal data keeps the previous value: this is the trail of versions. */
export function HistoryTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation('patients');
  const api = useApi();
  const history = useQuery({
    queryKey: patientKeys.history(patientId),
    queryFn: () => patientsApi(api).history(patientId),
  });

  if (history.isPending) return <ListSkeleton rows={3} />;
  if (history.isError) {
    return (
      <ErrorState
        error={history.error}
        onRetry={() => {
          void history.refetch();
        }}
      />
    );
  }
  if (history.data.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('history.title')}
        description={t('history.description')}
      />
    );
  }

  return (
    <Section title={t('history.title')} description={t('history.description')}>
      <ol className="grid gap-3">
        {history.data.map((version) => (
          <li key={version.version} className="grid gap-0.5 rounded-md border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {t('history.version', { version: version.version })}
              </span>
              <span className="tabular text-sm text-muted-foreground">
                {formatDateTime(version.changedAt)}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {version.changedFields.length === 0
                ? t('history.created')
                : t('history.changed', {
                    fields: version.changedFields
                      .map((field) => t(`history.field.${field}`, { defaultValue: field }))
                      .join(', '),
                  })}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
