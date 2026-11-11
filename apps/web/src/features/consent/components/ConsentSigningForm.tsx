import type {
  ConsentMarkInput,
  ConsentSigningViewDto,
  SignConsentRequest,
} from '@consultorio/contracts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import {
  buildSignRequest,
  signingProblems,
  type SigningFormState,
} from '../domain/signing-form.js';

import { ErrorAlert } from './ErrorAlert.js';
import { ScrollableText } from './ScrollableText.js';
import { SignaturePad } from './SignaturePad.js';

export interface ConsentSigningFormProps {
  /** The version of the consent the signer is shown, with its full text. */
  view: ConsentSigningViewDto;
  /** Receives the signature to send. It is called only when the form is complete. */
  onSubmit: (request: SignConsentRequest) => void;
  onCancel?: () => void;
  submitting?: boolean;
  /** The error the server answered, shown above the buttons. */
  error?: unknown;
}

/**
 * The signing screen of a consent (informed-consent, "Signature capture and binding"): the FULL text
 * of the version, the explicit acceptance, the representative's data for a minor, and the mark. It
 * knows nothing of where the request came from, so the staff dialog at reception and the patient
 * portal show the same screen and send the same body. The signature binds to the version id shown
 * here (`view.version.id`), not to whatever is current when it is submitted.
 */
export function ConsentSigningForm({
  view,
  onSubmit,
  onCancel,
  submitting = false,
  error,
}: ConsentSigningFormProps) {
  const { t } = useTranslation(['consent', 'common']);
  const acceptId = useId();
  const [state, setState] = useState<SigningFormState>({
    accepted: false,
    representativeSigns: view.requiresRepresentative,
    representative: { name: '', nationalId: '', relation: '' },
    mark: null,
  });
  const [attempted, setAttempted] = useState(false);
  const problems = signingProblems(state);

  const setMark = (mark: ConsentMarkInput | null) => {
    setState((current) => ({ ...current, mark }));
  };
  const setRepresentative = (field: 'name' | 'nationalId' | 'relation', value: string) => {
    setState((current) => ({
      ...current,
      representative: { ...current.representative, [field]: value },
    }));
  };

  return (
    <form
      className="grid gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        const request = buildSignRequest(view.version.id, state);
        if (request === null) {
          setAttempted(true);
          return;
        }
        onSubmit(request);
      }}
    >
      <div className="grid gap-2">
        <h3 className="font-display text-base font-semibold">{view.version.title}</h3>
        <p className="text-sm text-muted-foreground">
          {t('consent:signing.patient', { name: view.patientName })} ·{' '}
          {t('consent:signing.version', { number: view.version.number })}
        </p>
        <ScrollableText label={t('consent:signing.textLabel')} className="max-h-64">
          {view.version.body}
        </ScrollableText>
      </div>

      {view.requiresRepresentative ? (
        <Alert tone="info">
          <AlertDescription>{t('consent:signing.representative.required')}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex items-start gap-3">
          <Checkbox
            id="signing-representative-toggle"
            checked={state.representativeSigns}
            onCheckedChange={(checked) => {
              setState((current) => ({ ...current, representativeSigns: checked === true }));
            }}
            className="mt-0.5"
          />
          <Label htmlFor="signing-representative-toggle" className="font-normal">
            {t('consent:signing.representative.toggle')}
          </Label>
        </div>
      )}

      {state.representativeSigns ? (
        <fieldset className="grid gap-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t('consent:signing.representative.legend')}
          </legend>
          <div className="grid gap-1.5">
            <Label htmlFor="signing-rep-name">{t('consent:signing.representative.name')}</Label>
            <Input
              id="signing-rep-name"
              autoComplete="off"
              value={state.representative.name}
              maxLength={120}
              onChange={(event) => {
                setRepresentative('name', event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="signing-rep-document">
              {t('consent:signing.representative.nationalId')}
            </Label>
            <Input
              id="signing-rep-document"
              autoComplete="off"
              inputMode="numeric"
              value={state.representative.nationalId}
              maxLength={20}
              onChange={(event) => {
                setRepresentative('nationalId', event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="signing-rep-relation">
              {t('consent:signing.representative.relation')}
            </Label>
            <Input
              id="signing-rep-relation"
              autoComplete="off"
              value={state.representative.relation}
              maxLength={60}
              onChange={(event) => {
                setRepresentative('relation', event.target.value);
              }}
            />
          </div>
          {attempted && problems.includes('representative') ? (
            <p role="alert" className="text-sm text-destructive">
              {t('consent:signing.problem.representative')}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">{t('consent:signing.mark.title')}</h3>
        <SignaturePad onChange={setMark} />
        {attempted && problems.includes('mark') ? (
          <p role="alert" className="text-sm text-destructive">
            {t('consent:signing.problem.mark')}
          </p>
        ) : null}
      </section>

      <div className="grid gap-1.5">
        <div className="flex items-start gap-3">
          <Checkbox
            id={acceptId}
            checked={state.accepted}
            aria-invalid={attempted && problems.includes('accept')}
            onCheckedChange={(checked) => {
              setState((current) => ({ ...current, accepted: checked === true }));
            }}
            className="mt-0.5"
          />
          <Label htmlFor={acceptId} className="font-normal">
            {t('consent:signing.accept')}
          </Label>
        </div>
        {attempted && problems.includes('accept') ? (
          <p role="alert" className="text-sm text-destructive">
            {t('consent:signing.problem.accept')}
          </p>
        ) : null}
      </div>

      <ErrorAlert error={error} />
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common:action.cancel')}
          </Button>
        ) : null}
        <Button type="submit" loading={submitting}>
          {t('consent:signing.submit')}
        </Button>
      </div>
    </form>
  );
}
