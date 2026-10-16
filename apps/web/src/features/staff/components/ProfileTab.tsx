import {
  AR_JURISDICTIONS,
  type ProfessionalDto,
  type StaffMemberDto,
} from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff, X } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../api/staff-api.js';

const NATIONAL = AR_JURISDICTIONS.national;

const Schema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    specialties: z.array(z.string()).min(1, 'staff.profile.noSpecialties').max(10),
    jurisdiction: z.string(),
    matriculaNumber: z.string().trim(),
    maxSimultaneous: z.number().int().min(1).max(20),
  })
  .superRefine((values, ctx) => {
    if (values.jurisdiction !== '' && values.matriculaNumber === '') {
      ctx.addIssue({ code: 'custom', path: ['matriculaNumber'], message: 'validation.required' });
    }
  });
type Values = z.infer<typeof Schema>;

/** The profile of a health professional: name, disciplines, registration and simultaneous visits. */
export function ProfileTab({ member }: { member: StaffMemberDto }) {
  const { t } = useTranslation(['staff', 'common']);
  const api = useApi();
  const isProfessional = member.roles.includes('professional');

  const profile = useQuery({
    queryKey: staffKeys.profile(member.membershipId),
    queryFn: async (): Promise<ProfessionalDto | null> => {
      try {
        return await staffApi(api).profile(member.membershipId);
      } catch (error) {
        // A professional who has not filled the profile yet has none: that is a blank form.
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    enabled: isProfessional,
  });

  if (!isProfessional) {
    return (
      <Alert tone="info">
        <AlertDescription>{t('staff:profile.notProfessional')}</AlertDescription>
      </Alert>
    );
  }
  if (profile.isPending) return <FormSkeleton fields={3} />;
  if (profile.isError) {
    return (
      <ErrorState
        error={profile.error}
        onRetry={() => {
          void profile.refetch();
        }}
      />
    );
  }
  return <ProfileForm member={member} profile={profile.data} />;
}

function ProfileForm({
  member,
  profile,
}: {
  member: StaffMemberDto;
  profile: ProfessionalDto | null;
}) {
  const { t } = useTranslation(['staff', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: {
      fullName: profile?.fullName ?? member.displayName ?? '',
      specialties: profile?.specialties ?? [],
      jurisdiction: profile?.matricula?.jurisdiction ?? '',
      matriculaNumber: profile?.matricula?.number ?? '',
      maxSimultaneous: profile?.maxSimultaneous ?? 1,
    },
  });
  const specialties = useWatch({ control: form.control, name: 'specialties' });
  const jurisdiction = useWatch({ control: form.control, name: 'jurisdiction' });

  const save = useMutation({
    mutationFn: (values: Values) =>
      staffApi(api).saveProfile(member.membershipId, {
        fullName: values.fullName,
        specialties: values.specialties,
        matricula:
          values.jurisdiction === ''
            ? null
            : { jurisdiction: values.jurisdiction, number: values.matriculaNumber },
        maxSimultaneous: values.maxSimultaneous,
      }),
    onSuccess: async () => {
      toast.success(t('staff:profile.saved'));
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, {
        matricula: 'matriculaNumber',
        specialties: 'specialties',
      });
    },
  });

  function addSpecialty() {
    const name = draft.trim();
    if (name === '') return;
    const known = specialties.some((current) => current.toLowerCase() === name.toLowerCase());
    if (!known) form.setValue('specialties', [...specialties, name], { shouldValidate: true });
    setDraft('');
  }

  const generalFailure = save.isError && fieldErrorCount(save.error) === 0;

  return (
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
          <h3 className="font-display text-base font-semibold">{t('staff:profile.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('staff:profile.description')}</p>
        </div>

        {generalFailure ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('staff:profile.fullName')}</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="specialties"
          render={() => (
            <FormItem>
              <span className="text-sm font-medium">{t('staff:profile.specialties')}</span>
              <FormDescription>{t('staff:profile.specialtiesHelp')}</FormDescription>
              <ul className="flex flex-wrap gap-2">
                {specialties.map((name) => (
                  <li
                    key={name}
                    className="inline-flex items-center gap-1 rounded-md bg-secondary py-1 pl-3 pr-1 text-sm font-medium"
                  >
                    {name}
                    <button
                      type="button"
                      aria-label={t('staff:profile.removeSpecialty', { name })}
                      onClick={() => {
                        form.setValue(
                          'specialties',
                          specialties.filter((current) => current !== name),
                          { shouldValidate: form.formState.isSubmitted },
                        );
                      }}
                      className="grid size-7 cursor-pointer place-content-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Input
                  aria-label={t('staff:profile.specialtyInput')}
                  value={draft}
                  maxLength={80}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addSpecialty();
                    }
                  }}
                />
                <Button variant="outline" onClick={addSpecialty}>
                  {t('staff:profile.addSpecialty')}
                </Button>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="jurisdiction"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('staff:profile.jurisdiction')}</FormLabel>
                <FormControl>
                  <Select {...field}>
                    <option value="">{t('staff:profile.jurisdictionNone')}</option>
                    <option value={NATIONAL}>{t('staff:profile.jurisdictionNational')}</option>
                    {AR_JURISDICTIONS.provincial.map((place) => (
                      <option key={place.code} value={place.code}>
                        {place.name}
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
            name="matriculaNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('staff:profile.matriculaNumber')}</FormLabel>
                <FormControl>
                  <Input inputMode="numeric" disabled={jurisdiction === ''} {...field} />
                </FormControl>
                <FormDescription>{t('staff:profile.matriculaNumberHelp')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {profile?.matricula ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {profile.matricula.status === 'verified' ? (
              <StatusBadge status="verified">
                {t('staff:profile.matriculaStatus.verified')}
              </StatusBadge>
            ) : (
              <StatusBadge status="unverified" />
            )}
          </p>
        ) : null}

        <FormField
          control={form.control}
          name="maxSimultaneous"
          render={({ field }) => (
            <FormItem className="max-w-40">
              <FormLabel>{t('staff:profile.maxSimultaneous')}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={field.value}
                  onChange={(event) => {
                    field.onChange(event.target.valueAsNumber);
                  }}
                />
              </FormControl>
              <FormDescription>{t('staff:profile.maxSimultaneousHelp')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          {profile?.clinicalAccess ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <ShieldOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          {profile?.clinicalAccess
            ? t('staff:profile.clinicalAccess')
            : t('staff:profile.noClinicalAccess')}
        </p>

        <Button type="submit" loading={save.isPending} className="justify-self-start">
          {t('staff:profile.save')}
        </Button>
      </form>
    </Form>
  );
}
