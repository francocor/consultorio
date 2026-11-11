import { BRANDING_PRESETS, type BrandingPreset } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { BOOT_QUERY_KEY, useBoot } from '../../../app/boot.js';
import { useApi } from '../../../app/providers.js';
import { rememberTheme } from '../../../shared/lib/preferences.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { brandingApi, brandingKeys } from '../../settings/api/branding-api.js';
import { StepFooter } from '../components/StepFooter.js';

import type { StepProps } from './types.js';

/** The longest short name the API accepts. */
const SHORT_NAME_MAX = 16;

function shortNameOf(displayName: string): string {
  return displayName.slice(0, SHORT_NAME_MAX).trim();
}

/** Optional: the name and the look the organization shows. Skipping keeps the neutral default. */
export function BrandingStep({ next, skip, back }: StepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const boot = useBoot();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(boot?.name ?? '');
  const [presetId, setPresetId] = useState<BrandingPreset['id']>(BRANDING_PRESETS[0].id);
  const [nameError, setNameError] = useState(false);

  const save = useMutation({
    mutationFn: (preset: BrandingPreset) =>
      brandingApi(api).update({
        displayName: displayName.trim(),
        shortName: shortNameOf(displayName.trim()),
        primaryColor: preset.primaryColor,
        radius: preset.radius,
        headingFont: preset.headingFont,
      }),
    onSuccess: async (response) => {
      rememberTheme({
        primary: response.branding.primaryEffective,
        primaryForeground: response.branding.primaryForeground,
        radius: response.branding.radius,
        headingFont: response.branding.headingFont,
      });
      queryClient.setQueryData(brandingKeys.all, response);
      await queryClient.invalidateQueries({ queryKey: BOOT_QUERY_KEY });
      await next('done');
    },
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (displayName.trim() === '') {
      setNameError(true);
      return;
    }
    setNameError(false);
    const preset = BRANDING_PRESETS.find((candidate) => candidate.id === presetId);
    if (preset) save.mutate(preset);
  }

  return (
    <form noValidate className="grid gap-5" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">{t('onboarding:branding.description')}</p>
      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="branding-name">{t('onboarding:branding.name')}</Label>
        <Input
          id="branding-name"
          maxLength={60}
          value={displayName}
          aria-invalid={nameError || undefined}
          aria-describedby={nameError ? 'branding-name-error' : undefined}
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />
        {nameError ? (
          <p id="branding-name-error" className="text-sm font-medium text-destructive">
            {t('common:validation.required')}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <span id="branding-style" className="text-sm font-medium">
          {t('onboarding:branding.style')}
        </span>
        <RadioGroup
          aria-labelledby="branding-style"
          value={presetId}
          onValueChange={(value) => {
            const chosen = BRANDING_PRESETS.find((candidate) => candidate.id === value);
            if (chosen) setPresetId(chosen.id);
          }}
          className="grid gap-2 sm:grid-cols-2"
        >
          {BRANDING_PRESETS.map((preset) => (
            <RadioCard
              key={preset.id}
              value={preset.id}
              title={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-4 shrink-0 rounded-full border"
                    style={{ backgroundColor: preset.primaryColor }}
                  />
                  {t(`onboarding:branding.preset.${preset.id}`)}
                </span>
              }
            />
          ))}
        </RadioGroup>
      </div>

      <StepFooter
        onBack={back}
        pending={save.isPending}
        onSkip={
          skip
            ? () => {
                void skip();
              }
            : undefined
        }
      />
    </form>
  );
}
