import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { consentApi, consentKeys } from '../api/consent-api.js';

import { ConsentSigningForm } from './ConsentSigningForm.js';

/**
 * The signing of a request on the device of the organization (informed-consent, "In-person
 * signature"). It opens the version the request is bound to, shows its full text and records the
 * signature. The patient reads and signs; the member of the staff who is signed in only holds the
 * device. The request is read again from the server when the dialog opens, so an expired or an
 * already signed one says so instead of letting a signature through.
 */
export function SigningDialog({
  requestId,
  patientId,
  onClose,
}: {
  requestId: string;
  patientId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['consent', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();

  const view = useQuery({
    queryKey: consentKeys.signing(requestId),
    queryFn: () => consentApi(api).signingView(requestId),
    // The text on screen is the text that gets signed: never refresh it under the signer.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  const sign = useMutation({
    mutationFn: (request: Parameters<ReturnType<typeof consentApi>['sign']>[1]) =>
      consentApi(api).sign(requestId, request),
    onSuccess: async () => {
      toast.success(t('consent:signing.done'));
      await queryClient.invalidateQueries({ queryKey: consentKeys.patient(patientId) });
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('consent:signing.title')}</DialogTitle>
          <DialogDescription>{t('consent:signing.description')}</DialogDescription>
        </DialogHeader>
        {view.isPending ? <ListSkeleton rows={4} /> : null}
        {view.isError ? (
          <ErrorState
            error={view.error}
            onRetry={() => {
              void view.refetch();
            }}
          />
        ) : null}
        {view.isSuccess ? (
          <ConsentSigningForm
            view={view.data}
            submitting={sign.isPending}
            error={sign.error}
            onCancel={onClose}
            onSubmit={(request) => {
              sign.mutate(request);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
