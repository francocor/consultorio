import type { AppointmentTypeDto, LocationDto } from '@consultorio/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import { Checkbox, Switch } from '../../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../shared/ui/dialog.js';
import { Label } from '../../../../shared/ui/label.js';

export interface LinkChoice {
  typeIds: string[];
  locationIds: string[];
  enabled: boolean;
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * Chooses what a link offers: the appointment types a visitor can book and the places. When the
 * link is being created it also asks whether to switch it on at once (it starts switched off, so
 * nothing is published by accident).
 */
export function LinkDialog({
  mode,
  offers,
  name,
  types,
  locations,
  initial,
  locationsHelp,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  mode: 'create' | 'edit';
  /** False for the link of the organization, which carries no types or places of its own. */
  offers: boolean;
  /** Who the link is for, such as "la organización" or a professional. */
  name: string;
  types: readonly AppointmentTypeDto[];
  locations: readonly LocationDto[];
  initial: { typeIds: readonly string[]; locationIds: readonly string[] };
  /** What choosing no place means for this link. */
  locationsHelp: string;
  pending: boolean;
  error: string | null;
  onSubmit: (choice: LinkChoice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['bookingAdmin', 'common']);
  // Only what can still be offered: a type that was switched off since is dropped from the choice.
  const [typeIds, setTypeIds] = useState(
    () => new Set(types.filter((type) => initial.typeIds.includes(type.id)).map((type) => type.id)),
  );
  const [locationIds, setLocationIds] = useState(
    () =>
      new Set(locations.filter((place) => initial.locationIds.includes(place.id)).map((p) => p.id)),
  );
  const [enabled, setEnabled] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? t('bookingAdmin:dialog.createTitle', { name })
              : t('bookingAdmin:dialog.editTitle', { name })}
          </DialogTitle>
          <DialogDescription>
            {offers
              ? t('bookingAdmin:dialog.description')
              : t('bookingAdmin:dialog.descriptionOrg')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              typeIds: types.filter((type) => typeIds.has(type.id)).map((type) => type.id),
              locationIds: locations.filter((place) => locationIds.has(place.id)).map((p) => p.id),
              enabled,
            });
          }}
        >
          {error ? (
            <Alert tone="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {offers ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{t('bookingAdmin:dialog.types')}</legend>
              <p className="text-sm text-muted-foreground">{t('bookingAdmin:dialog.typesHelp')}</p>
              {types.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('bookingAdmin:dialog.noTypes')}</p>
              ) : (
                types.map((type) => (
                  <div key={type.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`type-${type.id}`}
                      checked={typeIds.has(type.id)}
                      onCheckedChange={(on) => {
                        setTypeIds(toggled(typeIds, type.id, on === true));
                      }}
                    />
                    <Label htmlFor={`type-${type.id}`}>{type.name}</Label>
                  </div>
                ))
              )}
            </fieldset>
          ) : null}

          {offers ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{t('bookingAdmin:dialog.locations')}</legend>
              <p className="text-sm text-muted-foreground">{locationsHelp}</p>
              {locations.map((place) => (
                <div key={place.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`place-${place.id}`}
                    checked={locationIds.has(place.id)}
                    onCheckedChange={(on) => {
                      setLocationIds(toggled(locationIds, place.id, on === true));
                    }}
                  />
                  <Label htmlFor={`place-${place.id}`}>{place.name}</Label>
                </div>
              ))}
            </fieldset>
          ) : null}

          {mode === 'create' ? (
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-0.5">
                <Label htmlFor="link-enable-now">{t('bookingAdmin:dialog.enable')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('bookingAdmin:dialog.enableHelp')}
                </p>
              </div>
              <Switch id="link-enable-now" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {mode === 'create' ? t('bookingAdmin:link.create') : t('bookingAdmin:dialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
