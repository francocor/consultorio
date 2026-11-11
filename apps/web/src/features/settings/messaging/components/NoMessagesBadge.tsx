import { useQuery } from '@tanstack/react-query';
import { BellOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { Badge } from '../../../../shared/ui/badge.js';
import { messagingApi, messagingKeys } from '../api/messaging-api.js';

/**
 * "Sin avisos" in the header of the patient record (owner decision B7): the patient opted out and
 * no channel is open again, so nothing the organization sends can reach them. It is mounted in the
 * `patient-header` slot and reads the same query as the channels tab, so opening the tab costs no
 * second request. While it loads, or if it fails, it shows nothing: the tab reports the error.
 */
export function NoMessagesBadge({ patientId }: { patientId: string }) {
  const { t } = useTranslation('messaging');
  const api = useApi();
  const channels = useQuery({
    queryKey: messagingKeys.channels(patientId),
    queryFn: () => messagingApi(api).channels(patientId),
  });
  if (!channels.data?.noMessages) return null;
  return (
    <Badge tone="danger">
      <BellOff className="size-3" aria-hidden="true" />
      {t('channels.noMessages.badge')}
    </Badge>
  );
}
