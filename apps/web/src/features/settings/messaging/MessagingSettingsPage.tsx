import type { SettingsDto, UpdateSettingsRequest } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { useApi } from '../../../app/providers.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Switch } from '../../../shared/ui/checkbox.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { settingsApi, settingsKeys } from '../api/settings-api.js';

import { validateLeadTimes } from './domain/lead-times.js';
import { UsageSection } from './UsageSection.js';

const MAX_REMINDERS = 3;

/** Settings > Mensajes: when reminders go out, what they say, and WhatsApp. Owners and administrators. */
export function MessagingSettingsPage() {
  return (
    <RequirePermission anyOf={['notifications.manage']}>
      <Messaging />
    </RequirePermission>
  );
}

function Messaging() {
  const { t } = useTranslation('messaging');
  usePageTitle(t('title'));
  const api = useApi();
  const settings = useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => settingsApi(api).get(),
  });

  if (settings.isPending) return <FormSkeleton fields={4} />;
  if (settings.isError) {
    return (
      <ErrorState
        error={settings.error}
        onRetry={() => {
          void settings.refetch();
        }}
      />
    );
  }
  return <MessagingForm settings={settings.data} />;
}

interface Draft {
  leads: string[];
  quietStart: string;
  quietEnd: string;
  hideProfessional: boolean;
  hideAppointmentType: boolean;
  whatsapp: boolean;
}

function draftOf(settings: SettingsDto): Draft {
  return {
    leads: settings.notifications.reminderLeadHours.map(String),
    quietStart: settings.quietHours.start,
    quietEnd: settings.quietHours.end,
    hideProfessional: settings.notifications.hideProfessional,
    hideAppointmentType: settings.notifications.hideAppointmentType,
    whatsapp: settings.integrations.whatsapp,
  };
}

/** Only what changed, so an audited setting is not rewritten by saving another one. */
function patchOf(
  settings: SettingsDto,
  draft: Draft,
  hours: readonly number[],
): UpdateSettingsRequest | null {
  const notifications: NonNullable<UpdateSettingsRequest['notifications']> = {};
  const current = settings.notifications;
  if (hours.join(',') !== current.reminderLeadHours.join(',')) {
    notifications.reminderLeadHours = [...hours];
  }
  if (draft.hideProfessional !== current.hideProfessional) {
    notifications.hideProfessional = draft.hideProfessional;
  }
  if (draft.hideAppointmentType !== current.hideAppointmentType) {
    notifications.hideAppointmentType = draft.hideAppointmentType;
  }
  const patch: UpdateSettingsRequest = {};
  if (Object.keys(notifications).length > 0) patch.notifications = notifications;
  if (
    draft.quietStart !== settings.quietHours.start ||
    draft.quietEnd !== settings.quietHours.end
  ) {
    patch.quietHours = { start: draft.quietStart, end: draft.quietEnd };
  }
  if (draft.whatsapp !== settings.integrations.whatsapp) {
    patch.integrations = { whatsapp: draft.whatsapp };
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function MessagingForm({ settings }: { settings: SettingsDto }) {
  const { t } = useTranslation(['messaging', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(settings));
  const [attempted, setAttempted] = useState(false);

  const leads = validateLeadTimes(draft.leads);
  // Dirty even when a field is wrong: saving then shows what is wrong instead of doing nothing.
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
  const quietMissing = draft.quietStart === '' || draft.quietEnd === '';

  const save = useMutation({
    mutationFn: (body: UpdateSettingsRequest) => settingsApi(api).update(body),
    onSuccess: (updated) => {
      toast.success(t('messaging:saved'));
      setDraft(draftOf(updated));
      setAttempted(false);
      queryClient.setQueryData(settingsKeys.all, updated);
    },
  });

  const submit = () => {
    setAttempted(true);
    if (!leads.hours || quietMissing) return;
    const body = patchOf(settings, draft, leads.hours);
    if (body) save.mutate(body);
  };

  const setLead = (index: number, value: string) => {
    setDraft({ ...draft, leads: draft.leads.map((lead, at) => (at === index ? value : lead)) });
  };

  return (
    <form
      className="grid max-w-3xl gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('messaging:title')}</h2>
        <p className="text-sm text-muted-foreground">{t('messaging:description')}</p>
      </div>

      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <Section
        id="reminders"
        title={t('messaging:reminders.title')}
        description={t('messaging:reminders.description')}
      >
        {draft.leads.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('messaging:reminders.none')}</p>
        ) : null}
        <ul className="grid gap-3">
          {draft.leads.map((lead, index) => {
            const error = attempted ? leads.errors[index] : null;
            const id = `lead-${String(index)}`;
            return (
              <li key={id} className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={id}>{t('messaging:reminders.lead', { n: index + 1 })}</Label>
                  <Input
                    id={id}
                    inputMode="numeric"
                    className="w-32"
                    value={lead}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : `${id}-help`}
                    onChange={(event) => {
                      setLead(index, event.target.value);
                    }}
                  />
                  {error ? (
                    <p id={`${id}-error`} className="text-sm text-destructive">
                      {t(error)}
                    </p>
                  ) : (
                    <p id={`${id}-help`} className="text-xs text-muted-foreground">
                      {t('messaging:reminders.help')}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDraft({ ...draft, leads: draft.leads.filter((_, at) => at !== index) });
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  <span className="sr-only">
                    {t('messaging:reminders.remove', { n: index + 1 })}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
        {draft.leads.length < MAX_REMINDERS ? (
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft({ ...draft, leads: [...draft.leads, ''] });
              }}
            >
              <Plus aria-hidden="true" />
              {t('messaging:reminders.add')}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section
        id="quiet"
        title={t('messaging:quiet.title')}
        description={t('messaging:quiet.description')}
      >
        <div className="flex flex-wrap items-start gap-3">
          <TimeField
            id="messaging-quiet-start"
            label={t('messaging:quiet.start')}
            value={draft.quietStart}
            error={
              attempted && draft.quietStart === '' ? t('messaging:quiet.error.required') : null
            }
            onChange={(value) => {
              setDraft({ ...draft, quietStart: value });
            }}
          />
          <TimeField
            id="messaging-quiet-end"
            label={t('messaging:quiet.end')}
            value={draft.quietEnd}
            error={attempted && draft.quietEnd === '' ? t('messaging:quiet.error.required') : null}
            onChange={(value) => {
              setDraft({ ...draft, quietEnd: value });
            }}
          />
        </div>
      </Section>

      <Section
        id="wording"
        title={t('messaging:wording.title')}
        description={t('messaging:wording.description')}
      >
        <Toggle
          id="hide-professional"
          title={t('messaging:wording.hideProfessional')}
          description={t('messaging:wording.hideProfessionalHelp')}
          checked={draft.hideProfessional}
          onCheckedChange={(on) => {
            setDraft({ ...draft, hideProfessional: on });
          }}
        />
        <Toggle
          id="hide-type"
          title={t('messaging:wording.hideType')}
          description={t('messaging:wording.hideTypeHelp')}
          checked={draft.hideAppointmentType}
          onCheckedChange={(on) => {
            setDraft({ ...draft, hideAppointmentType: on });
          }}
        />
      </Section>

      <Section
        id="whatsapp"
        title={t('messaging:whatsapp.title')}
        description={t('messaging:whatsapp.description')}
      >
        <Toggle
          id="whatsapp-switch"
          title={t('messaging:whatsapp.switch')}
          checked={draft.whatsapp}
          onCheckedChange={(on) => {
            setDraft({ ...draft, whatsapp: on });
          }}
        />
      </Section>

      <div>
        <Button type="submit" disabled={!dirty} loading={save.isPending}>
          {save.isPending ? t('messaging:saving') : t('messaging:save')}
        </Button>
      </div>

      <UsageSection />
    </form>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="grid gap-0.5">
        <h3 id={`${id}-title`} className="font-medium">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function TimeField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="time"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Toggle({
  id,
  title,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-0.5">
        <p id={`${id}-title`} className="text-sm font-medium">
          {title}
        </p>
        {description ? (
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        aria-labelledby={`${id}-title`}
        {...(description ? { 'aria-describedby': `${id}-description` } : {})}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
