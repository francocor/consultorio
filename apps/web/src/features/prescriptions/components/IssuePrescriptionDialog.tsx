import { MAX_PRESCRIPTION_ITEMS, type PrescriptionDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
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
import { Input, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { prescriptionKeys, prescriptionsApi } from '../api/prescriptions-api.js';
import {
  EMPTY_ITEM,
  createSubmissionKeys,
  missingFields,
  requestItems,
  signatureOf,
  type ItemDraft,
  type ItemField,
} from '../domain/forms.js';

import { ErrorAlert, serverFieldMessage } from './ErrorAlert.js';
import { GenericNameField } from './GenericNameField.js';

interface Row {
  /** Identifies the row while it is on screen (the text of its fields changes). */
  id: string;
  draft: ItemDraft;
}

const newRow = (draft: ItemDraft = EMPTY_ITEM): Row => ({ id: crypto.randomUUID(), draft });

function rowsOf(prescription: PrescriptionDto | undefined): Row[] {
  if (!prescription) return [newRow()];
  return prescription.items.map((item) =>
    newRow({
      genericName: item.genericName,
      dose: item.dose,
      form: item.form,
      quantity: String(item.quantity),
      instructions: item.instructions,
    }),
  );
}

/**
 * The form of a prescription (e-prescription, "Prescription content"): one or more medications by
 * generic name with dose, form, quantity and instructions. The patient, the prescriber, the date and
 * the coverage are not asked: the server takes them from their records. The request carries a key that
 * follows what is sent, so a double click is one prescription.
 *
 * With `correcting` it corrects a prescription the provider refused and sends it again.
 */
export function IssuePrescriptionDialog({
  patientId,
  correcting,
  onClose,
}: {
  patientId: string;
  correcting?: PrescriptionDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['prescriptions', 'common']);
  // The messages the server gives for a field are keys of the common catalog (`validation.*`).
  const { t: common } = useTranslation('common');
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;
  const [rows, setRows] = useState<Row[]>(() => rowsOf(correcting));
  const [attempted, setAttempted] = useState(false);

  const send = useMutation({
    mutationFn: () => {
      const items = requestItems(rows.map((row) => row.draft));
      if (!items) throw new Error('the prescription is incomplete');
      return correcting
        ? prescriptionsApi(api).correct(correcting.id, { items })
        : prescriptionsApi(api).issue({
            clientKey: keys.keyFor(
              signatureOf(
                patientId,
                rows.map((row) => row.draft),
              ),
            ),
            patientId,
            items,
          });
    },
    onSuccess: async (result) => {
      keys.done();
      if (result.status === 'issued') toast.success(t('prescriptions:issue.issued'));
      else if (result.status === 'draft') toast.warning(t('prescriptions:issue.refused'));
      else toast.warning(t('prescriptions:issue.pending'));
      await queryClient.invalidateQueries({ queryKey: prescriptionKeys.all });
      onClose();
    },
  });

  const change = (id: string, field: ItemField, value: string) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id ? { ...row, draft: { ...row.draft, [field]: value } } : row,
      ),
    );
  };

  const errorOf = (index: number, row: Row, field: ItemField): string | null => {
    const fromServer = serverFieldMessage(send.error, `items.${String(index)}.${field}`, common);
    if (fromServer) return fromServer;
    if (!attempted || !missingFields(row.draft).includes(field)) return null;
    return field === 'quantity'
      ? t('prescriptions:form.error.quantity')
      : t('prescriptions:form.error.required');
  };

  const submit = () => {
    setAttempted(true);
    if (requestItems(rows.map((row) => row.draft)) && !send.isPending) send.mutate();
  };

  const field = (
    index: number,
    row: Row,
    name: Exclude<ItemField, 'genericName'>,
    label: string,
    control: (props: {
      id: string;
      'aria-invalid': true | undefined;
      'aria-describedby': string | undefined;
    }) => ReactNode,
  ) => {
    const id = `rx-${row.id}-${name}`;
    const error = errorOf(index, row, name);
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {control({
          id,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': error ? `${id}-error` : undefined,
        })}
        {error ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {correcting ? t('prescriptions:issue.correctTitle') : t('prescriptions:issue.title')}
          </DialogTitle>
          <DialogDescription>
            {correcting
              ? t('prescriptions:issue.correctDescription')
              : t('prescriptions:issue.description')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {rows.map((row, index) => {
            const genericError = errorOf(index, row, 'genericName');
            const genericId = `rx-${row.id}-genericName`;
            return (
              <fieldset key={row.id} className="grid gap-3 rounded-lg border bg-card p-3">
                <legend className="px-1 text-sm font-medium">
                  {t('prescriptions:form.medication', { number: index + 1 })}
                </legend>
                <GenericNameField
                  id={genericId}
                  label={t('prescriptions:form.genericName')}
                  value={row.draft.genericName}
                  invalid={genericError !== null}
                  describedBy={genericError ? `${genericId}-error` : undefined}
                  onChange={(value) => {
                    change(row.id, 'genericName', value);
                  }}
                />
                {genericError ? (
                  <p id={`${genericId}-error`} className="-mt-2 text-sm text-destructive">
                    {genericError}
                  </p>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-3">
                  {field(index, row, 'dose', t('prescriptions:form.dose'), (props) => (
                    <Input
                      {...props}
                      maxLength={60}
                      placeholder={t('prescriptions:form.dosePlaceholder')}
                      value={row.draft.dose}
                      onChange={(event) => {
                        change(row.id, 'dose', event.target.value);
                      }}
                    />
                  ))}
                  {field(
                    index,
                    row,
                    'form',
                    t('prescriptions:form.pharmaceuticalForm'),
                    (props) => (
                      <Input
                        {...props}
                        maxLength={60}
                        placeholder={t('prescriptions:form.formPlaceholder')}
                        value={row.draft.form}
                        onChange={(event) => {
                          change(row.id, 'form', event.target.value);
                        }}
                      />
                    ),
                  )}
                  {field(index, row, 'quantity', t('prescriptions:form.quantity'), (props) => (
                    <Input
                      {...props}
                      inputMode="numeric"
                      maxLength={3}
                      value={row.draft.quantity}
                      onChange={(event) => {
                        change(row.id, 'quantity', event.target.value);
                      }}
                    />
                  ))}
                </div>
                {field(
                  index,
                  row,
                  'instructions',
                  t('prescriptions:form.instructions'),
                  (props) => (
                    <Textarea
                      {...props}
                      rows={2}
                      maxLength={300}
                      placeholder={t('prescriptions:form.instructionsPlaceholder')}
                      value={row.draft.instructions}
                      onChange={(event) => {
                        change(row.id, 'instructions', event.target.value);
                      }}
                    />
                  ),
                )}
                {rows.length > 1 ? (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRows((current) => current.filter((entry) => entry.id !== row.id));
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      {t('prescriptions:form.remove', { number: index + 1 })}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            );
          })}

          {rows.length < MAX_PRESCRIPTION_ITEMS ? (
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRows((current) => [...current, newRow()]);
                }}
              >
                <Plus aria-hidden="true" />
                {t('prescriptions:form.add')}
              </Button>
            </div>
          ) : null}

          <p className="text-sm text-muted-foreground">{t('prescriptions:form.autoFilled')}</p>
          <ErrorAlert error={send.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={send.isPending}>
              {correcting
                ? t('prescriptions:issue.correctSubmit')
                : t('prescriptions:issue.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
