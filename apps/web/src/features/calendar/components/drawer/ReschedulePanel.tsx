import {
  SlotConflictExtension,
  type AppointmentDto,
  type CalendarEntryDto,
  type LocationDto,
} from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { isApiError } from '../../../../shared/lib/api-client.js';
import { formatDayLong, formatTime } from '../../../../shared/lib/format.js';
import { describeError } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import { localDateOf } from '../../../../shared/ui/calendar/zoned-time.js';
import { Input, Select } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { calendarApi, calendarKeys } from '../../api/calendar-api.js';
import { useAppointmentAction } from '../../containers/use-appointment-action.js';
import type { SchedulingProfessional } from '../../containers/use-scheduling-people.js';
import { SlotGrid, type SlotOption } from '../SlotGrid.js';

import { ErrorNotice } from './ErrorNotice.js';
import { PanelFrame } from './PanelFrame.js';

interface Move {
  startsAt: string;
  professionalId: string | undefined;
}

/**
 * Moving an appointment to another time, and optionally to another professional. The free times
 * come from the same availability the booking uses, for the type the appointment already has. A
 * time that was taken meanwhile offers the next free ones.
 */
export function ReschedulePanel({
  entry,
  professionals,
  location,
  onBack,
  onDone,
}: {
  entry: CalendarEntryDto;
  professionals: readonly SchedulingProfessional[];
  location: LocationDto | undefined;
  onBack: () => void;
  onDone: (updated: AppointmentDto) => void;
}) {
  const { t } = useTranslation('scheduling');
  const api = useApi();
  const timeZone = location?.timeZone ?? 'America/Argentina/Buenos_Aires';

  const [professionalId, setProfessionalId] = useState(entry.professionalId);
  const [date, setDate] = useState(() => localDateOf(entry.startsAt, timeZone));
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [nextSlots, setNextSlots] = useState<SlotOption[] | 'unknown' | null>(null);

  const params = {
    professionalId,
    typeId: entry.appointmentTypeId,
    from: date,
    to: date,
    locationId: entry.locationId,
  };
  const availability = useQuery({
    queryKey: calendarKeys.availability(params),
    queryFn: () => calendarApi(api).availability(params),
  });
  const slots = availability.data?.slots ?? [];

  const move = useAppointmentAction(
    entry,
    (client, value: Move) =>
      client.reschedule(entry.id, {
        expectedVersion: entry.version,
        startsAt: value.startsAt,
        ...(value.professionalId === undefined ? {} : { professionalId: value.professionalId }),
      }),
    (updated) => {
      onDone(updated);
    },
  );

  function submit() {
    if (startsAt === null) return;
    move.mutate(
      {
        startsAt,
        professionalId: professionalId === entry.professionalId ? undefined : professionalId,
      },
      {
        onError: (error) => {
          if (isApiError(error) && error.code === 'slot_taken') {
            const extension = SlotConflictExtension.safeParse(error.extensions['slotConflict']);
            setNextSlots(extension.success ? extension.data.nextSlots : 'unknown');
          }
        },
      },
    );
  }

  function choose(slot: SlotOption) {
    setStartsAt(slot.startsAt);
    setDate(localDateOf(slot.startsAt, timeZone));
    setNextSlots(null);
    move.reset();
  }

  const takenSlot = move.isError && isApiError(move.error) && move.error.code === 'slot_taken';

  return (
    <PanelFrame title={t('drawer.reschedule.title')} onBack={onBack}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="reschedule-professional">{t('booking.professional')}</Label>
          <Select
            id="reschedule-professional"
            value={professionalId}
            onChange={(event) => {
              setProfessionalId(event.target.value);
              setStartsAt(null);
              setNextSlots(null);
            }}
          >
            {professionals.map((professional) => (
              <option key={professional.id} value={professional.id}>
                {professional.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reschedule-date">{t('booking.date')}</Label>
          <Input
            id="reschedule-date"
            type="date"
            value={date}
            onChange={(event) => {
              if (event.target.value === '') return;
              setDate(event.target.value);
              setStartsAt(null);
              setNextSlots(null);
            }}
          />
        </div>
      </div>

      {availability.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('booking.slotsLoading')}
        </p>
      ) : availability.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, availability.error).message}</AlertDescription>
        </Alert>
      ) : slots.length > 0 ? (
        <SlotGrid
          slots={slots}
          selected={startsAt}
          timeZone={timeZone}
          referenceDate={date}
          label={t('booking.slots')}
          onSelect={choose}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('booking.noSlots')}</p>
      )}

      {startsAt !== null ? (
        <p className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground">
          {t('booking.chosen', {
            time: `${formatDayLong(localDateOf(startsAt, timeZone))}, ${formatTime(startsAt, { timeZone })}`,
          })}
        </p>
      ) : null}

      {takenSlot ? (
        <Alert tone="danger">
          <AlertTitle>{t('booking.conflict.title')}</AlertTitle>
          <AlertDescription>
            {nextSlots === null || nextSlots === 'unknown' ? (
              t('booking.conflict.generic')
            ) : nextSlots.length === 0 ? (
              t('booking.conflict.none')
            ) : (
              <>
                <span className="block">
                  {t('booking.conflict.description', {
                    professional:
                      professionals.find((item) => item.id === professionalId)?.name ?? '',
                  })}
                </span>
                <SlotGrid
                  slots={nextSlots}
                  selected={null}
                  timeZone={timeZone}
                  referenceDate={date}
                  onSelect={choose}
                  className="mt-2"
                />
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : move.isError ? (
        <ErrorNotice error={move.error} />
      ) : null}

      <Button type="button" disabled={startsAt === null} loading={move.isPending} onClick={submit}>
        {t('drawer.reschedule.confirm')}
      </Button>
    </PanelFrame>
  );
}
