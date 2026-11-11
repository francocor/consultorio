import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../shared/lib/form-errors.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { CheckboxCard } from '../../shared/ui/checkbox-card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog.js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../shared/ui/form.js';
import { Input } from '../../shared/ui/input.js';
import { toast } from '../../shared/ui/toaster.js';

import { operatorApi, operatorKeys } from './api/operator-api.js';

const Schema = z.object({
  name: z.string().trim().min(2, 'validation.too_short').max(60),
  ownerEmail: z.string().trim().min(1, 'validation.required').pipe(z.email().max(254)),
  isDemo: z.boolean(),
});
type Values = z.infer<typeof Schema>;

/** Creates an organization and invites its owner. The demo flag is fixed here and never changes. */
export function CreateTenantDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { name: '', ownerEmail: '', isDemo: false },
  });

  const create = useMutation({
    mutationFn: (values: Values) => operatorApi(api).createTenant(values),
    onSuccess: async (result, values) => {
      if (result.invitationSent) {
        toast.success(t('operator:create.done', { email: values.ownerEmail }));
      } else {
        toast.warning(t('operator:create.notSent'));
      }
      form.reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: operatorKeys.tenants });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });
  const failed = create.isError && fieldErrorCount(create.error) === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          create.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <Form {...form}>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                create.mutate(values);
              })(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('operator:create.title')}</DialogTitle>
              <DialogDescription>{t('operator:create.description')}</DialogDescription>
            </DialogHeader>
            {failed ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('operator:create.name')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ownerEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('operator:create.ownerEmail')}</FormLabel>
                  <FormControl>
                    <Input type="email" inputMode="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isDemo"
              render={({ field }) => (
                <CheckboxCard
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  title={t('operator:create.demo')}
                  description={t('operator:create.demoHelp')}
                />
              )}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('operator:create.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
