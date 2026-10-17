import { MAX_BOOKING_REASON_LENGTH } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
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
import { Input, Textarea } from '../../../shared/ui/input.js';

/** The form of the public booking, as the visitor fills it (the request is shaped from it). */
export const BookingFormSchema = z
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
    whatsappOptIn: z.boolean(),
    reason: z.string().trim().max(MAX_BOOKING_REASON_LENGTH),
    consent: z.boolean().refine((accepted) => accepted, 'booking.consent_required'),
  })
  .superRefine((value, context) => {
    if (value.whatsappOptIn && value.phone.replace(/\D/g, '') === '') {
      context.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'booking.phone_required_for_whatsapp',
      });
    }
  });

export type BookingFormValues = z.infer<typeof BookingFormSchema>;

const EMPTY: BookingFormValues = {
  givenNames: '',
  familyName: '',
  documentNumber: '',
  birthDate: '',
  email: '',
  phone: '',
  whatsappOptIn: false,
  reason: '',
  consent: false,
};

export interface BookingFormProps {
  /** Sends the form. A rejected request is shown on the fields it names. */
  onSubmit: (values: BookingFormValues) => Promise<void>;
  /** Called once when the form opens, so the bot challenge can be solved while the visitor types. */
  onOpen?: () => void;
  pending: boolean;
  /** What the last attempt failed with, if it did. */
  error: unknown;
  /** What was typed before, when the visitor comes back from the code step. */
  defaults?: BookingFormValues | undefined;
  onValues?: (values: BookingFormValues) => void;
}

/**
 * The booking form: only what is needed to book, no clinical question. The WhatsApp choice is a
 * separate box, never ticked by default; the optional reason warns not to write health details. The
 * bot challenge is invisible: it is solved in the background and sent with the form.
 */
export function BookingForm({
  onSubmit,
  onOpen,
  pending,
  error,
  defaults,
  onValues,
}: BookingFormProps) {
  const { t } = useTranslation(['booking', 'common']);
  const form = useForm<BookingFormValues>({
    resolver: zodResolver(BookingFormSchema),
    defaultValues: defaults ?? EMPTY,
  });
  const { setFocus, setError } = form;
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
  }, [error, form, setError]);

  const generalError = error && fieldErrorCount(error) === 0 ? describeError(t, error) : null;
  const whatsappTicked = useWatch({ control: form.control, name: 'whatsappOptIn' });

  return (
    <section aria-labelledby="details-title" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="details-title" className="font-display text-lg font-semibold">
          {t('booking:details.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('booking:details.description')}</p>
      </div>

      {generalError ? (
        <Alert tone="danger">
          <AlertDescription>{generalError.message}</AlertDescription>
        </Alert>
      ) : null}

      <Form {...form}>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            void form.handleSubmit(async (values) => {
              onValues?.(values);
              await onSubmit(values);
            })(event);
          }}
        >
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
                <FormDescription>{t('booking:field.emailHint')}</FormDescription>
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
                <FormDescription>{t('booking:field.phoneHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <CheckboxCard
            checked={whatsappTicked}
            onCheckedChange={(checked) => {
              form.setValue('whatsappOptIn', checked, {
                shouldValidate: form.formState.isSubmitted,
              });
            }}
            title={t('booking:field.whatsapp')}
            description={t('booking:field.whatsappHint')}
          />

          <FormField
            control={form.control}
            name="reason"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('booking:field.reason')}</FormLabel>
                <FormControl>
                  <Textarea rows={3} maxLength={MAX_BOOKING_REASON_LENGTH} {...field} />
                </FormControl>
                <FormDescription>{t('booking:field.reasonHint')}</FormDescription>
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
                  title={t('booking:field.consent')}
                />
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" size="lg" loading={pending}>
            {pending ? t('booking:details.sending') : t('booking:details.submit')}
          </Button>
        </form>
      </Form>
    </section>
  );
}
