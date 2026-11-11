import type { PublicProfessionalDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';

/**
 * The choice of the type of visit and the place, when the professional offers more than one of
 * either. With one of each there is nothing to ask and nothing is shown.
 */
export function OfferChoice({
  professional,
  typeId,
  locationId,
  onChange,
}: {
  professional: PublicProfessionalDto;
  typeId: string;
  locationId: string;
  onChange: (choice: { typeId: string; locationId: string }) => void;
}) {
  const { t } = useTranslation('booking');
  const manyTypes = professional.types.length > 1;
  const manyLocations = professional.locations.length > 1;
  if (!manyTypes && !manyLocations) return null;

  return (
    <div className="grid gap-4">
      {manyTypes ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t('choose.type.legend')}</legend>
          <RadioGroup
            value={typeId}
            onValueChange={(value) => {
              onChange({ typeId: value, locationId });
            }}
          >
            {professional.types.map((type) => (
              <RadioCard
                key={type.id}
                value={type.id}
                title={type.name}
                description={[
                  t('choose.type.duration', { minutes: type.durationMinutes }),
                  type.mode === 'virtual' ? t('choose.type.virtual') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}

      {manyLocations ? (
        <div className="grid gap-1.5">
          <Label htmlFor="booking-location">{t('choose.location.label')}</Label>
          <Select
            id="booking-location"
            value={locationId}
            onChange={(event) => {
              onChange({ typeId, locationId: event.target.value });
            }}
          >
            {professional.locations.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  );
}
