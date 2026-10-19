import {
  PORTAL_RELATIONS,
  type PortalConsentDetailDto,
  type PortalConsentSignRequest,
  type PortalLinkDto,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { toast } from '../../../shared/ui/toaster.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { DownloadButton } from '../components/DownloadButton.js';
import { QueryState } from '../components/QueryState.js';

import { CONSENT_TONES } from './ConsentsSection.js';

/**
 * Signing: the full text of the version shown, the explicit acceptance, the name written as the
 * signature and, for a dependent, the data of the representative. The server binds the signature to
 * the version the person was shown and refuses a request without the acceptance; the screen does not
 * enable the button before it either.
 *
 * The signature is typed (a name, keyboard and screen reader friendly). A drawn signature belongs to
 * the consent module's `SignaturePad`, which the integrator can offer here without touching the
 * rest of the screen.
 */
function SigningForm({
  consent,
  onSign,
  signing,
  error,
}: {
  consent: PortalConsentDetailDto;
  onSign: (request: PortalConsentSignRequest) => void;
  signing: boolean;
  error: unknown;
}) {
  const { t } = useTranslation('portal');
  const acceptId = useId();
  const nameId = useId();
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState('');
  const [representative, setRepresentative] = useState({
    fullName: '',
    nationalId: '',
    relation: 'mother' as (typeof PORTAL_RELATIONS)[number],
  });
  const [problem, setProblem] = useState<'accept' | 'name' | 'representative' | null>(null);
  const failure = error ? describeError(t, error) : null;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!accepted) {
      setProblem('accept');
      return;
    }
    const signer = consent.requiresRepresentative ? representative.fullName : name;
    if (signer.trim().length < 2) {
      setProblem(consent.requiresRepresentative ? 'representative' : 'name');
      return;
    }
    if (consent.requiresRepresentative && representative.nationalId.trim() === '') {
      setProblem('representative');
      return;
    }
    setProblem(null);
    onSign({
      accepted: true,
      signerName: signer.trim(),
      signature: { kind: 'typed', value: signer.trim() },
      ...(consent.requiresRepresentative
        ? {
            representative: {
              fullName: representative.fullName.trim(),
              nationalId: representative.nationalId.trim(),
              relation: representative.relation,
            },
          }
        : {}),
    });
  }

  return (
    <form noValidate className="grid gap-4 rounded-lg border bg-card p-4" onSubmit={submit}>
      <h2 className="font-display text-lg font-semibold">{t('consents.sign.title')}</h2>
      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}

      {consent.requiresRepresentative ? (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm text-muted-foreground">
            {t('consents.sign.representativeHint')}
          </legend>
          <div className="grid gap-1.5">
            <Label htmlFor={`${nameId}-rep-name`}>{t('consents.sign.representativeName')}</Label>
            <Input
              id={`${nameId}-rep-name`}
              autoComplete="name"
              value={representative.fullName}
              onChange={(event) => {
                setRepresentative({ ...representative, fullName: event.target.value });
                setProblem(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${nameId}-rep-id`}>{t('consents.sign.representativeId')}</Label>
            <Input
              id={`${nameId}-rep-id`}
              inputMode="numeric"
              value={representative.nationalId}
              onChange={(event) => {
                setRepresentative({ ...representative, nationalId: event.target.value });
                setProblem(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${nameId}-rep-relation`}>
              {t('consents.sign.representativeRelation')}
            </Label>
            <Select
              id={`${nameId}-rep-relation`}
              value={representative.relation}
              onChange={(event) => {
                setRepresentative({
                  ...representative,
                  relation: event.target.value as (typeof PORTAL_RELATIONS)[number],
                });
              }}
            >
              {PORTAL_RELATIONS.map((relation) => (
                <option key={relation} value={relation}>
                  {t(`subject.relation.${relation}`)}
                </option>
              ))}
            </Select>
          </div>
          {problem === 'representative' ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t('consents.sign.representativeInvalid')}
            </p>
          ) : null}
        </fieldset>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={nameId}>{t('consents.sign.name')}</Label>
          <Input
            id={nameId}
            autoComplete="name"
            aria-invalid={problem === 'name'}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
          />
          <p className="text-xs text-muted-foreground">{t('consents.sign.nameHint')}</p>
          {problem === 'name' ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t('consents.sign.nameInvalid')}
            </p>
          ) : null}
        </div>
      )}

      <div className="flex items-start gap-3">
        <Checkbox
          id={acceptId}
          checked={accepted}
          aria-invalid={problem === 'accept'}
          onCheckedChange={(value) => {
            setAccepted(value === true);
            setProblem(null);
          }}
        />
        <Label htmlFor={acceptId} className="text-sm leading-snug">
          {t('consents.sign.accept')}
        </Label>
      </div>
      {problem === 'accept' ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('consents.sign.acceptRequired')}
        </p>
      ) : null}

      <Button type="submit" size="lg" loading={signing}>
        {t('consents.sign.submit')}
      </Button>
    </form>
  );
}

function RevokeDialog({
  onRevoke,
  revoking,
}: {
  onRevoke: (reason: string) => void;
  revoking: boolean;
}) {
  const { t } = useTranslation('portal');
  const reasonId = useId();
  const [reason, setReason] = useState('');
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" loading={revoking}>
          {t('consents.revoke.action')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('consents.revoke.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('consents.revoke.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={reasonId}>{t('consents.revoke.reason')}</Label>
          <Textarea
            id={reasonId}
            maxLength={300}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('consents.revoke.keep')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onRevoke(reason.trim());
            }}
          >
            {t('consents.revoke.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One consent: its full text, and, depending on where it stands, to sign, to revoke or to download. */
export function ConsentDetail({ link, consentId }: { link: PortalLinkDto; consentId: string }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'consent', consentId),
    queryFn: () => api.consent(consentId),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: portalKeys.section(link.id, 'consents') });
    await queryClient.invalidateQueries({
      queryKey: portalKeys.section(link.id, 'consent', consentId),
    });
  };
  const sign = useMutation({
    mutationFn: (request: PortalConsentSignRequest) => api.signConsent(consentId, request),
    onSuccess: async () => {
      toast.success(t('consents.sign.done'));
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (reason: string) => api.revokeConsent(consentId, reason),
    onSuccess: async () => {
      toast.success(t('consents.revoke.done'));
      await refresh();
    },
  });

  return (
    <section>
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-3">
        <Link to="/portal/consentimientos">
          <ArrowLeft aria-hidden="true" />
          {t('consents.back')}
        </Link>
      </Button>
      <QueryState query={query} isEmpty={() => false} empty={null}>
        {(consent) => (
          <div className="grid gap-5">
            <PageHeader
              title={consent.title}
              description={
                consent.signedAt
                  ? t('consents.signedOn', { date: formatDate(consent.signedAt) })
                  : t('consents.requestedOn', { date: formatDate(consent.requestedAt) })
              }
              actions={
                <Badge tone={CONSENT_TONES[consent.status]}>
                  {t(`consents.status.${consent.status}`)}
                </Badge>
              }
            />
            {consent.expiresAt && consent.canSign ? (
              <Alert tone="warning">
                <AlertDescription>
                  {t('consents.expiresOn', { date: formatDate(consent.expiresAt) })}
                </AlertDescription>
              </Alert>
            ) : null}
            {/* The text is shown while the consent waits for a signature; afterwards its record is the PDF. */}
            {consent.body === '' ? null : (
              <article
                aria-label={t('consents.textLabel')}
                className="whitespace-pre-wrap break-words rounded-lg border bg-card p-4 text-sm leading-relaxed"
              >
                {consent.body}
              </article>
            )}
            {consent.canSign ? (
              <SigningForm
                consent={consent}
                signing={sign.isPending}
                error={sign.error}
                onSign={(request) => {
                  sign.mutate(request);
                }}
              />
            ) : null}
            {consent.canRevoke || consent.hasDocument ? (
              <div className="flex flex-wrap items-start gap-3">
                {consent.hasDocument ? (
                  <DownloadButton
                    kind="consents"
                    id={consent.id}
                    fileName="consentimiento.pdf"
                    label={t('consents.downloadLabel', { title: consent.title })}
                  />
                ) : null}
                {consent.canRevoke ? (
                  <RevokeDialog
                    revoking={revoke.isPending}
                    onRevoke={(reason) => {
                      revoke.mutate(reason);
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            {revoke.error ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, revoke.error).message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
      </QueryState>
    </section>
  );
}
