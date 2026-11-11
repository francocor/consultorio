import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input } from '../../../shared/ui/input.js';
import {
  NO_PREFERENCES,
  PreferencesFields,
  preferencesProblem,
  type Preferences,
} from '../../waitlist/index.js';

/** The form of the public join, as the visitor fills it (the request is shaped from it). */
export const JoinFormSchema = z
  .object({
    givenNames: z.string().trim().min(1).max(80),
    familyName: z.string().trim().min(1).max(80),
    documentNumber: z
      .string()
      .trim()
      .refine((value) => /^\d{7,8}$/.test(value.replace(/[.\s]/g, '')), 'booking.document_invalid'),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'booking.birth_date_invalid'),
    email: z.string().trim().pipe(z.email().max(254)),
    phone: z
      .string()
      .trim()
      .max(30)
      .regex(/^[0-9+()\-\s.]*$/, 'validation.format'),
    whatsapp: z.boolean(),
    optIn: z.boolean().refine((accepted) => accepted, 'waitlist.opt_in_required'),
    consent: z.boolean().refine((accepted) => accepted, 'waitlist.consent_required'),
  })
  .superRefine((value, context) => {
    if (value.whatsapp && value.phone.replace(/\D/g, '') === '') {
      context.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'booking.phone_required_for_whatsapp',
      });
    }
  });

export type JoinFormValues = z.infer<typeof JoinFormSchema>;

const EMPTY: JoinFormValues = {
  givenNames: '',
  familyName: '',
  documentNumber: '',
  birthDate: '',
  email: '',
  phone: '',
  whatsapp: false,
  optIn: false,
  consent: false,
};

export interface JoinFormProps {
  /** Sends the form with the preferences chosen. A rejected request is shown on the fields it names. */
  onSubmit: (values: JoinFormValues, preferences: Preferences) => Promise<void>;
  /** Called once when the form opens, so the bot challenge is solved while the visitor types. */
  onOpen?: () => void;
  pending: boolean;
  /** What the last attempt failed with, if it did. */
  error: unknown;
  /** What was typed before, when the visitor comes back from the code step. */
  defaults?: { values: JoinFormValues; preferences: Preferences } | undefined;
}

/**
 * The form to join the waitlist: when the visitor can come, who they are, and the agreement to be
 * written to. The agreement to receive offers and the data-processing consent are boxes of their
 * own, never ticked for the person. Nothing clinical is asked.
 */
export function JoinForm({ onSubmit, onOpen, pending, error, defaults }: JoinFormProps) {
  const { t } = useTranslation(['waitlist', 'booking', 'common']);
  const [preferences, setPreferences] = useState<Preferences>(
    defaults?.preferences ?? NO_PREFERENCES,
  );
  const form = useForm<JoinFormValues>({
    resolver: zodResolver(JoinFormSchema),
    defaultValues: defaults?.values ?? EMPTY,
  });
  const { setFocus } = form;
  useEffect(() => {
    onOpen?.();
    setFocus('givenNames');
    // Only when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The fields the API refused (a document that fails the country rules, a minor) show where they are.
  useEffect(() => {
    if (error) {
      applyApiFieldErrors(form, error, {
        document: 'documentNumber',
        dataProcessingConsent: 'consent',
      });
    }
  }, [error, form]);

  const generalError = error && fieldErrorCount(error) === 0 ? describeError(t, error) : null;
  const whatsapp = useWatch({ control: form.control, name: 'whatsapp' });
  const problem = preferencesProblem(preferences);

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem !== null) return;
          void form.handleSubmit(async (values) => {
            await onSubmit(values, preferences);
          })(event);
        }}
      >
        {generalError ? (
          <Alert tone="danger">
            <AlertDescription>{generalError.message}</AlertDescription>
          </Alert>
        ) : null}

        <section aria-labelledby="join-when" className="grid gap-3">
          <h2 id="join-when" className="font-display text-lg font-semibold">
            {t('waitlist:join.when.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('waitlist:join.when.description')}</p>
          <PreferencesFields value={preferences} onChange={setPreferences} idPrefix="join" />
        </section>

        <section aria-labelledby="join-who" className="grid gap-4">
          <h2 id="join-who" className="font-display text-lg font-semibold">
            {t('waitlist:join.who.title')}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="givenNames"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('booking:field.givenNames')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="given-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="familyName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('booking:field.familyName')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="family-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={form.control}
            name="documentNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('booking:field.documentNumber')}</FormLabel>
                <FormControl>
                  <Input inputMode="numeric" autoComplete="off" {...field} />
                </FormControl>
                <FormDescription>{t('booking:field.documentHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="birthDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('booking:field.birthDate')}</FormLabel>
                <FormControl>
                  <Input type="date" autoComplete="bday" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('booking:field.email')}</FormLabel>
                <FormControl>
                  <Input type="email" inputMode="email" autoComplete="email" {...field} />
                </FormControl>
                <FormDescription>{t('waitlist:join.emailHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('booking:field.phone')}</FormLabel>
                <FormControl>
                  <Input type="tel" inputMode="tel" autoComplete="tel" {...field} />
                </FormControl>
                <FormDescription>{t('waitlist:join.phoneHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <CheckboxCard
            checked={whatsapp}
            onCheckedChange={(checked) => {
              form.setValue('whatsapp', checked, { shouldValidate: form.formState.isSubmitted });
            }}
            title={t('waitlist:join.whatsapp.title')}
            description={t('waitlist:join.whatsapp.hint')}
          />
        </section>

        <section aria-labelledby="join-agree" className="grid gap-3">
          <h2 id="join-agree" className="font-display text-lg font-semibold">
            {t('waitlist:join.agree.title')}
          </h2>
          <FormField
            control={form.control}
            name="optIn"
            render={({ field }) => (
              <FormItem>
                <CheckboxCard
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  title={t('waitlist:join.agree.offers')}
                  description={t('waitlist:join.agree.offersHint')}
                />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="consent"
            render={({ field }) => (
              <FormItem>
                <CheckboxCard
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  title={t('waitlist:join.agree.consent')}
                />
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <Button type="submit" size="lg" loading={pending} disabled={problem !== null}>
          {pending ? t('waitlist:join.submitting') : t('waitlist:join.submit')}
        </Button>
      </form>
    </Form>
  );
}
