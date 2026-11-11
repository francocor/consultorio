import { MANUAL_VIDEO_LINK_MAX_LENGTH } from '@consultorio/contracts';
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
import { Input } from '../../../shared/ui/input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { videoApi, videoKeys } from '../api/video-api.js';

const FormValues = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'teleconsultation.manual_link.not_a_link')
    .max(MANUAL_VIDEO_LINK_MAX_LENGTH, 'teleconsultation.manual_link.not_a_link'),
});
type FormValues = z.infer<typeof FormValues>;

/**
 * Attaches the address of a call the person created elsewhere, for the appointments whose room the
 * platform could not create. The platform decides whether the address is acceptable (https and an
 * allowed host); the dialog shows its answer next to the field.
 */
export function ManualLinkDialog({
  appointmentId,
  onClose,
}: {
  appointmentId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['teleconsultation', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormValues),
    defaultValues: { url: '' },
  });

  const attach = useMutation({
    mutationFn: (values: FormValues) => videoApi(api).attachManualLink(appointmentId, values.url),
    onSuccess: async () => {
      toast.success(t('teleconsultation:manual.done'));
      await queryClient.invalidateQueries({ queryKey: videoKeys.all });
      onClose();
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('teleconsultation:manual.title')}</DialogTitle>
          <DialogDescription>{t('teleconsultation:manual.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                attach.mutate(values);
              })(event);
            }}
          >
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('teleconsultation:manual.url')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder={t('teleconsultation:manual.placeholder')}
                    />
                  </FormControl>
                  <FormDescription>{t('teleconsultation:manual.hint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {attach.isError && fieldErrorCount(attach.error) === 0 ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, attach.error).message}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={attach.isPending}>
                {t('teleconsultation:manual.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
