import type { PortalConsentDto, PortalLinkDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ClipboardSignature } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate } from '../../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { QueryState } from '../components/QueryState.js';

const CONSENT_TONES: Record<PortalConsentDto['status'], BadgeTone> = {
  pending: 'warning',
  signed: 'success',
  revoked: 'neutral',
  expired: 'neutral',
  declined: 'neutral',
};

/** The consents the consultorio asked the patient to sign, and the ones they signed. */
export function ConsentsSection({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'consents'),
    queryFn: () => api.consents(),
  });
  return (
    <section>
      <PageHeader title={t('consents.title')} description={t('consents.description')} />
      <QueryState
        query={query}
        isEmpty={(data) => data.consents.length === 0}
        empty={
          <EmptyState
            icon={ClipboardSignature}
            title={t('consents.empty.title')}
            description={t('consents.empty.description')}
          />
        }
      >
        {(data) => (
          <ul className="grid gap-3">
            {data.consents.map((consent) => (
              <li
                key={consent.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
              >
                <div className="grid min-w-0 gap-1">
                  <p className="break-words font-medium">{consent.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {consent.signedAt
                      ? t('consents.signedOn', { date: formatDate(consent.signedAt) })
                      : t('consents.requestedOn', { date: formatDate(consent.requestedAt) })}
                  </p>
                  <Badge tone={CONSENT_TONES[consent.status]} className="justify-self-start">
                    {t(`consents.status.${consent.status}`)}
                  </Badge>
                </div>
                <Button asChild variant={consent.canSign ? 'default' : 'outline'} size="sm">
                  <Link to="/portal/consentimientos/$id" params={{ id: consent.id }}>
                    {consent.canSign ? t('consents.read') : t('consents.view')}
                    <span className="sr-only">{consent.title}</span>
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
