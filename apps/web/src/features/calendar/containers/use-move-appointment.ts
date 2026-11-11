import {
  SlotConflictExtension,
  type AppointmentDto,
  type CalendarEntryDto,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatTime } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { toast } from '../../../shared/ui/toaster.js';
import { calendarApi, type CalendarFeed } from '../api/calendar-api.js';

const FEED_KEY = ['calendar', 'feed'] as const;

interface MoveVariables {
  /** The appointment as the screen last saw it (its version goes with the request). */
  entry: CalendarEntryDto;
  startsAt: string;
  /** Present only when the professional changes. */
  professionalId?: string | undefined;
}

/** The appointment at its new place, keeping its length. */
function relocate(entry: CalendarEntryDto, startsAt: string, professionalId?: string) {
  const length = new Date(entry.endsAt).getTime() - new Date(entry.startsAt).getTime();
  return {
    ...entry,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + length).toISOString(),
    professionalId: professionalId ?? entry.professionalId,
  };
}

/**
 * Moving an appointment by dragging it (or with the keyboard). The grid shows the new place at
 * once; the server has the last word. If it refuses (the time is taken, the version is stale, the
 * organization is read-only) the appointment goes back to where it was and the person is told why,
 * with the next free times when there are any. A move that worked can be undone from the toast.
 */
export function useMoveAppointment(options: { timeZone: string }) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();

  /** Puts a moved appointment back, naming the version the move produced. */
  async function undo(variables: MoveVariables, updated: AppointmentDto) {
    try {
      await calendarApi(api).reschedule(variables.entry.id, {
        expectedVersion: updated.version,
        startsAt: variables.entry.startsAt,
        ...(variables.professionalId === undefined
          ? {}
          : { professionalId: variables.entry.professionalId }),
      });
      toast.success(t('scheduling:move.undone'));
    } catch (error) {
      toast.error(describeError(t, error).message);
    } finally {
      await queryClient.invalidateQueries({ queryKey: FEED_KEY });
    }
  }

  const mutation = useMutation({
    mutationFn: ({ entry, startsAt, professionalId }: MoveVariables) =>
      calendarApi(api).reschedule(entry.id, {
        expectedVersion: entry.version,
        startsAt,
        ...(professionalId === undefined ? {} : { professionalId }),
      }),

    onMutate: async ({ entry, startsAt, professionalId }) => {
      await queryClient.cancelQueries({ queryKey: FEED_KEY });
      const snapshot = queryClient.getQueriesData<CalendarFeed>({ queryKey: FEED_KEY });
      queryClient.setQueriesData<CalendarFeed>({ queryKey: FEED_KEY }, (feed) =>
        feed
          ? {
              ...feed,
              appointments: feed.appointments.map((item) =>
                item.id === entry.id ? relocate(item, startsAt, professionalId) : item,
              ),
            }
          : feed,
      );
      return { snapshot };
    },

    onError: (error, _variables, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
      if (isApiError(error) && error.code === 'slot_taken') {
        const extension = SlotConflictExtension.safeParse(error.extensions['slotConflict']);
        const times =
          extension.success && extension.data.nextSlots.length > 0
            ? extension.data.nextSlots
                .map((slot) => formatTime(slot.startsAt, { timeZone: options.timeZone }))
                .join(', ')
            : null;
        toast.error(t('scheduling:move.taken'), {
          ...(times === null ? {} : { description: t('scheduling:move.nextSlots', { times }) }),
        });
        return;
      }
      toast.error(describeError(t, error).message);
    },

    onSuccess: (updated: AppointmentDto, variables) => {
      toast.success(
        t('scheduling:move.done', {
          time: formatTime(updated.startsAt, { timeZone: options.timeZone }),
        }),
        {
          action: {
            label: t('scheduling:move.undo'),
            onClick: () => {
              void undo(variables, updated);
            },
          },
        },
      );
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: FEED_KEY }),
  });

  return {
    /** Moves `entry` to `start` (and to `professionalId` when it is another professional). */
    move: (entry: CalendarEntryDto, target: { start: Date; professionalId: string }) => {
      mutation.mutate({
        entry,
        startsAt: target.start.toISOString(),
        ...(target.professionalId === entry.professionalId
          ? {}
          : { professionalId: target.professionalId }),
      });
    },
    isMoving: mutation.isPending,
  };
}
