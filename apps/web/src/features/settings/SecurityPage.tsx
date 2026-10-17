import {
  CLINICAL_TEMPLATE_KINDS,
  DEFAULT_SHARED_TEMPLATES,
  type ClinicalTemplateKind,
  type SettingsDto,
  type UpdateSettingsRequest,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { describeError } from '../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { CheckboxCard } from '../../shared/ui/checkbox-card.js';
import { Switch } from '../../shared/ui/checkbox.js';
import { Input } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { settingsApi, settingsKeys } from './api/settings-api.js';

type Confirmation = 'require2fa-on' | 'require2fa-off' | 'psychology' | null;

/** Settings > Seguridad: the policies of the organization. Owners and administrators only. */
export function SecurityPage() {
  return (
    <RequirePermission anyOf={['tenant.settings.manage']}>
      <Security />
    </RequirePermission>
  );
}

function Security() {
  const { t } = useTranslation('settings');
  usePageTitle(t('tab.security'));
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
  return <SecurityPolicies settings={settings.data} />;
}

function SecurityPolicies({ settings }: { settings: SettingsDto }) {
  const { t } = useTranslation(['settings', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Confirmation>(null);
  const [quiet, setQuiet] = useState(settings.quietHours);

  const save = useMutation({
    mutationFn: (patch: UpdateSettingsRequest) => settingsApi(api).update(patch),
    onSuccess: (updated) => {
      toast.success(t('settings:security.saved'));
      setConfirming(null);
      setQuiet(updated.quietHours);
      queryClient.setQueryData(settingsKeys.all, updated);
    },
    onError: () => {
      setConfirming(null);
    },
  });

  const toggleSharing = (on: boolean) => {
    save.mutate({ clinicalSharing: on });
  };
  const toggleTemplate = (kind: ClinicalTemplateKind, on: boolean) => {
    if (on && kind === 'psychology') {
      setConfirming('psychology');
      return;
    }
    const next = on
      ? [...settings.sharedTemplates, kind]
      : settings.sharedTemplates.filter((current) => current !== kind);
    save.mutate({ sharedTemplates: next });
  };
  const quietChanged =
    quiet.start !== settings.quietHours.start || quiet.end !== settings.quietHours.end;

  return (
    <div className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('settings:security.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings:security.description')}</p>
      </div>

      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <Policy
        id="policy-2fa"
        title={t('settings:security.require2fa.title')}
        description={t('settings:security.require2fa.description')}
        checked={settings.require2fa}
        onCheckedChange={(on) => {
          setConfirming(on ? 'require2fa-on' : 'require2fa-off');
        }}
      />

      <Policy
        id="policy-reception"
        title={t('settings:security.reception.title')}
        description={t('settings:security.reception.description')}
        checked={settings.receptionSeesClinicalMetadata}
        onCheckedChange={(on) => {
          save.mutate({ receptionSeesClinicalMetadata: on });
        }}
      />

      <Policy
        id="policy-sharing"
        title={t('settings:security.sharing.title')}
        description={t('settings:security.sharing.description')}
        checked={settings.clinicalSharing}
        onCheckedChange={toggleSharing}
      >
        {settings.clinicalSharing ? (
          <fieldset className="mt-3 grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('settings:security.templates')}</legend>
            {CLINICAL_TEMPLATE_KINDS.map((kind) => (
              <CheckboxCard
                key={kind}
                checked={settings.sharedTemplates.includes(kind)}
                onCheckedChange={(on) => {
                  toggleTemplate(kind, on);
                }}
                title={t(`settings:security.template.${kind}`)}
                description={
                  kind === 'psychology' ? t('settings:security.template.psychologyHelp') : undefined
                }
              />
            ))}
          </fieldset>
        ) : null}
      </Policy>

      <section aria-labelledby="policy-quiet" className="rounded-lg border bg-card p-4">
        <h3 id="policy-quiet" className="font-medium">
          {t('settings:security.quiet.title')}
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t('settings:security.quiet.description')}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="quiet-start">{t('settings:security.quiet.start')}</Label>
            <Input
              id="quiet-start"
              type="time"
              value={quiet.start}
              onChange={(event) => {
                setQuiet({ ...quiet, start: event.target.value });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="quiet-end">{t('settings:security.quiet.end')}</Label>
            <Input
              id="quiet-end"
              type="time"
              value={quiet.end}
              onChange={(event) => {
                setQuiet({ ...quiet, end: event.target.value });
              }}
            />
          </div>
          <Button
            variant="outline"
            disabled={!quietChanged}
            loading={save.isPending && save.variables.quietHours !== undefined}
            onClick={() => {
              save.mutate({ quietHours: quiet });
            }}
          >
            {t('settings:security.quiet.save')}
          </Button>
        </div>
      </section>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === 'psychology'
                ? t('settings:security.psychology.title')
                : confirming === 'require2fa-off'
                  ? t('settings:security.require2fa.off.title')
                  : t('settings:security.require2fa.on.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === 'psychology'
                ? t('settings:security.psychology.description')
                : confirming === 'require2fa-off'
                  ? t('settings:security.require2fa.off.description')
                  : t('settings:security.require2fa.on.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (confirming === 'psychology') {
                  const base =
                    settings.sharedTemplates.length > 0
                      ? settings.sharedTemplates
                      : [...DEFAULT_SHARED_TEMPLATES];
                  save.mutate({
                    sharedTemplates: [...base, 'psychology'],
                    confirmPsychologySharing: true,
                  });
                } else {
                  save.mutate({ require2fa: confirming === 'require2fa-on' });
                }
              }}
            >
              {confirming === 'psychology'
                ? t('settings:security.psychology.confirm')
                : confirming === 'require2fa-off'
                  ? t('settings:security.require2fa.off.confirm')
                  : t('settings:security.require2fa.on.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Policy({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <h3 id={`${id}-title`} className="font-medium">
            {title}
          </h3>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <Switch
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
      {children}
    </section>
  );
}
