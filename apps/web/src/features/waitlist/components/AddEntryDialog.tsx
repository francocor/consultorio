import type { PatientSummaryDto, WaitlistChannel } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
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
import { PatientPicker } from '../../patients/index.js';
import { waitlistApi, waitlistKeys } from '../api/waitlist-api.js';
import { useWaitlistOptions } from '../hooks/use-options.js';

import {
  NO_PREFERENCES,
  PreferencesFields,
  preferencesBody,
  preferencesProblem,
  type Preferences,
} from './PreferencesFields.js';

/**
 * Puts a patient on the waitlist. The agreement to receive offers is a box of its own, never
 * ticked for the person: reception records what the patient said. Without it the entry is kept for
 * reception to call, and the dialog says so before it is saved.
 */
export function AddEntryDialog({
  onClose,
  initialPatient,
}: {
  onClose: () => void;
  /** A patient chosen elsewhere (the record), so the picker is skipped. */
  initialPatient?: PatientSummaryDto | undefined;
}) {
  const { t } = useTranslation(['waitlist', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const options = useWaitlistOptions();
  const [patient, setPatient] = useState<PatientSummaryDto | null>(initialPatient ?? null);
  const [typeId, setTypeId] = useState('');
  const [professionalId, setProfessionalId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [preferences, setPreferences] = useState<Preferences>(NO_PREFERENCES);
  const [channels, setChannels] = useState<WaitlistChannel[]>(['email']);
  const [optIn, setOptIn] = useState(false);

  const create = useMutation({
    mutationFn: () => {
      if (!patient) throw new Error('A patient is needed');
      return waitlistApi(api).create({
        patientId: patient.id,
        appointmentTypeId: typeId,
        professionalId: professionalId === '' ? null : professionalId,
        locationId: locationId === '' ? null : locationId,
        ...preferencesBody(preferences),
        offersOptIn: optIn,
        channels,
      });
    },
    onSuccess: async () => {
      toast.success(t('waitlist:add.done'));
      await queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
      onClose();
    },
  });

  const ready =
    patient !== null &&
    typeId !== '' &&
    channels.length > 0 &&
    preferencesProblem(preferences) === null;
  const duplicate = isApiError(create.error) && create.error.code === 'conflict';

  function toggleChannel(channel: WaitlistChannel, on: boolean) {
    setChannels((current) =>
      on ? [...new Set([...current, channel])] : current.filter((entry) => entry !== channel),
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
          <DialogTitle>{t('waitlist:add.title')}</DialogTitle>
          <DialogDescription>{t('waitlist:add.description')}</DialogDescription>
        </DialogHeader>

        {patient ? (
          <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
            <span className="font-medium">{`${patient.familyName}, ${patient.givenNames}`}</span>
            {initialPatient ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPatient(null);
                }}
              >
                {t('waitlist:add.changePatient')}
              </Button>
            )}
          </div>
        ) : (
          <PatientPicker label={t('waitlist:add.patient')} onSelect={setPatient} />
        )}

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="waitlist-type">{t('waitlist:add.type')}</Label>
            <Select
              id="waitlist-type"
              value={typeId}
              onChange={(event) => {
                setTypeId(event.target.value);
              }}
            >
              <option value="" />
              {options.types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="waitlist-professional">{t('waitlist:add.professional')}</Label>
              <Select
                id="waitlist-professional"
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
              <Label htmlFor="waitlist-location">{t('waitlist:add.location')}</Label>
              <Select
                id="waitlist-location"
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
        </div>

        <PreferencesFields value={preferences} onChange={setPreferences} idPrefix="add" />

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

        <CheckboxCard
          checked={optIn}
          onCheckedChange={setOptIn}
          title={t('waitlist:add.optIn.title')}
          description={t('waitlist:add.optIn.description')}
        />
        {optIn ? null : (
          <Alert tone="warning">
            <AlertDescription>{t('waitlist:add.optIn.manual')}</AlertDescription>
          </Alert>
        )}

        {create.isError ? (
          <Alert tone="danger">
            <AlertDescription>
              {duplicate ? t('waitlist:add.duplicate') : describeError(t, create.error).message}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!ready}
            loading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {t('waitlist:add.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
