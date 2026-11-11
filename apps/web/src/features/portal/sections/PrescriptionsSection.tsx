import type { PortalLinkDto, PortalPrescriptionDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Pill } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate } from '../../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { DownloadButton } from '../components/DownloadButton.js';
import { QueryState } from '../components/QueryState.js';

const TONES: Record<string, BadgeTone> = {
  issued: 'success',
  dispensed: 'neutral',
  expired: 'neutral',
  cancelled: 'danger',
  pending_submission: 'warning',
  draft: 'neutral',
};

/**
 * The prescriptions issued to the patient: that they exist, when, from whom and where they stand.
 * The medications are in the document, which is downloaded. While no prescription module serves the
 * portal the section is an empty state. The list comes in pages: the first one with the section, and
 * the next ones when the patient asks for them (JD-S5 R2, B-S5).
 */
export function PrescriptionsSection({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'prescriptions'),
    queryFn: () => api.prescriptions(),
  });
  // The pages after the first, and where the next one starts (undefined: only the first was read).
  const [more, setMore] = useState<{
    items: PortalPrescriptionDto[];
    cursor: string | null | undefined;
    failed: boolean;
  }>({ items: [], cursor: undefined, failed: false });
  const nextCursor = more.cursor === undefined ? (query.data?.nextCursor ?? null) : more.cursor;
  const loadMore = async () => {
    if (nextCursor === null) return;
    try {
      const page = await api.prescriptions(nextCursor);
      setMore((current) => ({
        items: [...current.items, ...page.prescriptions],
        cursor: page.nextCursor,
        failed: false,
      }));
    } catch {
      setMore((current) => ({ ...current, failed: true }));
    }
  };
  return (
    <section>
      <PageHeader title={t('prescriptions.title')} description={t('prescriptions.description')} />
      <QueryState
        query={query}
        isEmpty={(data) => data.prescriptions.length === 0}
        empty={
          <EmptyState
            icon={Pill}
            title={t('prescriptions.empty.title')}
            description={t('prescriptions.empty.description')}
          />
        }
      >
        {(data) => (
          <>
            <ul className="grid gap-3">
              {[...data.prescriptions, ...more.items].map((prescription) => {
                const issued = prescription.issuedAt
                  ? t('prescriptions.issuedOn', { date: formatDate(prescription.issuedAt) })
                  : t('prescriptions.notIssued');
                return (
                  <li
                    key={prescription.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
                  >
                    <div className="grid min-w-0 gap-1">
                      <p className="font-medium">{issued}</p>
                      <p className="text-sm text-muted-foreground">
                        {prescription.prescriberName
                          ? t('prescriptions.by', { name: prescription.prescriberName })
                          : t('prescriptions.byUnknown')}
                      </p>
                      <Badge
                        tone={TONES[prescription.status] ?? 'neutral'}
                        className="justify-self-start"
                      >
                        {t(`prescriptions.status.${prescription.status}`)}
                      </Badge>
                    </div>
                    {prescription.hasDocument ? (
                      <DownloadButton
                        kind="prescriptions"
                        id={prescription.id}
                        fileName="receta.pdf"
                        label={t('prescriptions.downloadLabel', { when: issued })}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {nextCursor === null ? null : (
              <div className="mt-4 grid justify-items-start gap-2">
                <Button type="button" variant="outline" onClick={() => void loadMore()}>
                  {t('prescriptions.more')}
                </Button>
                {more.failed ? (
                  <p role="alert" className="text-sm text-destructive">
                    {t('prescriptions.moreFailed')}
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}
