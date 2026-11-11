import {
  PORTAL_RELATIONS,
  type PortalIdentityDto,
  type PortalRelation,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { formatDate } from '../../shared/lib/format.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../shared/ui/badge.js';
import { Button } from '../../shared/ui/button.js';
import { Input, Select, Textarea } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { portalKeys, portalStaffApi } from './api/portal-api.js';

const TONES: Record<PortalIdentityDto['status'], BadgeTone> = {
  invited: 'warning',
  active: 'success',
  deactivated: 'neutral',
};

function RepresentativeForm({
  onSubmit,
  pending,
}: {
  onSubmit: (body: { email: string; relation: PortalRelation; verificationNote: string }) => void;
  pending: boolean;
}) {
  const { t } = useTranslation('portal');
  const ids = useId();
  const [email, setEmail] = useState('');
  const [relation, setRelation] = useState<PortalRelation>('mother');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(false);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || note.trim().length < 10) {
      setProblem(true);
      return;
    }
    setProblem(false);
    onSubmit({ email: email.trim(), relation, verificationNote: note.trim() });
  }

  return (
    <form noValidate className="grid gap-3 rounded-lg border p-4" onSubmit={submit}>
      <h3 className="font-display text-base font-semibold">{t('staff.representative.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('staff.representative.description')}</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-email`}>{t('staff.representative.email')}</Label>
        <Input
          id={`${ids}-email`}
          type="email"
          autoComplete="off"
          aria-invalid={problem}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setProblem(false);
          }}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-relation`}>{t('staff.representative.relation')}</Label>
        <Select
          id={`${ids}-relation`}
          value={relation}
          onChange={(event) => {
            setRelation(event.target.value as PortalRelation);
          }}
        >
          {PORTAL_RELATIONS.map((option) => (
            <option key={option} value={option}>
              {t(`subject.relation.${option}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-note`}>{t('staff.representative.note')}</Label>
        <Textarea
          id={`${ids}-note`}
          maxLength={500}
          aria-invalid={problem}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            setProblem(false);
          }}
        />
        <p className="text-xs text-muted-foreground">{t('staff.representative.noteHint')}</p>
      </div>
      {problem ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('staff.representative.invalid')}
        </p>
      ) : null}
      <Button type="submit" variant="outline" loading={pending} className="justify-self-start">
        {t('staff.representative.submit')}
      </Button>
    </form>
  );
}

/**
 * The tab of the patient record for the portal account of the patient: who can sign in to read this
 * record, the invitation (to the patient, or to the person who represents them), and the ways to end
 * an access. Needs `portal.manage` (reception, the administration, the owner).
 */
export function PatientPortalTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation('portal');
  const api = portalStaffApi(useApi());
  const queryClient = useQueryClient();
  const key = portalKeys.staff(patientId);
  const query = useQuery({ queryKey: key, queryFn: () => api.accounts(patientId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const invite = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.invite(patientId, body),
    onSuccess: async () => {
      toast.success(t('staff.invited'));
      await refresh();
    },
  });
  const deactivate = useMutation({
    mutationFn: (identityId: string) => api.deactivate(identityId),
    onSuccess: async () => {
      toast.success(t('staff.deactivated'));
      await refresh();
    },
  });
  const revokeLink = useMutation({
    mutationFn: (linkId: string) => api.revokeLink(linkId),
    onSuccess: async () => {
      toast.success(t('staff.linkRevoked'));
      await refresh();
    },
  });
  const endSessions = useMutation({
    mutationFn: (identityId: string) => api.revokeSessions(identityId),
    onSuccess: async () => {
      toast.success(t('staff.sessionsEnded'));
      await refresh();
    },
  });
  const failure = deactivate.error ?? revokeLink.error ?? endSessions.error;

  if (query.isPending) return <ListSkeleton rows={2} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const identities = query.data.identities;
  const hasOwnAccount = identities.some(
    (identity) =>
      identity.status !== 'deactivated' &&
      (identity.links.some((link) => link.relationship === 'self' && link.status !== 'revoked') ||
        (identity.status === 'invited' && identity.links.length === 0)),
  );

  return (
    <section className="grid gap-5" aria-label={t('staff.title')}>
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('staff.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('staff.description')}</p>
      </div>

      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}

      {identities.length === 0 ? (
        <EmptyState title={t('staff.empty.title')} description={t('staff.empty.description')} />
      ) : (
        <ul className="grid gap-3">
          {identities.map((identity) => (
            <li key={identity.id} className="grid gap-3 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-medium">{identity.email}</span>
                <Badge tone={TONES[identity.status]}>{t(`staff.status.${identity.status}`)}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {identity.activatedAt
                  ? t('staff.activatedOn', { date: formatDate(identity.activatedAt) })
                  : t('staff.pendingHint')}
              </p>
              {identity.links.length > 0 ? (
                <ul className="grid gap-1 text-sm">
                  {identity.links.map((link) => (
                    <li key={link.id} className="flex flex-wrap items-center gap-2">
                      <span>
                        {link.relationship === 'self'
                          ? t('staff.link.self')
                          : t('staff.link.representative', {
                              relation: t(`subject.relation.${link.relation ?? 'other'}`),
                            })}
                      </span>
                      <Badge tone={link.status === 'active' ? 'success' : 'neutral'}>
                        {t(`staff.link.status.${link.status}`)}
                      </Badge>
                      {link.status !== 'revoked' ? (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => {
                            revokeLink.mutate(link.id);
                          }}
                        >
                          {t('staff.link.revoke')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {identity.status !== 'deactivated' ? (
                <div className="flex flex-wrap gap-2">
                  {identity.status === 'active' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        endSessions.mutate(identity.id);
                      }}
                    >
                      {t('staff.endSessions')}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      deactivate.mutate(identity.id);
                    }}
                  >
                    {t('staff.deactivate')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3">
        <Button
          className="justify-self-start"
          disabled={hasOwnAccount}
          loading={invite.isPending}
          onClick={() => {
            invite.mutate({});
          }}
        >
          {hasOwnAccount ? t('staff.alreadyInvited') : t('staff.invite')}
        </Button>
        {invite.error ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, invite.error).message}</AlertDescription>
          </Alert>
        ) : null}
        <RepresentativeForm
          pending={invite.isPending}
          onSubmit={(body) => {
            invite.mutate(body);
          }}
        />
      </div>
    </section>
  );
}
