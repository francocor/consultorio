import type { WaitlistChannel, WaitlistEntryDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { waitlistApi, waitlistKeys } from '../api/waitlist-api.js';
import { useWaitlistOptions } from '../hooks/use-options.js';

import {
  PreferencesFields,
  preferencesBody,
  preferencesProblem,
  type Preferences,
} from './PreferencesFields.js';

/** The preferences of an entry as the fields edit them. */
function preferencesOf(entry: WaitlistEntryDto): Preferences {
  return {
    weekdays: entry.weekdays,
    timeRanges: entry.timeRanges.map((range) => ({ ...range })),
    earliestDate: entry.earliestDate ?? '',
    latestDate: entry.latestDate ?? '',
  };
}

/**
 * Edits what an entry waits for: the professional and the place, the days and hours, the channels,
 * and the agreement to receive offers when the patient gave it after the entry was made. The
 * patient and the type of visit do not change: that is another wait.
 */
export function EditEntryDialog({
  entry,
  onClose,
}: {
  entry: WaitlistEntryDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['waitlist', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const options = useWaitlistOptions();
  const [professionalId, setProfessionalId] = useState(entry.professionalId ?? '');
  const [locationId, setLocationId] = useState(entry.locationId ?? '');
  const [preferences, setPreferences] = useState<Preferences>(preferencesOf(entry));
  const [channels, setChannels] = useState<WaitlistChannel[]>(entry.channels);
  const [optIn, setOptIn] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      waitlistApi(api).update(entry.id, {
        professionalId: professionalId === '' ? null : professionalId,
        locationId: locationId === '' ? null : locationId,
        ...preferencesBody(preferences),
        channels,
        ...(optIn ? { offersOptIn: true as const } : {}),
      }),
    onSuccess: async () => {
      toast.success(t('waitlist:edit.done'));
      await queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
      onClose();
    },
  });

  const ready = channels.length > 0 && preferencesProblem(preferences) === null;

  function toggleChannel(channel: WaitlistChannel, on: boolean) {
    setChannels((current) =>
      on
        ? [...new Set([...current, channel])]
        : current.filter((entryChannel) => entryChannel !== channel),
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('waitlist:edit.title', { name: entry.patientName })}</DialogTitle>
          <DialogDescription>
            {t('waitlist:edit.description', { type: entry.appointmentTypeName })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-professional">{t('waitlist:add.professional')}</Label>
            <Select
              id="edit-professional"
              value={professionalId}
              onChange={(event) => {
                setProfessionalId(event.target.value);
              }}
            >
              <option value="">{t('waitlist:add.anyProfessional')}</option>
              {options.professionals.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-location">{t('waitlist:add.location')}</Label>
            <Select
              id="edit-location"
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value);
              }}
            >
              <option value="">{t('waitlist:add.anyLocation')}</option>
              {options.locations.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <PreferencesFields value={preferences} onChange={setPreferences} idPrefix="edit" />

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t('waitlist:add.channels.legend')}</legend>
          <CheckboxCard
            checked={channels.includes('email')}
            onCheckedChange={(on) => {
              toggleChannel('email', on);
            }}
            title={t('waitlist:channel.email')}
          />
          <CheckboxCard
            checked={channels.includes('whatsapp')}
            onCheckedChange={(on) => {
              toggleChannel('whatsapp', on);
            }}
            title={t('waitlist:channel.whatsapp')}
            description={t('waitlist:add.channels.whatsappHint')}
          />
        </fieldset>

        {entry.offersOptInAt === null ? (
          <CheckboxCard
            checked={optIn}
            onCheckedChange={setOptIn}
            title={t('waitlist:add.optIn.title')}
            description={t('waitlist:edit.optInLater')}
          />
        ) : null}

        {save.isError ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!ready}
            loading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('common:action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
