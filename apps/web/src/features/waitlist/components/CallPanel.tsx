import type { WaitlistCallItemDto } from '@consultorio/contracts';
import { Mail, PhoneCall } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatDateTime, formatTime } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';

/**
 * The slots reception can fill by phone (the worklist kind "contacto manual de lista de espera"):
 * each freed time with the patient to call, how to reach them, and why no offer went out by
 * itself. Soonest first. The times are shown in the zone of the place of the slot.
 */
export function CallPanel({ items }: { items: readonly WaitlistCallItemDto[] }) {
  const { t } = useTranslation('waitlist');
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="calls-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="grid gap-1">
        <h2 id="calls-title" className="font-display text-lg font-semibold">
          {t('calls.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('calls.description')}</p>
      </div>
      <ul className="grid gap-3">
        {items.map((item) => {
          const zone = { timeZone: item.slot.timeZone };
          return (
            <li
              key={`${item.entry.id}-${item.slot.startsAt}`}
              className="grid gap-1.5 rounded-md border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {t('calls.slot', {
                    when: formatDateTime(item.slot.startsAt, zone),
                    until: formatTime(item.slot.endsAt, zone),
                    professional: item.slot.professionalName,
                    location: item.slot.locationName,
                  })}
                </p>
                <Badge tone="warning">{t(`calls.reason.${item.reason}`)}</Badge>
              </div>
              <p>
                <span className="font-medium">{item.entry.patientName}</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {item.entry.appointmentTypeName}
                </span>
              </p>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {item.contact.phone ? (
                  <a
                    href={`tel:${item.contact.phone.replace(/[^\d+]/g, '')}`}
                    className="inline-flex items-center gap-1.5 font-medium text-primary-ink underline-offset-4 hover:underline"
                  >
                    <PhoneCall className="size-4" aria-hidden="true" />
                    {item.contact.phone}
                  </a>
                ) : null}
                {item.contact.email ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Mail className="size-4" aria-hidden="true" />
                    {item.contact.email}
                  </span>
                ) : null}
                {item.contact.phone || item.contact.email ? null : (
                  <span className="text-muted-foreground">{t('calls.noContact')}</span>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
