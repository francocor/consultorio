import { ADDENDUM_KINDS, type AddendumKind, type NoteDto } from '@consultorio/contracts';
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
import { Input, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { toast } from '../../../shared/ui/toaster.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';

interface AddendumDialogProps {
  note: NoteDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Adds an addendum to a signed note (clinical-records, "Addenda and corrections"): a kind, a
 * mandatory reason and the text. The original does not change. In a read-only organization only a
 * rectification asked for by the patient is offered (D16).
 */
export function AddendumDialog({ note, open, onOpenChange }: AddendumDialogProps) {
  const { t } = useTranslation(['clinical', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const textId = useId();
  const rectificationOnly = note.access.rectificationOnly;
  const [kind, setKind] = useState<AddendumKind>(
    rectificationOnly ? 'rectification' : 'correction',
  );
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);

  const add = useMutation({
    mutationFn: () => clinicalApi(api).addAddendum(note.id, { kind, reason, text }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(clinicalKeys.note(note.id), updated);
      await queryClient.invalidateQueries({ queryKey: clinicalKeys.timelineOf(note.patientId) });
      toast.success(t('clinical:dialog.addendum.done'));
      setReason('');
      setText('');
      setTouched(false);
      onOpenChange(false);
    },
  });

  const forbidden = isApiError(add.error) && add.error.status === 403;
  const reasonMissing = touched && reason.trim() === '';
  const textMissing = touched && text.trim() === '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('clinical:dialog.addendum.title')}</DialogTitle>
          <DialogDescription>{t('clinical:dialog.addendum.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (reason.trim() === '' || text.trim() === '') return;
            add.mutate();
          }}
        >
          {forbidden ? (
            <Alert tone="danger">
              <AlertDescription className="grid gap-1">
                <p className="font-medium">{t('clinical:dialog.forbidden.title')}</p>
                <p>{t('clinical:dialog.forbidden.description')}</p>
              </AlertDescription>
            </Alert>
          ) : add.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, add.error).message}</AlertDescription>
            </Alert>
          ) : null}

          <RadioGroup
            value={kind}
            onValueChange={(value) => {
              setKind(ADDENDUM_KINDS.find((candidate) => candidate === value) ?? 'correction');
            }}
            aria-label={t('clinical:dialog.addendum.kind')}
          >
            {ADDENDUM_KINDS.map((option) => (
              <RadioCard
                key={option}
                value={option}
                title={t(`clinical:dialog.addendum.kind.${option}`)}
                {...(option === 'rectification'
                  ? { description: t('clinical:dialog.addendum.kind.rectification.help') }
                  : {})}
                disabled={rectificationOnly && option !== 'rectification'}
              />
            ))}
          </RadioGroup>

          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>{t('clinical:dialog.addendum.reason')}</Label>
            <Input
              id={reasonId}
              autoComplete="off"
              maxLength={500}
              value={reason}
              aria-invalid={reasonMissing || undefined}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            {reasonMissing ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('common:validation.required')}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={textId}>{t('clinical:dialog.addendum.text')}</Label>
            <Textarea
              id={textId}
              rows={4}
              maxLength={4000}
              value={text}
              aria-invalid={textMissing || undefined}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
            {textMissing ? (
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
            <Button type="submit" loading={add.isPending}>
              {t('clinical:dialog.addendum.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
