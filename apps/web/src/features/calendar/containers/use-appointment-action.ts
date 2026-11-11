import type { AppointmentDto, CalendarEntryDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { calendarApi, calendarKeys } from '../api/calendar-api.js';

type CalendarApi = ReturnType<typeof calendarApi>;

/**
 * Runs one change to an appointment (a transition, a cancellation, a move, a correction). On
 * success the appointment on screen takes the answer at once (its new version included) and every
 * view that shows it is refreshed. A stale version means somebody else changed it first: the
 * appointment and its history are reloaded so the person sees what happened.
 */
export function useAppointmentAction<V>(
  entry: CalendarEntryDto,
  run: (api: CalendarApi, variables: V) => Promise<AppointmentDto>,
  onDone?: (updated: AppointmentDto, variables: V) => void,
) {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: V) => run(calendarApi(api), variables),

    onSuccess: async (updated, variables) => {
      queryClient.setQueryData<CalendarEntryDto>(calendarKeys.appointment(entry.id), (previous) =>
        previous ? { ...previous, ...updated } : previous,
      );
      onDone?.(updated, variables);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] }),
        queryClient.invalidateQueries({ queryKey: calendarKeys.history(entry.id) }),
        queryClient.invalidateQueries({ queryKey: ['calendar', 'availability'] }),
        queryClient.invalidateQueries({ queryKey: ['worklist'] }),
      ]);
    },

    onError: async (error) => {
      if (isApiError(error) && (error.code === 'stale_revision' || error.code === 'conflict')) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: calendarKeys.appointment(entry.id) }),
          queryClient.invalidateQueries({ queryKey: calendarKeys.history(entry.id) }),
        ]);
      }
    },
  });
}
