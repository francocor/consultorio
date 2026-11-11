import type { DocumentDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Textarea } from '../../../shared/ui/input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { documentKeys, documentsApi } from '../api/documents-api.js';

const Schema = z.object({ reason: z.string().trim().min(1, 'validation.required').max(300) });
type Values = z.infer<typeof Schema>;

/**
 * Hides a document that was uploaded by mistake. The reason is mandatory and the file stays: this
 * is not a delete, and the dialog says so.
 */
export function HideDialog({
  document,
  onOpenChange,
}: {
  /** The document to hide; the dialog is open while this is set. */
  document: DocumentDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['documents', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { reason: '' } });

  const hide = useMutation({
    mutationFn: (values: Values) => {
      if (!document) throw new Error('no document to hide');
      return documentsApi(api).hide(document.id, values.reason);
    },
    onSuccess: async () => {
      toast.success(t('documents:hide.done'));
      form.reset();
      onOpenChange(false);
      if (document) {
        await queryClient.invalidateQueries({ queryKey: documentKeys.patient(document.patientId) });
      }
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { reason: 'reason' });
    },
  });
  const failed = hide.isError && fieldErrorCount(hide.error) === 0;

  return (
    <Dialog
      open={document !== null}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          hide.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('documents:hide.title')}</DialogTitle>
          <DialogDescription>
            {t('documents:hide.description', { name: document?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                hide.mutate(values);
              })(event);
            }}
          >
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('documents:hide.reason')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} maxLength={300} {...field} />
                  </FormControl>
                  <FormDescription>{t('documents:hide.reasonHelp')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {failed ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, hide.error).message}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('documents:hide.cancel')}
              </Button>
              <Button type="submit" loading={hide.isPending}>
                {t('documents:hide.confirm')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
