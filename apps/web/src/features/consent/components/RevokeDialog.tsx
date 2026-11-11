import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { consentApi, consentKeys } from '../api/consent-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Records a revocation the patient asked for in person (informed-consent, "Revocation"). The
 * original signature stays; the revocation is a new entry with the user who recorded it and the
 * reason, if there is one. It works in a read-only organization too: withdrawing a consent protects
 * the patient.
 */
export function RevokeDialog({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const { t } = useTranslation(['consent', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const revoke = useMutation({
    mutationFn: () =>
      consentApi(api).revoke(requestId, reason.trim() === '' ? {} : { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t('consent:revoke.done'));
      await queryClient.invalidateQueries({ queryKey: consentKeys.all });
      onClose();
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
          <DialogTitle>{t('consent:revoke.title')}</DialogTitle>
          <DialogDescription>{t('consent:revoke.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!revoke.isPending) revoke.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="revoke-reason">{t('consent:revoke.reason')}</Label>
            <Textarea
              id="revoke-reason"
              value={reason}
              maxLength={500}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p className="text-sm text-muted-foreground">{t('consent:revoke.reasonHint')}</p>
          </div>
          <ErrorAlert error={revoke.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={revoke.isPending}>
              {t('consent:revoke.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
