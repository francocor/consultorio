import type { ConsentRequestDto, CreateConsentRequestResponse } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { consentApi, consentKeys } from '../api/consent-api.js';

import { ErrorAlert } from './ErrorAlert.js';

type Method = 'in_person' | 'portal';

/**
 * Asks a patient for a consent: which template (the latest published version of it) and how it is
 * signed, on this device or from the portal. The list holds the titles of the templates because the
 * person who asks has to choose; it is not a list linked to a patient. After an in-person request
 * the caller opens the signing; after a portal one the dialog says whether the patient was told by
 * email (the message carries no title).
 */
export function RequestConsentDialog({
  patientId,
  onClose,
  onRequested,
}: {
  patientId: string;
  onClose: () => void;
  /** An in-person request: the caller opens the signing of this request. */
  onRequested: (request: ConsentRequestDto) => void;
}) {
  const { t } = useTranslation(['consent', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState('');
  const [method, setMethod] = useState<Method>('in_person');

  const offered = useQuery({
    queryKey: consentKeys.offered,
    queryFn: () => consentApi(api).offered(),
  });

  const create = useMutation({
    mutationFn: () => consentApi(api).request({ patientId, templateId, method }),
    onSuccess: async (response: CreateConsentRequestResponse) => {
      await queryClient.invalidateQueries({ queryKey: consentKeys.patient(patientId) });
      if (response.request.method === 'in_person') {
        onRequested(response.request);
        return;
      }
      if (response.notice === 'sent') toast.success(t('consent:request.created.sent'));
      else toast.warning(t('consent:request.created.notSent'));
      onClose();
    },
  });

  const templates = offered.data?.templates ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('consent:request.title')}</DialogTitle>
          <DialogDescription>{t('consent:request.description')}</DialogDescription>
        </DialogHeader>
        {offered.isPending ? <ListSkeleton rows={2} /> : null}
        {offered.isError ? <ErrorAlert error={offered.error} /> : null}
        {offered.isSuccess ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending && templateId !== '') create.mutate();
            }}
          >
            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('consent:request.empty')}</p>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="request-template">{t('consent:request.template')}</Label>
                <Select
                  id="request-template"
                  value={templateId}
                  onChange={(event) => {
                    setTemplateId(event.target.value);
                  }}
                >
                  <option value="">{t('consent:request.templatePlaceholder')}</option>
                  {templates.map((template) => (
                    <option key={template.templateId} value={template.templateId}>
                      {template.title}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t('consent:request.method')}</legend>
              <RadioGroup
                value={method}
                onValueChange={(value) => {
                  setMethod(value === 'portal' ? 'portal' : 'in_person');
                }}
                aria-label={t('consent:request.method')}
              >
                <RadioCard
                  value="in_person"
                  title={t('consent:request.method.in_person')}
                  description={t('consent:request.method.in_person.description')}
                />
                <RadioCard
                  value="portal"
                  title={t('consent:request.method.portal')}
                  description={t('consent:request.method.portal.description')}
                />
              </RadioGroup>
            </fieldset>
            <ErrorAlert error={create.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending} disabled={templateId === ''}>
                {t('consent:request.submit')}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
