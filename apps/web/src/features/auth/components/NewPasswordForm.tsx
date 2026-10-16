import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { applyApiFieldErrors } from '../../../shared/lib/form-errors.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';

import { PasswordHints } from './PasswordHints.js';
import { PasswordInput } from './PasswordInput.js';

const Schema = z
  .object({
    password: z.string().min(1),
    confirm: z.string().min(1),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'auth.password.mismatch',
  });
type Values = z.infer<typeof Schema>;

/**
 * Two password fields with the hints of the policy. Used to set a password from a recovery link
 * and to accept an invitation. The server has the last word: its rejection (a common password...)
 * is shown next to the field.
 */
export function NewPasswordForm({
  passwordLabel,
  submitLabel,
  pending,
  onSubmit,
}: {
  passwordLabel: string;
  submitLabel: string;
  pending: boolean;
  /** Resolves when the server answered; a rejection with field errors is placed on the form. */
  onSubmit: (password: string) => Promise<void>;
}) {
  const { t } = useTranslation('auth');
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { password: '', confirm: '' },
  });
  const password = useWatch({ control: form.control, name: 'password' });
  const { setFocus } = form;
  useEffect(() => {
    setFocus('password');
  }, [setFocus]);

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(async (values) => {
            try {
              await onSubmit(values.password);
            } catch (error) {
              // Anything that is not about a field is shown by the page; it stays on the form.
              if (applyApiFieldErrors(form, error)) form.setFocus('password');
            }
          })(event);
        }}
      >
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{passwordLabel}</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <PasswordHints value={password} />
        <FormField
          control={form.control}
          name="confirm"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('password.confirm')}</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" loading={pending} className="w-full">
          {submitLabel}
        </Button>
      </form>
    </Form>
  );
}
