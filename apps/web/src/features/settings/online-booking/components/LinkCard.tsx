import type { AppointmentTypeDto, BookingLinkDto, LocationDto } from '@consultorio/contracts';
import { Copy, Link2, Pencil, QrCode as QrIcon, RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../../../shared/ui/badge.js';
import { Button } from '../../../../shared/ui/button.js';
import { Switch } from '../../../../shared/ui/checkbox.js';
import { Input } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';

export interface LinkCardProps {
  /** The heading: the name of the professional, or "Enlace de la organización". */
  title: string;
  /** How the controls of the card name their owner, such as "la organización" or the professional. */
  owner: string;
  link: BookingLinkDto | null;
  /** The full address to open, or null while the API cannot name it. */
  address: string | null;
  types: readonly AppointmentTypeDto[];
  locations: readonly LocationDto[];
  /** What an empty list of places means for this link. */
  allLocationsText: string;
  /**
   * Whether the link carries its own types and places. The link of the organization does not: it
   * lists the professionals whose own link is on, and each one chooses theirs.
   */
  hasOffer: boolean;
  /** Read-only organization: nothing can be changed (looking and copying still work). */
  readOnly: boolean;
  pending: boolean;
  onCreate: () => void;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onRegenerate: () => void;
  onShowQr: () => void;
  onCopy: () => void;
}

function stateOf(link: BookingLinkDto | null): { key: string; tone: BadgeTone } {
  if (!link) return { key: 'state.none', tone: 'neutral' };
  return link.enabled
    ? { key: 'state.active', tone: 'success' }
    : { key: 'state.disabled', tone: 'neutral' };
}

function NameList({ names }: { names: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {names.map((name) => (
        <li key={name} className="rounded-full border px-2 py-0.5">
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * One link of the organization: its state in words, the address with the ways to share it (copy,
 * QR), what it offers and the controls to change it. Nothing here calls the API: the screen that
 * owns the cards does.
 */
export function LinkCard(props: LinkCardProps) {
  const { t } = useTranslation('bookingAdmin');
  const { link, readOnly } = props;
  const id = useId();
  const state = stateOf(link);
  const typeNames = link
    ? props.types.filter((type) => link.typeIds.includes(type.id)).map((type) => type.name)
    : [];
  const placeNames = link
    ? props.locations.filter((place) => link.locationIds.includes(place.id)).map((p) => p.name)
    : [];

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="font-medium">
          {props.title}
        </h3>
        <Badge tone={state.tone}>{t(state.key)}</Badge>
      </div>

      {link ? (
        <>
          {props.address ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                readOnly
                aria-label={t('link.address', { name: props.owner })}
                value={props.address}
                className="min-w-0 flex-1 basis-64"
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
              />
              <Button type="button" variant="outline" onClick={props.onCopy}>
                <Copy aria-hidden="true" />
                {t('link.copy')}
              </Button>
              <Button type="button" variant="outline" onClick={props.onShowQr}>
                <QrIcon aria-hidden="true" />
                {t('link.qr')}
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Link2 className="size-4" aria-hidden="true" />
              {t('link.noAddress')}
            </p>
          )}

          {props.hasOffer ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="grid gap-1">
                <dt className="text-muted-foreground">{t('link.types')}</dt>
                <dd>
                  {typeNames.length > 0 ? (
                    <NameList names={typeNames} />
                  ) : (
                    <span className="font-medium text-warning-soft-foreground">
                      {t('link.noTypes')}
                    </span>
                  )}
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-muted-foreground">{t('link.locations')}</dt>
                <dd>
                  {placeNames.length > 0 ? <NameList names={placeNames} /> : props.allLocationsText}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('org.explain')}</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id={`${id}-enabled`}
                checked={link.enabled}
                disabled={readOnly || props.pending}
                onCheckedChange={props.onToggle}
              />
              <Label htmlFor={`${id}-enabled`}>{t('link.switch')}</Label>
            </div>
            {props.hasOffer ? (
              <Button type="button" variant="outline" disabled={readOnly} onClick={props.onEdit}>
                <Pencil aria-hidden="true" />
                {t('link.edit')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={readOnly}
              onClick={props.onRegenerate}
            >
              <RefreshCw aria-hidden="true" />
              {t('link.regenerate')}
            </Button>
          </div>
        </>
      ) : (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">{t('link.none')}</p>
          <div>
            <Button type="button" disabled={readOnly} onClick={props.onCreate}>
              {t('link.create')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
