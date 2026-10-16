import type { AuditEventDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';
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

/** A label from the catalog when there is one, the raw value when the server knows more than we do. */
function useLabel() {
  const { t, i18n } = useTranslation(['audit', 'shell']);
  return (key: string, raw: string) => (i18n.exists(key) ? t(key) : raw);
}

/**
 * The events of the audit trail: when, who, what, on which kind of record and with what outcome.
 * It never shows content, because the trail holds none.
 */
export function AuditEventsTable({ events }: { events: readonly AuditEventDto[] }) {
  const { t } = useTranslation('audit');
  const label = useLabel();
  return (
    <TableContainer aria-label={t('table.caption')}>
      <Table>
        <TableCaption>{t('table.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('col.when')}</TableHead>
            <TableHead>{t('col.who')}</TableHead>
            <TableHead>{t('col.action')}</TableHead>
            <TableHead>{t('col.record')}</TableHead>
            <TableHead>{t('col.outcome')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="whitespace-nowrap">
                <span className="tabular">{formatDateTime(event.occurredAt)}</span>
                {event.sealed ? null : (
                  <span className="block text-xs text-muted-foreground">{t('sealed.pending')}</span>
                )}
              </TableCell>
              <TableCell>
                <span className="font-medium">{event.actorName ?? t('actor.system')}</span>
                {event.actingRole ? (
                  <span className="block text-xs text-muted-foreground">
                    {label(`shell:role.${event.actingRole}`, event.actingRole)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>{label(`audit:action.${event.action}`, event.action)}</TableCell>
              <TableCell>
                {event.resourceType
                  ? label(`audit:resource.${event.resourceType}`, event.resourceType)
                  : null}
              </TableCell>
              <TableCell>
                {event.outcome === 'allow' ? (
                  <Badge tone="success">{t('outcome.allow')}</Badge>
                ) : (
                  <span className="grid gap-1">
                    <StatusBadge status="error">{t('outcome.deny')}</StatusBadge>
                    {event.reason ? (
                      <span className="text-xs text-muted-foreground">
                        {t('reason', { reason: event.reason })}
                      </span>
                    ) : null}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
