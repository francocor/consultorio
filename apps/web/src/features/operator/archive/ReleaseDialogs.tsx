import { ARCHIVE_RELEASE_CHECKLIST } from '@consultorio/contracts';
import type { ArchiveReleaseRequestDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
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

import { archiveApi, archiveKeys } from './archive-api.js';

type Checklist = Record<(typeof ARCHIVE_RELEASE_CHECKLIST)[number], boolean>;

const EMPTY_CHECKLIST: Checklist = {
  documentChecked: false,
  photoMatches: false,
  contactConfirmed: false,
  entitlementChecked: false,
};

/** The requester in words, so the operator confirms exactly who they checked. */
function Requester({ request }: { request: ArchiveReleaseRequestDto }) {
  const { t } = useTranslation('export');
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <dt className="text-muted-foreground">{t('operator.requests.col.requester')}</dt>
      <dd className="font-medium">{request.requesterName}</dd>
      <dt className="text-muted-foreground">{t('operator.dialog.email')}</dt>
      <dd className="break-all">{request.requesterEmail}</dd>
      <dt className="text-muted-foreground">{t('operator.requests.col.scope')}</dt>
      <dd className="tabular">{request.scope}</dd>
    </dl>
  );
}

/**
 * The identity of the requester, verified OUT OF BAND: the operator saw the document, the face
 * matched, the address was confirmed and the entitlement was checked. Every box has to be ticked; the
 * server refuses anything less, and a different operator approves afterwards.
 */
export function VerifyIdentityDialog({
  request,
  onClose,
}: {
  request: ArchiveReleaseRequestDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['export', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const idBase = useId();
  const [checklist, setChecklist] = useState<Checklist>(EMPTY_CHECKLIST);
  const complete = ARCHIVE_RELEASE_CHECKLIST.every((item) => checklist[item]);

  const verify = useMutation({
    mutationFn: () =>
      archiveApi(api).verifyIdentity(request.id, {
        documentChecked: true,
        photoMatches: true,
        contactConfirmed: true,
        entitlementChecked: true,
      }),
    onSuccess: async () => {
      toast.success(t('export:operator.verifyDialog.done'));
      await queryClient.invalidateQueries({ queryKey: archiveKeys.requests });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) verify.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('export:operator.verifyDialog.title')}</DialogTitle>
            <DialogDescription>{t('export:operator.verifyDialog.description')}</DialogDescription>
          </DialogHeader>
          <Requester request={request} />
          {verify.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, verify.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <fieldset className="grid gap-3">
            <legend className="sr-only">{t('export:operator.verifyDialog.title')}</legend>
            {ARCHIVE_RELEASE_CHECKLIST.map((item) => (
              <div key={item} className="flex items-start gap-3">
                <Checkbox
                  id={`${idBase}-${item}`}
                  checked={checklist[item]}
                  onCheckedChange={(next) => {
                    setChecklist((current) => ({ ...current, [item]: next === true }));
                  }}
                />
                <Label htmlFor={`${idBase}-${item}`} className="font-normal leading-snug">
                  {t(`export:operator.verifyDialog.item.${item}`)}
                </Label>
              </div>
            ))}
          </fieldset>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" disabled={!complete} loading={verify.isPending}>
              {t('export:operator.verifyDialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Closes a request that will not be carried out, with the reason, which the trail keeps. */
export function RejectDialog({
  request,
  onClose,
}: {
  request: ArchiveReleaseRequestDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['export', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const long = reason.trim().length >= 5;

  const reject = useMutation({
    mutationFn: () => archiveApi(api).reject(request.id, { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t('export:operator.rejectDialog.done'));
      await queryClient.invalidateQueries({ queryKey: archiveKeys.requests });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (long) reject.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('export:operator.rejectDialog.title')}</DialogTitle>
            <DialogDescription>{t('export:operator.rejectDialog.description')}</DialogDescription>
          </DialogHeader>
          <Requester request={request} />
          {reject.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, reject.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor={reasonId}>{t('export:operator.rejectDialog.reason')}</Label>
            <Textarea
              id={reasonId}
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!long} loading={reject.isPending}>
              {t('export:operator.rejectDialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
