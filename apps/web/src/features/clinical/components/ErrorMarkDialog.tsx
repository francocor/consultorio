import type { NoteDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
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
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';

interface ErrorMarkDialogProps {
  note: NoteDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Marks an entry as entered in error (clinical-records, "Addenda and corrections"): the reason is
 * mandatory, the content stays, and the entry leaves the default timeline.
 */
export function ErrorMarkDialog({ note, open, onOpenChange }: ErrorMarkDialogProps) {
  const { t } = useTranslation(['clinical', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const mark = useMutation({
    mutationFn: () => clinicalApi(api).markError(note.id, { reason }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(clinicalKeys.note(note.id), updated);
      await queryClient.invalidateQueries({ queryKey: clinicalKeys.timelineOf(note.patientId) });
      await queryClient.invalidateQueries({ queryKey: clinicalKeys.drafts });
      toast.success(t('clinical:dialog.error.done'));
      setReason('');
      setTouched(false);
      onOpenChange(false);
    },
  });

  const forbidden = isApiError(mark.error) && mark.error.status === 403;
  const missing = touched && reason.trim() === '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('clinical:dialog.error.title')}</DialogTitle>
          <DialogDescription>{t('clinical:dialog.error.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (reason.trim() === '') return;
            mark.mutate();
          }}
        >
          {forbidden ? (
            <Alert tone="danger">
              <AlertDescription className="grid gap-1">
                <p className="font-medium">{t('clinical:dialog.forbidden.title')}</p>
                <p>{t('clinical:dialog.forbidden.description')}</p>
              </AlertDescription>
            </Alert>
          ) : mark.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, mark.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>{t('clinical:dialog.error.reason')}</Label>
            <Input
              id={reasonId}
              autoComplete="off"
              maxLength={500}
              value={reason}
              aria-invalid={missing || undefined}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            {missing ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('common:validation.required')}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('clinical:dialog.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={mark.isPending}>
              {t('clinical:dialog.error.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
