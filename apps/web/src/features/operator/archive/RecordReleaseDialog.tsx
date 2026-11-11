import {
  ARCHIVE_RELEASE_REQUESTER_KINDS,
  type ArchiveReleaseRequesterKind,
  type OperatorTenantDto,
  type RecordArchiveReleaseRequest,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
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
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';

import { archiveApi, archiveKeys } from './archive-api.js';

interface Values {
  organization: string;
  requesterKind: ArchiveReleaseRequesterKind;
  requesterName: string;
  requesterEmail: string;
  documentType: string;
  document: string;
  matriculaJurisdiction: string;
  matricula: string;
  reason: string;
}

const EMPTY: Values = {
  organization: '',
  requesterKind: 'patient',
  requesterName: '',
  requesterEmail: '',
  documentType: 'dni',
  document: '',
  matriculaJurisdiction: '',
  matricula: '',
  reason: '',
};

function bodyOf(values: Values): RecordArchiveReleaseRequest {
  const common = {
    organization: values.organization,
    requesterName: values.requesterName,
    requesterEmail: values.requesterEmail,
    reason: values.reason,
  };
  return values.requesterKind === 'patient'
    ? {
        ...common,
        requesterKind: 'patient',
        documentType: values.documentType,
        document: values.document,
      }
    : {
        ...common,
        requesterKind: 'professional',
        matriculaJurisdiction: values.matriculaJurisdiction,
        matricula: values.matricula,
      };
}

/**
 * Records a request to release archived records. The kind decides what finds the requester in the
 * archive: a patient by document, a professional by registration. The address is where the link will
 * go, and nowhere else, so the operator confirms it with the requester before they verify the identity.
 */
export function RecordReleaseDialog({
  organizations,
  onClose,
}: {
  organizations: readonly OperatorTenantDto[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['export', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const idBase = useId();
  const [values, setValues] = useState<Values>(EMPTY);
  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const patient = values.requesterKind === 'patient';
  const filled =
    values.organization !== '' &&
    values.requesterName.trim().length >= 2 &&
    values.requesterEmail.trim() !== '' &&
    values.reason.trim().length >= 5 &&
    (patient
      ? values.document.trim() !== '' && values.documentType.trim() !== ''
      : values.matricula.trim() !== '' && values.matriculaJurisdiction.trim() !== '');

  const record = useMutation({
    mutationFn: () => archiveApi(api).record(bodyOf(values)),
    onSuccess: async () => {
      toast.success(t('export:operator.recordDialog.done'));
      await queryClient.invalidateQueries({ queryKey: archiveKeys.requests });
      onClose();
    },
  });

  const field = (name: keyof Values) => `${idBase}-${name}`;

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
            if (filled) record.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('export:operator.recordDialog.title')}</DialogTitle>
            <DialogDescription>{t('export:operator.recordDialog.description')}</DialogDescription>
          </DialogHeader>
          {record.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, record.error).message}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor={field('organization')}>
              {t('export:operator.recordDialog.organization')}
            </Label>
            <Select
              id={field('organization')}
              value={values.organization}
              onChange={(event) => {
                set('organization', event.target.value);
              }}
            >
              <option value="">{t('export:operator.recordDialog.chooseOrganization')}</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={field('requesterKind')}>{t('export:operator.recordDialog.kind')}</Label>
            <Select
              id={field('requesterKind')}
              value={values.requesterKind}
              onChange={(event) => {
                set(
                  'requesterKind',
                  event.target.value === 'professional' ? 'professional' : 'patient',
                );
              }}
            >
              {ARCHIVE_RELEASE_REQUESTER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`export:operator.requests.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={field('requesterName')}>{t('export:operator.recordDialog.name')}</Label>
            <Input
              id={field('requesterName')}
              autoComplete="off"
              value={values.requesterName}
              onChange={(event) => {
                set('requesterName', event.target.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={field('requesterEmail')}>{t('export:operator.dialog.email')}</Label>
            <Input
              id={field('requesterEmail')}
              type="email"
              inputMode="email"
              autoComplete="off"
              value={values.requesterEmail}
              onChange={(event) => {
                set('requesterEmail', event.target.value);
              }}
            />
          </div>

          {patient ? (
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <div className="grid gap-2">
                <Label htmlFor={field('documentType')}>
                  {t('export:operator.recordDialog.documentType')}
                </Label>
                <Input
                  id={field('documentType')}
                  autoComplete="off"
                  value={values.documentType}
                  onChange={(event) => {
                    set('documentType', event.target.value);
                  }}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={field('document')}>
                  {t('export:operator.recordDialog.document')}
                </Label>
                <Input
                  id={field('document')}
                  autoComplete="off"
                  inputMode="numeric"
                  value={values.document}
                  onChange={(event) => {
                    set('document', event.target.value);
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <div className="grid gap-2">
                <Label htmlFor={field('matriculaJurisdiction')}>
                  {t('export:operator.recordDialog.jurisdiction')}
                </Label>
                <Input
                  id={field('matriculaJurisdiction')}
                  autoComplete="off"
                  placeholder={t('export:operator.recordDialog.jurisdictionPlaceholder')}
                  value={values.matriculaJurisdiction}
                  onChange={(event) => {
                    set('matriculaJurisdiction', event.target.value);
                  }}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={field('matricula')}>
                  {t('export:operator.recordDialog.matricula')}
                </Label>
                <Input
                  id={field('matricula')}
                  autoComplete="off"
                  value={values.matricula}
                  onChange={(event) => {
                    set('matricula', event.target.value);
                  }}
                />
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor={field('reason')}>{t('export:operator.recordDialog.reason')}</Label>
            <Textarea
              id={field('reason')}
              rows={3}
              maxLength={500}
              value={values.reason}
              onChange={(event) => {
                set('reason', event.target.value);
              }}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" disabled={!filled} loading={record.isPending}>
              {t('export:operator.recordDialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
