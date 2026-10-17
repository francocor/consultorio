import type { OperatorTenantDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../shared/lib/form-errors.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
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

import { operatorApi } from './api/operator-api.js';

const Schema = z.object({
  ownerEmail: z.string().trim().min(1, 'validation.required').pipe(z.email().max(254)),
});
type Values = z.infer<typeof Schema>;

/** Sends the owner a fresh invitation link; the previous one stops working. */
export function ResendInvitationDialog({
  tenant,
  onClose,
}: {
  tenant: OperatorTenantDto | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { ownerEmail: '' },
  });

  const resend = useMutation({
    mutationFn: (values: Values) => {
      if (!tenant) throw new Error('no organization selected');
      return operatorApi(api).resendInvitation(tenant.id, values.ownerEmail);
    },
    onSuccess: (result, values) => {
      if (result.invitationSent) {
        toast.success(t('operator:resend.done', { email: values.ownerEmail }));
      } else {
        toast.warning(t('operator:resend.notSent'));
      }
      form.reset();
      onClose();
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });
  const failed = resend.isError && fieldErrorCount(resend.error) === 0;

  return (
    <Dialog
      open={tenant !== null}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          resend.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <Form {...form}>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                resend.mutate(values);
              })(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('operator:resend.title')}</DialogTitle>
              <DialogDescription>
                {t('operator:resend.description', { name: tenant?.name ?? '' })}
              </DialogDescription>
            </DialogHeader>
            {failed ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, resend.error).message}</AlertDescription>
              </Alert>
            ) : null}
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
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={resend.isPending}>
                {t('operator:resend.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
