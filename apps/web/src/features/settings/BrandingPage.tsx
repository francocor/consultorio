import {
  BRANDING_FONTS,
  BRANDING_PRESETS,
  BRANDING_RADII,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  type BrandingResponse,
} from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { BOOT_QUERY_KEY } from '../../app/boot.js';
import { RequirePermission } from '../../app/guards.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { fieldErrorCount, applyApiFieldErrors } from '../../shared/lib/form-errors.js';
import { rememberTheme } from '../../shared/lib/preferences.js';
import { themeToCssVariables } from '../../shared/lib/theme-boot.js';
import { describeError } from '../../shared/lib/translate.js';
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Badge } from '../../shared/ui/badge.js';
import { Button } from '../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../shared/ui/form.js';
import { Input, Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { brandingApi, brandingKeys } from './api/branding-api.js';

const HEX = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const Schema = z.object({
  displayName: z.string().trim().min(1).max(60),
  shortName: z.string().trim().min(1).max(16),
  primaryColor: z.string().trim().regex(HEX, 'settings.branding.error.color'),
  radius: z.enum(BRANDING_RADII),
  headingFont: z.enum(BRANDING_FONTS),
});
type Values = z.infer<typeof Schema>;

/** Settings > Identidad visual: name, color, corners, fonts and logo of the organization. */
export function BrandingPage() {
  return (
    <RequirePermission anyOf={['tenant.branding.manage']}>
      <Branding />
    </RequirePermission>
  );
}

function Branding() {
  const { t } = useTranslation('settings');
  usePageTitle(t('tab.branding'));
  const api = useApi();
  const current = useQuery({
    queryKey: brandingKeys.all,
    queryFn: () => brandingApi(api).get(),
  });

  if (current.isPending) return <FormSkeleton fields={5} />;
  if (current.isError) {
    return (
      <ErrorState
        error={current.error}
        onRetry={() => {
          void current.refetch();
        }}
      />
    );
  }
  return <BrandingEditor loaded={current.data} />;
}

function BrandingEditor({ loaded }: { loaded: BrandingResponse }) {
  const { t } = useTranslation(['settings', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [logoError, setLogoError] = useState<string | null>(null);
  const [saved, setSaved] = useState<BrandingResponse>(loaded);

  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: {
      displayName: saved.branding.displayName ?? '',
      shortName: saved.branding.shortName ?? '',
      primaryColor: saved.branding.primaryRequested,
      radius: saved.branding.radius,
      headingFont: saved.branding.headingFont,
    },
  });
  const color = useWatch({ control: form.control, name: 'primaryColor' });
  const radius = useWatch({ control: form.control, name: 'radius' });
  const headingFont = useWatch({ control: form.control, name: 'headingFont' });
  const displayName = useWatch({ control: form.control, name: 'displayName' });
  const debouncedColor = useDebouncedValue(color.trim(), 300);

  const unchanged = debouncedColor.toLowerCase() === saved.branding.primaryRequested.toLowerCase();
  const preview = useQuery({
    queryKey: brandingKeys.preview(debouncedColor),
    queryFn: () => brandingApi(api).preview(debouncedColor),
    enabled: HEX.test(debouncedColor) && !unchanged,
    staleTime: 5 * 60_000,
  });
  const contrast = unchanged ? saved.contrast : preview.data;

  /** The server answered with the identity now in force: show it, remember it, refresh the shell. */
  const applied = async (response: BrandingResponse) => {
    setSaved(response);
    rememberTheme({
      primary: response.branding.primaryEffective,
      primaryForeground: response.branding.primaryForeground,
      radius: response.branding.radius,
      headingFont: response.branding.headingFont,
    });
    queryClient.setQueryData(brandingKeys.all, response);
    await queryClient.invalidateQueries({ queryKey: BOOT_QUERY_KEY });
  };

  const save = useMutation({
    mutationFn: (values: Values) => brandingApi(api).update(values),
    onSuccess: async (response) => {
      toast.success(t('settings:branding.saved'));
      await applied(response);
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => brandingApi(api).uploadLogo(file),
    onSuccess: async (response) => {
      toast.success(t('settings:branding.logo.updated'));
      await applied(response);
    },
  });
  const removeLogo = useMutation({
    mutationFn: () => brandingApi(api).removeLogo(),
    onSuccess: async (response) => {
      toast.success(t('settings:branding.logo.removed'));
      await applied(response);
    },
  });

  function chooseLogo(file: File | undefined) {
    if (!file) return;
    if (!LOGO_TYPES.some((type) => type === file.type)) {
      setLogoError(t('settings:branding.logo.error.type'));
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(t('settings:branding.logo.error.size', { kb: LOGO_MAX_BYTES / 1024 }));
      return;
    }
    setLogoError(null);
    upload.mutate(file);
  }

  const failed = save.isError && fieldErrorCount(save.error) === 0;
  const effective = contrast?.effective ?? saved.branding.primaryEffective;
  const previewTheme = themeToCssVariables({
    primary: effective,
    primaryForeground: contrast?.foreground ?? saved.branding.primaryForeground,
    radius,
    headingFont,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Form {...form}>
        <form
          noValidate
          className="grid gap-5"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              save.mutate(values);
            })(event);
          }}
        >
          <div className="grid gap-1">
            <h2 className="font-display text-lg font-semibold">{t('settings:branding.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('settings:branding.description')}</p>
          </div>

          {failed ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
            </Alert>
          ) : null}

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('settings:branding.presets')}</legend>
            <div className="flex flex-wrap gap-2">
              {BRANDING_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  variant="outline"
                  aria-label={t('settings:branding.applyPreset', { name: preset.displayName })}
                  onClick={() => {
                    form.setValue('displayName', preset.displayName, { shouldDirty: true });
                    form.setValue('shortName', preset.shortName, { shouldDirty: true });
                    form.setValue('primaryColor', preset.primaryColor, { shouldDirty: true });
                    form.setValue('radius', preset.radius, { shouldDirty: true });
                    form.setValue('headingFont', preset.headingFont, { shouldDirty: true });
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="size-4 rounded-full border"
                    style={{ backgroundColor: preset.primaryColor }}
                  />
                  {preset.displayName}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings:branding.displayName')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>{t('settings:branding.displayNameHelp')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="shortName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings:branding.shortName')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>{t('settings:branding.shortNameHelp')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="primaryColor"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('settings:branding.color')}</FormLabel>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('settings:branding.colorPicker')}
                    className="size-11 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1"
                    value={
                      HEX.test(field.value) && field.value.length === 7 ? field.value : '#000000'
                    }
                    onChange={(event) => {
                      field.onChange(event.target.value);
                    }}
                  />
                  <FormControl>
                    <Input autoComplete="off" spellCheck={false} className="max-w-40" {...field} />
                  </FormControl>
                </div>
                <FormDescription>{t('settings:branding.colorHelp')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {contrast ? (
            <div aria-live="polite">
              {contrast.adjusted ? (
                <Alert tone="warning">
                  <AlertDescription className="grid gap-2">
                    <p>{t('settings:branding.contrast.adjusted')}</p>
                    <p className="flex flex-wrap items-center gap-3">
                      <span className="inline-flex items-center gap-1.5">
                        {t('settings:branding.contrast.requested')}
                        <Swatch color={contrast.requested} />
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        {t('settings:branding.contrast.effective')}
                        <Swatch color={contrast.effective} />
                      </span>
                    </p>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert tone="success">
                  <AlertDescription>
                    {t('settings:branding.contrast.ok', { ratio: contrast.ratio.toFixed(1) })}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="radius"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings:branding.radius')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      {BRANDING_RADII.map((option) => (
                        <option key={option} value={option}>
                          {t(`settings:branding.radius.${option}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="headingFont"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings:branding.font')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      {BRANDING_FONTS.map((option) => (
                        <option key={option} value={option}>
                          {t(`settings:branding.font.${option}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div>
            <Button type="submit" loading={save.isPending}>
              {t('settings:branding.save')}
            </Button>
          </div>
        </form>
      </Form>

      <div className="grid content-start gap-5">
        <section aria-labelledby="branding-preview" className="grid gap-2">
          <h3 id="branding-preview" className="text-sm font-medium">
            {t('settings:branding.preview')}
          </h3>
          <div
            style={previewTheme}
            className="grid gap-3 rounded-lg border bg-card p-4"
            data-testid="branding-preview"
          >
            <div className="flex items-center gap-3">
              {saved.branding.logoUrl ? (
                <img
                  src={saved.branding.logoUrl}
                  alt=""
                  className="size-10 rounded-md object-contain"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="grid size-10 place-content-center rounded-md bg-primary font-display font-semibold text-primary-foreground"
                >
                  {(displayName || '?').slice(0, 1).toUpperCase()}
                </span>
              )}
              <p className="font-display text-lg font-semibold">{displayName || '—'}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                {t('settings:branding.previewButton')}
              </span>
              <Badge tone="brand">{t('settings:branding.previewBadge')}</Badge>
            </div>
          </div>
        </section>

        <section aria-labelledby="branding-logo" className="grid gap-2">
          <h3 id="branding-logo" className="text-sm font-medium">
            {t('settings:branding.logo.title')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('settings:branding.logo.help', { kb: LOGO_MAX_BYTES / 1024 })}
          </p>
          {logoError ? (
            <Alert tone="danger">
              <AlertDescription>{logoError}</AlertDescription>
            </Alert>
          ) : null}
          {upload.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, upload.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Label
              htmlFor="branding-logo-file"
              className="touch-target-md inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground has-[:focus-visible]:outline-2"
            >
              <ImageUp className="size-4" aria-hidden="true" />
              {t('settings:branding.logo.upload')}
              <input
                id="branding-logo-file"
                type="file"
                accept={LOGO_TYPES.join(',')}
                className="sr-only"
                onChange={(event) => {
                  chooseLogo(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </Label>
            {saved.branding.logoUrl ? (
              <Button
                variant="ghost"
                loading={removeLogo.isPending}
                onClick={() => {
                  removeLogo.mutate();
                }}
              >
                <Trash2 aria-hidden="true" />
                {t('settings:branding.logo.remove')}
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-4 rounded-full border"
        style={{ backgroundColor: color }}
      />
      <span className="tabular font-medium">{color}</span>
    </span>
  );
}
