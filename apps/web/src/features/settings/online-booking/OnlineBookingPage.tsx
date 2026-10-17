import type { BookingLinkDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { useApi, useAppStatus } from '../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../app/session.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { settingsApi, settingsKeys } from '../api/settings-api.js';

import { bookingAdminApi, bookingAdminKeys } from './api/booking-admin-api.js';
import { LinkCard } from './components/LinkCard.js';
import { LinkDialog, type LinkChoice } from './components/LinkDialog.js';
import { QrDialog } from './components/QrDialog.js';
import { RulesSection } from './components/RulesSection.js';
import { addressOf } from './domain/link-address.js';

/** Settings > Turnos online: the booking links of the organization and the rules of the bookings. */
export function OnlineBookingPage() {
  return (
    <RequirePermission anyOf={['booking.manage']}>
      <OnlineBooking />
    </RequirePermission>
  );
}

/** Which professional (or the organization, with `null`) a dialog is about. */
type Target = { professionalId: string | null };

type Dialog =
  | { kind: 'create'; target: Target }
  | { kind: 'edit'; target: Target; link: BookingLinkDto }
  | { kind: 'qr'; target: Target; link: BookingLinkDto }
  | { kind: 'regenerate'; target: Target; link: BookingLinkDto }
  | null;

function OnlineBooking() {
  const { t } = useTranslation(['bookingAdmin', 'common']);
  usePageTitle(t('bookingAdmin:title'));
  const api = useApi();
  const me = useMe();
  const status = useAppStatus();
  const queryClient = useQueryClient();
  const admin = bookingAdminApi(api);
  const [dialog, setDialog] = useState<Dialog>(null);

  const links = useQuery({ queryKey: bookingAdminKeys.links, queryFn: admin.links });
  const professionals = useQuery({
    queryKey: bookingAdminKeys.professionals,
    queryFn: admin.professionals,
  });
  const types = useQuery({ queryKey: bookingAdminKeys.types, queryFn: admin.types });
  const locations = useQuery({ queryKey: bookingAdminKeys.locations, queryFn: admin.locations });
  const settings = useQuery({ queryKey: settingsKeys.all, queryFn: () => settingsApi(api).get() });

  const readOnly = status.readOnly || me.tenantStatus === 'read_only';
  const canEditRules = hasAnyPermission(me.permissions, ['tenant.settings.manage']);

  const refresh = () => queryClient.invalidateQueries({ queryKey: bookingAdminKeys.links });
  const closeAnd = (message: string) => () => {
    toast.success(message);
    setDialog(null);
    void refresh();
  };

  const create = useMutation({
    mutationFn: ({ target, choice }: { target: Target; choice: LinkChoice }) =>
      target.professionalId === null
        ? // The link of the organization carries no types or places: each professional chooses theirs.
          admin.create({ enabled: choice.enabled })
        : admin.create({
            professionalId: target.professionalId,
            enabled: choice.enabled,
            typeIds: choice.typeIds,
            locationIds: choice.locationIds,
          }),
    onSuccess: closeAnd(t('bookingAdmin:done.created')),
  });
  const edit = useMutation({
    mutationFn: ({ link, choice }: { link: BookingLinkDto; choice: LinkChoice }) =>
      admin.update(link.id, { typeIds: choice.typeIds, locationIds: choice.locationIds }),
    onSuccess: closeAnd(t('bookingAdmin:done.updated')),
  });
  const toggle = useMutation({
    mutationFn: ({ link, enabled }: { link: BookingLinkDto; enabled: boolean }) =>
      admin.update(link.id, { enabled }),
    onSuccess: (updated) => {
      toast.success(
        updated.enabled ? t('bookingAdmin:done.enabled') : t('bookingAdmin:done.disabled'),
      );
      void refresh();
    },
  });
  const regenerate = useMutation({
    mutationFn: (link: BookingLinkDto) => admin.regenerate(link.id),
    onSuccess: closeAnd(t('bookingAdmin:done.regenerated')),
  });

  const queries = [links, professionals, types, locations, settings];
  const failed = queries.find((query) => query.isError);
  if (failed) {
    return (
      <ErrorState
        error={failed.error}
        onRetry={() => {
          for (const query of queries) if (query.isError) void query.refetch();
        }}
      />
    );
  }
  if (!links.data || !professionals.data || !types.data || !locations.data || !settings.data) {
    return <FormSkeleton fields={4} />;
  }

  const origin = window.location.origin;
  const organizationLink = links.data.find((link) => link.professionalId === null) ?? null;
  const linkOf = (professionalId: string) =>
    links.data.find((link) => link.professionalId === professionalId) ?? null;
  const orgName = t('bookingAdmin:org.name');
  const nameOf = (target: Target) =>
    target.professionalId === null
      ? orgName
      : (professionals.data.find((person) => person.id === target.professionalId)?.name ?? '');
  const allLocationsText = (target: Target) =>
    target.professionalId === null
      ? t('bookingAdmin:link.allLocationsOrg')
      : t('bookingAdmin:link.allLocations');

  const refused = [create, edit, toggle, regenerate].find((mutation) => mutation.isError);

  const shared = {
    types: types.data,
    locations: locations.data,
    readOnly,
    pending: toggle.isPending,
  };
  const copy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      toast.success(t('bookingAdmin:done.copied'));
    } catch {
      toast.error(t('bookingAdmin:done.copyFailed'));
    }
  };
  const cardFor = (target: Target, title: string, link: BookingLinkDto | null) => (
    <LinkCard
      {...shared}
      title={title}
      owner={nameOf(target)}
      link={link}
      address={link ? addressOf(origin, link.path) : null}
      allLocationsText={allLocationsText(target)}
      hasOffer={target.professionalId !== null}
      onCreate={() => {
        setDialog({ kind: 'create', target });
      }}
      onEdit={() => {
        if (link) setDialog({ kind: 'edit', target, link });
      }}
      onToggle={(enabled) => {
        if (link) toggle.mutate({ link, enabled });
      }}
      onRegenerate={() => {
        if (link) setDialog({ kind: 'regenerate', target, link });
      }}
      onShowQr={() => {
        if (link) setDialog({ kind: 'qr', target, link });
      }}
      onCopy={() => {
        const address = link ? addressOf(origin, link.path) : null;
        if (address) void copy(address);
      }}
    />
  );

  return (
    <div className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('bookingAdmin:title')}</h2>
        <p className="text-sm text-muted-foreground">{t('bookingAdmin:description')}</p>
      </div>

      {readOnly ? (
        <Alert tone="info">
          <AlertDescription>{t('bookingAdmin:readOnly')}</AlertDescription>
        </Alert>
      ) : null}
      {refused ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, refused.error).message}</AlertDescription>
        </Alert>
      ) : null}

      {cardFor({ professionalId: null }, t('bookingAdmin:org.title'), organizationLink)}

      <section aria-labelledby="professionals-title" className="grid gap-3">
        <div className="grid gap-0.5">
          <h3 id="professionals-title" className="font-medium">
            {t('bookingAdmin:professionals.title')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('bookingAdmin:professionals.description')}
          </p>
        </div>
        {professionals.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('bookingAdmin:professionals.none')}</p>
        ) : (
          professionals.data.map((person) => (
            <div key={person.id}>
              {cardFor({ professionalId: person.id }, person.name, linkOf(person.id))}
            </div>
          ))
        )}
      </section>

      <RulesSection settings={settings.data} canEdit={canEditRules} readOnly={readOnly} />

      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <LinkDialog
          mode={dialog.kind}
          offers={dialog.target.professionalId !== null}
          name={nameOf(dialog.target)}
          types={types.data}
          locations={locations.data}
          initial={
            dialog.kind === 'edit'
              ? { typeIds: dialog.link.typeIds, locationIds: dialog.link.locationIds }
              : { typeIds: [], locationIds: [] }
          }
          locationsHelp={
            dialog.target.professionalId === null
              ? t('bookingAdmin:dialog.locationsHelpOrg')
              : t('bookingAdmin:dialog.locationsHelp')
          }
          pending={create.isPending || edit.isPending}
          error={
            create.isError || edit.isError
              ? describeError(t, create.error ?? edit.error).message
              : null
          }
          onSubmit={(choice) => {
            if (dialog.kind === 'create') create.mutate({ target: dialog.target, choice });
            else edit.mutate({ link: dialog.link, choice });
          }}
          onClose={() => {
            create.reset();
            edit.reset();
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.kind === 'qr' && addressOf(origin, dialog.link.path) ? (
        <QrDialog
          name={nameOf(dialog.target)}
          address={addressOf(origin, dialog.link.path) ?? ''}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}

      <AlertDialog
        open={dialog?.kind === 'regenerate'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bookingAdmin:regenerate.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('bookingAdmin:regenerate.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (dialog?.kind === 'regenerate') regenerate.mutate(dialog.link);
              }}
            >
              {t('bookingAdmin:regenerate.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
