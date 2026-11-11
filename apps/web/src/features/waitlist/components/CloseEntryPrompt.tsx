import type { CalendarEntryDto, WaitlistEntryDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { waitlistApi, waitlistKeys } from '../api/waitlist-api.js';

import { CloseEntryDialog } from './CloseEntryDialog.js';

/** The statuses in which an appointment takes the place of a wait. */
const LIVE = new Set(['pending_approval', 'scheduled', 'confirmed', 'checked_in']);

/** Whether a booking like this one answers what the entry waits for. */
function fulfils(entry: WaitlistEntryDto, appointment: CalendarEntryDto): boolean {
  return (
    entry.patientId === appointment.patientId &&
    entry.appointmentTypeId === appointment.appointmentTypeId &&
    (entry.professionalId === null || entry.professionalId === appointment.professionalId) &&
    (entry.locationId === null || entry.locationId === appointment.locationId) &&
    entry.status !== 'closed'
  );
}

/**
 * In the appointment drawer: the patient of the appointment is on the waitlist for exactly this
 * (same type, and the professional and the place the entry names), so the wait is probably over.
 * It SUGGESTS closing the entry and does nothing until a person confirms (waitlist, "Fulfilled by
 * direct booking"). It shows nothing when there is nothing to suggest.
 */
export function CloseEntryPrompt({
  appointment,
  readOnly,
}: {
  appointment: CalendarEntryDto;
  readOnly: boolean;
}) {
  const { t } = useTranslation('waitlist');
  const api = useApi();
  const [dismissed, setDismissed] = useState(false);
  const [closing, setClosing] = useState<WaitlistEntryDto | null>(null);
  const live = LIVE.has(appointment.status);

  const matching = useQuery({
    queryKey: waitlistKeys.list({
      patientId: appointment.patientId,
      appointmentTypeId: appointment.appointmentTypeId,
      professionalId: appointment.professionalId,
    }),
    queryFn: () =>
      waitlistApi(api).list({
        patientId: appointment.patientId,
        appointmentTypeId: appointment.appointmentTypeId,
        professionalId: appointment.professionalId,
      }),
    enabled: live && !readOnly,
  });

  const entry = (matching.data?.entries ?? []).find((candidate) => fulfils(candidate, appointment));
  if (!live || readOnly || dismissed || !entry) return null;

  return (
    <section aria-labelledby="close-entry-title" className="mt-4 grid gap-3 border-t pt-4">
      <h3 id="close-entry-title" className="font-display text-base font-semibold">
        {t('prompt.title')}
      </h3>
      <Alert tone="info">
        <AlertDescription>
          {t('prompt.description', {
            type: entry.appointmentTypeName,
            professional: entry.professionalName ?? t('prompt.anyProfessional'),
          })}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setClosing(entry);
          }}
        >
          {t('prompt.close')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDismissed(true);
          }}
        >
          {t('prompt.keep')}
        </Button>
      </div>
      {closing ? (
        <CloseEntryDialog
          entry={closing}
          initialReason="fulfilled"
          onClose={() => {
            setClosing(null);
          }}
        />
      ) : null}
    </section>
  );
}
