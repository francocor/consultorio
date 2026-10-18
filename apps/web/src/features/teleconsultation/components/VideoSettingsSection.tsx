import { TeleconsultationSettings, type SettingsDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Switch } from '../../../shared/ui/checkbox.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { settingsKey, videoSettingsApi } from '../api/video-api.js';

/**
 * Settings > Turnos > Videoconsulta: the integration switch of the organization (leaving it off
 * sends every virtual appointment to a manual link) and the two times of the join window. It
 * shows in the scheduling settings, next to the appointment types it applies to.
 */
export function VideoSettingsSection() {
  const api = useApi();
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => videoSettingsApi(api).get(),
  });

  if (settings.isPending) return <FormSkeleton fields={3} />;
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
  return <VideoSettings settings={settings.data} />;
}

type Field = 'joinOpensMinutes' | 'noShowAfterMinutes';

const BOUNDS: Record<Field, { min: number; max: number }> = {
  joinOpensMinutes: { min: 0, max: 120 },
  noShowAfterMinutes: { min: 1, max: 120 },
};

/** A whole number of minutes inside the bounds of the contract, or `null`. */
function minutesOf(text: string, field: Field): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const parsed = TeleconsultationSettings.shape[field].safeParse(Number(text));
  return parsed.success ? parsed.data : null;
}

function VideoSettings({ settings }: { settings: SettingsDto }) {
  const { t } = useTranslation(['teleconsultation']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [text, setText] = useState<Record<Field, string>>({
    joinOpensMinutes: String(settings.teleconsultation.joinOpensMinutes),
    noShowAfterMinutes: String(settings.teleconsultation.noShowAfterMinutes),
  });
  const [invalid, setInvalid] = useState<Partial<Record<Field, true>>>({});

  const save = useMutation({
    mutationFn: (patch: Parameters<ReturnType<typeof videoSettingsApi>['update']>[0]) =>
      videoSettingsApi(api).update(patch),
    onSuccess: (updated) => {
      toast.success(t('teleconsultation:settings.saved'));
      queryClient.setQueryData(settingsKey, updated);
      setText({
        joinOpensMinutes: String(updated.teleconsultation.joinOpensMinutes),
        noShowAfterMinutes: String(updated.teleconsultation.noShowAfterMinutes),
      });
    },
  });

  const changed = (Object.keys(BOUNDS) as Field[]).some(
    (field) => text[field] !== String(settings.teleconsultation[field]),
  );

  const submit = () => {
    const joinOpens = minutesOf(text.joinOpensMinutes, 'joinOpensMinutes');
    const noShowAfter = minutesOf(text.noShowAfterMinutes, 'noShowAfterMinutes');
    const problems: Partial<Record<Field, true>> = {
      ...(joinOpens === null ? { joinOpensMinutes: true as const } : {}),
      ...(noShowAfter === null ? { noShowAfterMinutes: true as const } : {}),
    };
    setInvalid(problems);
    if (joinOpens === null || noShowAfter === null) return;
    save.mutate({
      teleconsultation: { joinOpensMinutes: joinOpens, noShowAfterMinutes: noShowAfter },
    });
  };

  const enabled = settings.integrations.video;

  return (
    <section aria-labelledby="video-settings-title" className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h2 id="video-settings-title" className="font-display text-lg font-semibold">
          {t('teleconsultation:settings.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('teleconsultation:settings.description')}
        </p>
      </div>

      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-0.5">
            <h3 id="video-integration-title" className="font-medium">
              {t('teleconsultation:settings.integration.title')}
            </h3>
            <p id="video-integration-description" className="text-sm text-muted-foreground">
              {t('teleconsultation:settings.integration.description')}
            </p>
          </div>
          <Switch
            aria-labelledby="video-integration-title"
            aria-describedby="video-integration-description"
            checked={enabled}
            disabled={save.isPending}
            onCheckedChange={(on) => {
              save.mutate({ integrations: { video: on } });
            }}
          />
        </div>
        <p className="mt-3 text-sm font-medium">
          {enabled
            ? t('teleconsultation:settings.integration.on')
            : t('teleconsultation:settings.integration.off')}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h3 className="font-medium">{t('teleconsultation:settings.window.title')}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t('teleconsultation:settings.window.hint')}
        </p>
        <div className="mt-3 flex flex-wrap items-start gap-3">
          {(Object.keys(BOUNDS) as Field[]).map((field) => (
            <div key={field} className="grid max-w-xs gap-1.5">
              <Label htmlFor={`video-${field}`}>
                {t(
                  `teleconsultation:settings.${field === 'joinOpensMinutes' ? 'joinOpens' : 'noShowAfter'}`,
                )}
              </Label>
              <Input
                id={`video-${field}`}
                type="number"
                inputMode="numeric"
                min={BOUNDS[field].min}
                max={BOUNDS[field].max}
                value={text[field]}
                aria-invalid={invalid[field] ? true : undefined}
                aria-describedby={invalid[field] ? `video-${field}-error` : undefined}
                onChange={(event) => {
                  setText({ ...text, [field]: event.target.value });
                  setInvalid({ ...invalid, [field]: undefined });
                }}
              />
              {invalid[field] ? (
                <p
                  id={`video-${field}-error`}
                  role="alert"
                  className="text-sm font-medium text-destructive"
                >
                  {t(`teleconsultation:settings.error.${field}`)}
                </p>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Button
            variant="outline"
            disabled={!changed}
            loading={save.isPending && save.variables.teleconsultation !== undefined}
            onClick={submit}
          >
            {t('teleconsultation:settings.save')}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t('teleconsultation:settings.privacy')}</p>
    </section>
  );
}
