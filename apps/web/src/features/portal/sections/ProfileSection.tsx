import {
  PORTAL_RECTIFIABLE_FIELDS,
  type PortalLinkDto,
  type PortalProfileResponse,
  type PortalRectifiableField,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay, formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { toast } from '../../../shared/ui/toaster.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { QueryState } from '../components/QueryState.js';

import { RepresentativesCard } from './RepresentativesCard.js';

/** What the form holds while the person edits: text, never `null`. */
interface ContactDraft {
  phone: string;
  address: string;
  emergencyName: string;
  emergencyPhone: string;
}

const draftOf = (profile: PortalProfileResponse): ContactDraft => ({
  phone: profile.phone ?? '',
  address: profile.address ?? '',
  emergencyName: profile.emergencyContact?.name ?? '',
  emergencyPhone: profile.emergencyContact?.phone ?? '',
});

function ContactForm({ profile, link }: { profile: PortalProfileResponse; link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const ids = useId();
  const [draft, setDraft] = useState<ContactDraft>(() => draftOf(profile));
  const [problem, setProblem] = useState<'emergency' | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const emergency =
        draft.emergencyName.trim() === '' && draft.emergencyPhone.trim() === ''
          ? null
          : { name: draft.emergencyName.trim(), phone: draft.emergencyPhone.trim() };
      return api.updateProfile({
        phone: draft.phone.trim() === '' ? null : draft.phone.trim(),
        address: draft.address.trim() === '' ? null : draft.address.trim(),
        emergencyContact: emergency,
        expectedVersion: profile.version,
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(portalKeys.section(link.id, 'profile'), next);
      toast.success(t('profile.contact.saved'));
    },
  });
  const edit = (patch: Partial<ContactDraft>) => {
    setDraft({ ...draft, ...patch });
    setProblem(null);
  };

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    const half = (draft.emergencyName.trim() === '') !== (draft.emergencyPhone.trim() === '');
    if (half) {
      setProblem('emergency');
      return;
    }
    save.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.contact.title')}</CardTitle>
        <CardDescription>{t('profile.contact.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate className="grid gap-4" onSubmit={submit}>
          {save.error ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-phone`}>{t('profile.contact.phone')}</Label>
            <Input
              id={`${ids}-phone`}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={draft.phone}
              onChange={(event) => {
                edit({ phone: event.target.value });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-address`}>{t('profile.contact.address')}</Label>
            <Input
              id={`${ids}-address`}
              autoComplete="street-address"
              value={draft.address}
              onChange={(event) => {
                edit({ address: event.target.value });
              }}
            />
          </div>
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">{t('profile.contact.emergency')}</legend>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-emergency-name`}>{t('profile.contact.emergencyName')}</Label>
              <Input
                id={`${ids}-emergency-name`}
                value={draft.emergencyName}
                onChange={(event) => {
                  edit({ emergencyName: event.target.value });
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-emergency-phone`}>
                {t('profile.contact.emergencyPhone')}
              </Label>
              <Input
                id={`${ids}-emergency-phone`}
                type="tel"
                inputMode="tel"
                aria-invalid={problem === 'emergency'}
                value={draft.emergencyPhone}
                onChange={(event) => {
                  edit({ emergencyPhone: event.target.value });
                }}
              />
            </div>
            {problem === 'emergency' ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('profile.contact.emergencyIncomplete')}
              </p>
            ) : null}
          </fieldset>
          <Button type="submit" loading={save.isPending} className="justify-self-start">
            {t('profile.contact.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RectificationForm({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const ids = useId();
  const [field, setField] = useState<PortalRectifiableField>('familyName');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      api.rectification({
        field,
        correctValue: value.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: async () => {
      setValue('');
      setNote('');
      toast.success(t('profile.rectification.sent'));
      await queryClient.invalidateQueries({ queryKey: portalKeys.section(link.id, 'profile') });
    },
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (value.trim() === '') {
      setProblem(true);
      return;
    }
    setProblem(false);
    send.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.rectification.title')}</CardTitle>
        <CardDescription>{t('profile.rectification.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate className="grid gap-4" onSubmit={submit}>
          {send.error ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, send.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-field`}>{t('profile.rectification.field')}</Label>
            <Select
              id={`${ids}-field`}
              value={field}
              onChange={(event) => {
                setField(event.target.value as PortalRectifiableField);
              }}
            >
              {PORTAL_RECTIFIABLE_FIELDS.map((option) => (
                <option key={option} value={option}>
                  {t(`profile.rectification.fields.${option}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-value`}>{t('profile.rectification.value')}</Label>
            <Input
              id={`${ids}-value`}
              maxLength={100}
              aria-invalid={problem}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setProblem(false);
              }}
            />
            {problem ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('profile.rectification.valueRequired')}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-note`}>{t('profile.rectification.note')}</Label>
            <Input
              id={`${ids}-note`}
              maxLength={120}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            loading={send.isPending}
            className="justify-self-start"
          >
            {t('profile.rectification.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CopyRequestCard({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const noteId = useId();
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: () => api.copyRequest(note.trim() === '' ? {} : { note: note.trim() }),
    onSuccess: async () => {
      setNote('');
      toast.success(t('profile.copy.sent'));
      await queryClient.invalidateQueries({ queryKey: portalKeys.section(link.id, 'profile') });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.copy.title')}</CardTitle>
        <CardDescription>{t('profile.copy.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {send.error ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, send.error).message}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor={noteId}>{t('profile.copy.note')}</Label>
          <Input
            id={noteId}
            maxLength={200}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
        <Button
          variant="outline"
          loading={send.isPending}
          className="justify-self-start"
          onClick={() => {
            send.mutate();
          }}
        >
          {t('profile.copy.submit')}
        </Button>
      </CardContent>
    </Card>
  );
}

/** The patient's own data, what they can change, and what they can ask the consultorio about it. */
export function ProfileSection({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'profile'),
    queryFn: () => api.profile(),
  });
  return (
    <section>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />
      <QueryState query={query} isEmpty={() => false} empty={null} rows={4}>
        {(profile) => (
          <div className="grid gap-5">
            <Card>
              <CardHeader>
                <CardTitle>{t('profile.identity.title')}</CardTitle>
                <CardDescription>{t('profile.identity.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2 text-sm">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{t('profile.identity.name')}</dt>
                    <dd className="break-words">{`${profile.givenNames} ${profile.familyName}`}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{t('profile.identity.birthDate')}</dt>
                    <dd>{formatCalendarDay(profile.birthDate)}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{t('profile.identity.document')}</dt>
                    <dd className="tabular">
                      {profile.document?.number ?? t('profile.identity.none')}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{t('profile.identity.email')}</dt>
                    <dd className="break-all">{profile.email ?? t('profile.identity.none')}</dd>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2">
                    <dt className="text-muted-foreground">{t('profile.identity.consent')}</dt>
                    <dd>
                      {profile.dataProcessing.granted ? (
                        <Badge tone="success">
                          {t('profile.identity.consentGranted', {
                            date: formatDate(profile.dataProcessing.grantedAt),
                          })}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">{t('profile.identity.consentMissing')}</Badge>
                      )}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <ContactForm key={profile.version} profile={profile} link={link} />
            <RectificationForm link={link} />
            <CopyRequestCard link={link} />

            <Card>
              <CardHeader>
                <CardTitle>{t('profile.requests.title')}</CardTitle>
              </CardHeader>
              <CardContent>
                {profile.requests.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('profile.requests.empty')}</p>
                ) : (
                  <ul className="grid gap-2">
                    {profile.requests.map((request) => (
                      <li key={request.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>{t(`profile.requests.kind.${request.kind}`)}</span>
                        <span className="text-muted-foreground">
                          {formatDate(request.requestedAt)}
                        </span>
                        <Badge tone={request.status === 'open' ? 'warning' : 'success'}>
                          {t(`profile.requests.status.${request.status}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {link.relationship === 'self' ? <RepresentativesCard link={link} /> : null}
          </div>
        )}
      </QueryState>
    </section>
  );
}
