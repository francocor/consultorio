import {
  SeriesConflictExtension,
  SlotConflictExtension,
  type AppointmentDto,
  type AppointmentTypeDto,
  type BookAppointmentRequest,
  type LocationDto,
  type PatientSummaryDto,
  type SeriesOccurrenceDto,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatDayLong, formatTime } from '../../../shared/lib/format.js';
import { describeError, translateApiKey } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { localDateOf } from '../../../shared/ui/calendar/zoned-time.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { PatientPicker } from '../../patients/components/PatientPicker.js';
import { calendarApi, calendarKeys } from '../api/calendar-api.js';
import type { SchedulingProfessional } from '../containers/use-scheduling-people.js';
import { resolveTimeZone } from '../domain/time-zone.js';

import { creatableCount, SeriesReview } from './SeriesReview.js';
import { SlotGrid, type SlotOption } from './SlotGrid.js';

export interface BookingInitial {
  professionalId?: string | undefined;
  /** The time chosen on the grid. */
  start?: Date | undefined;
  /** The day on screen (`YYYY-MM-DD`), when no time was chosen. */
  date?: string | undefined;
  locationId?: string | undefined;
}

export interface BookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  professionals: readonly SchedulingProfessional[];
  locations: readonly LocationDto[];
  initial?: BookingInitial | undefined;
  /** Holds `scheduling.override_hours`: may book outside the working hours with a reason. */
  canOverrideHours: boolean;
  onBooked?: ((appointment: AppointmentDto) => void) | undefined;
}

/** The types a professional attends: open to all, or listed for them, or for their discipline. */
function offeredTypes(
  types: readonly AppointmentTypeDto[],
  professional: SchedulingProfessional | undefined,
): AppointmentTypeDto[] {
  return types.filter(
    (type) =>
      type.active &&
      (type.professionalIds.length === 0 ||
        (professional !== undefined && type.professionalIds.includes(professional.id))) &&
      (type.specialties.length === 0 ||
        (professional !== undefined &&
          type.specialties.some((specialty) => professional.specialties.includes(specialty)))),
  );
}

/**
 * Booking in a few taps. From a time chosen on the grid only the patient is missing; from the
 * button the person picks the professional, the day and one of the free times. A time that was
 * taken meanwhile shows the next free ones, one tap away.
 */
export function BookingDialog(props: BookingDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl">
        {props.open ? <BookingForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function BookingForm({
  onOpenChange,
  professionals,
  locations,
  initial,
  canOverrideHours,
  onBooked,
}: BookingDialogProps) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();

  const [patient, setPatient] = useState<PatientSummaryDto | null>(null);
  const [professionalId, setProfessionalId] = useState(
    initial?.professionalId ?? (professionals.length === 1 ? (professionals[0]?.id ?? '') : ''),
  );
  const [typeId, setTypeId] = useState('');
  const [startsAt, setStartsAt] = useState<string | null>(initial?.start?.toISOString() ?? null);
  const [chosenLocationId, setChosenLocationId] = useState(initial?.locationId ?? '');
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState<'unknown' | { nextSlots: SlotOption[] } | null>(null);
  const [now] = useState(() => new Date());
  const [repeat, setRepeat] = useState(false);
  const [everyWeeks, setEveryWeeks] = useState(1);
  const [sessions, setSessions] = useState(4);
  const [review, setReview] = useState<{
    occurrences: SeriesOccurrenceDto[];
    skip: number[];
  } | null>(null);

  const professional = professionals.find((item) => item.id === professionalId);
  const candidateLocations = locations.filter(
    (location) =>
      location.active &&
      (professional === undefined ||
        professional.locationIds.length === 0 ||
        professional.locationIds.includes(location.id)),
  );
  const fallbackLocationId =
    chosenLocationId !== '' && candidateLocations.some((item) => item.id === chosenLocationId)
      ? chosenLocationId
      : (candidateLocations[0]?.id ?? '');
  const timeZone = resolveTimeZone(locations, fallbackLocationId);

  const initialDate = initial?.start
    ? localDateOf(initial.start, timeZone)
    : (initial?.date ?? null);
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const date = pickedDate ?? initialDate ?? localDateOf(now, timeZone);

  const types = useQuery({
    queryKey: calendarKeys.types(false),
    queryFn: () => calendarApi(api).types(false),
    staleTime: 5 * 60_000,
  });
  const offered = offeredTypes(types.data ?? [], professional);
  const type = offered.find((item) => item.id === typeId) ?? offered[0];

  const availabilityParams =
    professionalId !== '' && type !== undefined
      ? { professionalId, typeId: type.id, from: date, to: date }
      : null;
  const availability = useQuery({
    queryKey: availabilityParams ? calendarKeys.availability(availabilityParams) : calendarKeys.all,
    queryFn: () => {
      if (!availabilityParams) throw new Error('availability needs a professional and a type');
      return calendarApi(api).availability(availabilityParams);
    },
    enabled: availabilityParams !== null,
  });
  const slots = availability.data?.slots ?? [];
  const closed = availability.data?.closedDays.find((day) => day.date === date);

  const chosen =
    startsAt === null
      ? undefined
      : slots.find((slot) => new Date(slot.startsAt).getTime() === new Date(startsAt).getTime());
  const outsideHours = startsAt !== null && availability.isSuccess && chosen === undefined;
  const bookingLocationId = chosen?.locationId ?? fallbackLocationId;
  const slotZone = resolveTimeZone(locations, bookingLocationId);

  const book = useMutation({
    mutationFn: (body: BookAppointmentRequest) => calendarApi(api).book(body),
    onSuccess: async (appointment) => {
      const when = `${formatDayLong(localDateOf(appointment.startsAt, slotZone))}, ${formatTime(appointment.startsAt, { timeZone: slotZone })}`;
      toast.success(
        t('scheduling:booking.success', {
          patient: patient ? `${patient.familyName}, ${patient.givenNames}` : '',
          when,
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] });
      onBooked?.(appointment);
      onOpenChange(false);
    },
    onError: async (error) => {
      if (isApiError(error) && error.code === 'slot_taken') {
        const extension = SlotConflictExtension.safeParse(error.extensions['slotConflict']);
        setConflict(extension.success ? { nextSlots: extension.data.nextSlots } : 'unknown');
        await queryClient.invalidateQueries({ queryKey: ['calendar', 'availability'] });
      }
    },
  });

  const needsReason = outsideHours && canOverrideHours;
  const canSubmit =
    patient !== null &&
    professionalId !== '' &&
    type !== undefined &&
    startsAt !== null &&
    bookingLocationId !== '' &&
    availability.isSuccess &&
    (!outsideHours || (canOverrideHours && reason.trim() !== '')) &&
    (!repeat || (sessions >= 2 && sessions <= 52)) &&
    !book.isPending;

  const series = useMutation({
    mutationFn: (variables: { mode: 'dry_run' | 'commit'; skip: number[] }) => {
      if (!canSubmit) throw new Error('the series is not ready');
      return calendarApi(api).series({
        patientId: patient.id,
        professionalId,
        locationId: bookingLocationId,
        appointmentTypeId: type.id,
        startsAt,
        recurrence: { frequency: 'weekly', everyWeeks, count: sessions },
        mode: variables.mode,
        skip: variables.skip,
        ...(outsideHours ? { overrideHours: { reason: reason.trim() } } : {}),
      });
    },
    onSuccess: async (result, variables) => {
      if (result.mode === 'dry_run') {
        setReview({ occurrences: result.occurrences, skip: variables.skip });
        return;
      }
      toast.success(
        t('scheduling:series.created', {
          count: review ? creatableCount(review.occurrences, review.skip) : sessions,
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] });
      onOpenChange(false);
    },
    onError: (error) => {
      // The commit found a session that is no longer free: show the sessions as the server sees them.
      const extension = isApiError(error)
        ? SeriesConflictExtension.safeParse(error.extensions['seriesConflict'])
        : null;
      if (extension?.success) {
        setReview((previous) =>
          previous ? { ...previous, occurrences: extension.data.occurrences } : previous,
        );
      }
    },
  });

  function submit() {
    if (!canSubmit || series.isPending) return;
    if (repeat) {
      series.mutate({ mode: 'dry_run', skip: [] });
      return;
    }
    book.mutate({
      patientId: patient.id,
      professionalId,
      locationId: bookingLocationId,
      appointmentTypeId: type.id,
      startsAt,
      ...(outsideHours ? { overrideHours: { reason: reason.trim() } } : {}),
    });
  }

  function chooseSlot(slot: SlotOption) {
    setReview(null);
    setStartsAt(slot.startsAt);
    setPickedDate(localDateOf(slot.startsAt, slotZone));
    setConflict(null);
    book.reset();
  }

  const failure = book.error;
  const refusals =
    isApiError(failure) && failure.fieldErrors.length > 0
      ? failure.fieldErrors.map((field) => translateApiKey(t, field.i18nKey))
      : [];
  const showGenericFailure =
    failure !== null &&
    conflict === null &&
    !(isApiError(failure) && failure.code === 'slot_taken');

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('scheduling:booking.title')}</DialogTitle>
        <DialogDescription>{t('scheduling:booking.description')}</DialogDescription>
      </DialogHeader>

      {review ? (
        <SeriesReview
          occurrences={review.occurrences}
          skip={review.skip}
          timeZone={slotZone}
          committing={series.isPending}
          error={
            series.isError && !(isApiError(series.error) && series.error.code === 'conflict') ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, series.error).message}</AlertDescription>
              </Alert>
            ) : null
          }
          onToggleSkip={(index) => {
            setReview((previous) =>
              previous
                ? {
                    ...previous,
                    skip: previous.skip.includes(index)
                      ? previous.skip.filter((item) => item !== index)
                      : [...previous.skip, index].sort((a, b) => a - b),
                  }
                : previous,
            );
          }}
          onCommit={() => {
            series.mutate({ mode: 'commit', skip: review.skip });
          }}
          onBack={() => {
            setReview(null);
            series.reset();
          }}
        />
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            {patient ? (
              <>
                <span className="text-sm font-medium">{t('scheduling:booking.patient')}</span>
                <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
                  <span className="font-medium">{`${patient.familyName}, ${patient.givenNames}`}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPatient(null);
                    }}
                  >
                    {t('scheduling:booking.changePatient')}
                  </Button>
                </div>
              </>
            ) : (
              <PatientPicker label={t('scheduling:booking.patient')} onSelect={setPatient} />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="booking-professional">{t('scheduling:booking.professional')}</Label>
              <Select
                id="booking-professional"
                value={professionalId}
                onChange={(event) => {
                  setProfessionalId(event.target.value);
                  setTypeId('');
                  setConflict(null);
                }}
              >
                {professionalId === '' ? <option value="" /> : null}
                {professionals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="booking-type">{t('scheduling:booking.type')}</Label>
              <Select
                id="booking-type"
                value={type?.id ?? ''}
                disabled={offered.length === 0}
                onChange={(event) => {
                  setTypeId(event.target.value);
                  setConflict(null);
                }}
              >
                {offered.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t('scheduling:booking.typeOption', {
                      name: item.name,
                      minutes: item.durationMinutes,
                    })}
                  </option>
                ))}
              </Select>
              {professionalId !== '' && types.isSuccess && offered.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('scheduling:booking.noTypes')}</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="booking-date">{t('scheduling:booking.date')}</Label>
            <Input
              id="booking-date"
              type="date"
              value={date}
              onChange={(event) => {
                if (event.target.value === '') return;
                setPickedDate(event.target.value);
                setStartsAt(null);
                setConflict(null);
              }}
            />
          </div>

          {availabilityParams ? (
            <div className="grid gap-2">
              {availability.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('scheduling:booking.slotsLoading')}
                </p>
              ) : availability.isError ? (
                <Alert tone="danger">
                  <AlertDescription>
                    {describeError(t, availability.error).message}
                  </AlertDescription>
                </Alert>
              ) : slots.length > 0 ? (
                <SlotGrid
                  slots={slots}
                  selected={startsAt}
                  timeZone={slotZone}
                  referenceDate={date}
                  label={t('scheduling:booking.slots')}
                  onSelect={chooseSlot}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {closed
                    ? t('scheduling:booking.closedDay', { name: closed.name })
                    : t('scheduling:booking.noSlots')}
                </p>
              )}
            </div>
          ) : null}

          {startsAt !== null ? (
            <p className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground">
              {t('scheduling:booking.chosen', {
                time: `${formatDayLong(localDateOf(startsAt, slotZone))}, ${formatTime(startsAt, { timeZone: slotZone })}`,
              })}
              {type ? (
                <span className="block font-normal">
                  {t('scheduling:booking.summary', {
                    type: type.name,
                    minutes: type.durationMinutes,
                    professional: professional?.name ?? '',
                  })}
                </span>
              ) : null}
            </p>
          ) : null}

          {startsAt !== null ? (
            <div className="grid gap-3 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="booking-repeat"
                  checked={repeat}
                  onCheckedChange={(value) => {
                    setRepeat(value === true);
                  }}
                />
                <Label htmlFor="booking-repeat" className="font-normal">
                  {t('scheduling:series.repeat')}
                </Label>
              </div>
              {repeat ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="booking-every">{t('scheduling:series.every')}</Label>
                    <Select
                      id="booking-every"
                      value={String(everyWeeks)}
                      onChange={(event) => {
                        setEveryWeeks(Number(event.target.value));
                      }}
                    >
                      {Array.from({ length: 8 }, (_, index) => index + 1).map((weeks) => (
                        <option key={weeks} value={weeks}>
                          {t('scheduling:series.everyOption', { count: weeks })}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="booking-sessions">{t('scheduling:series.count')}</Label>
                    <Input
                      id="booking-sessions"
                      type="number"
                      inputMode="numeric"
                      min={2}
                      max={52}
                      value={sessions}
                      onChange={(event) => {
                        setSessions(Number(event.target.value));
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {outsideHours ? (
            <Alert tone="warning">
              <AlertTitle>{t('scheduling:booking.outsideHours.title')}</AlertTitle>
              <AlertDescription>
                {canOverrideHours
                  ? t('scheduling:booking.outsideHours.override')
                  : t('scheduling:booking.outsideHours.denied')}
              </AlertDescription>
            </Alert>
          ) : null}

          {needsReason ? (
            <div className="grid gap-1.5">
              <Label htmlFor="booking-reason">{t('scheduling:booking.overrideReason')}</Label>
              <Input
                id="booking-reason"
                value={reason}
                maxLength={200}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>
          ) : null}

          {outsideHours && candidateLocations.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="booking-location">{t('scheduling:booking.location')}</Label>
              <Select
                id="booking-location"
                value={fallbackLocationId}
                onChange={(event) => {
                  setChosenLocationId(event.target.value);
                }}
              >
                {candidateLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {conflict !== null ? (
            <Alert tone="danger">
              <AlertTitle>{t('scheduling:booking.conflict.title')}</AlertTitle>
              <AlertDescription>
                {conflict === 'unknown' ? (
                  t('scheduling:booking.conflict.generic')
                ) : conflict.nextSlots.length === 0 ? (
                  t('scheduling:booking.conflict.none')
                ) : (
                  <>
                    <span className="block">
                      {t('scheduling:booking.conflict.description', {
                        professional: professional?.name ?? '',
                      })}
                    </span>
                    <SlotGrid
                      slots={conflict.nextSlots}
                      selected={null}
                      timeZone={slotZone}
                      referenceDate={date}
                      onSelect={chooseSlot}
                      className="mt-2"
                    />
                  </>
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {refusals.length > 0 ? (
            <Alert tone="danger">
              <AlertDescription>
                {refusals.map((message) => (
                  <span key={message} className="block">
                    {message}
                  </span>
                ))}
              </AlertDescription>
            </Alert>
          ) : showGenericFailure && refusals.length === 0 ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, failure).message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              loading={book.isPending || series.isPending}
            >
              {repeat
                ? t('scheduling:series.review')
                : book.isPending
                  ? t('scheduling:booking.submitting')
                  : t('scheduling:booking.submit')}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}
