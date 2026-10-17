import type { StaffMemberDto } from '@consultorio/contracts';
import { MapPin, Settings2, Stethoscope } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part) && !/^(Dra?\.|Lic\.)$/.test(part))
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');
}

/** One person of the team: who they are, what they do and where. Actions open the sheet. */
export function StaffMemberCard({
  member,
  isSelf,
  onManage,
}: {
  member: StaffMemberDto;
  isSelf: boolean;
  onManage: () => void;
}) {
  const { t } = useTranslation('staff');
  const name = member.displayName ?? t('member.noName');
  const profile = member.professional;
  const deactivated = member.status === 'deactivated';

  return (
    <li className="flex flex-col gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-content-center rounded-full bg-accent font-display text-sm font-semibold text-accent-foreground"
        >
          {initials(name) || '?'}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{name}</span>
            {isSelf ? <Badge tone="brand">{t('member.you')}</Badge> : null}
            {deactivated ? <Badge tone="neutral">{t('member.deactivated')}</Badge> : null}
          </p>
          {member.email ? (
            <p className="truncate text-sm text-muted-foreground">{member.email}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onManage}
          aria-label={t('member.manageLabel', { name })}
        >
          <Settings2 aria-hidden="true" />
          <span className="hidden sm:inline">{t('member.manage')}</span>
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {member.roles.map((role) => (
          <Badge key={role} tone={role === 'professional' ? 'info' : 'neutral'}>
            {t(`role.${role}`)}
          </Badge>
        ))}
      </div>

      {profile ? (
        <div className="grid gap-1.5 text-sm">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Stethoscope className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {profile.specialties.length > 0 ? (
              profile.specialties.map((specialty) => (
                <span key={specialty} className="font-medium">
                  {specialty}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">{t('member.noSpecialty')}</span>
            )}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {profile.matricula ? (
              <>
                <span className="tabular">
                  {t('member.matricula', {
                    jurisdiction: profile.matricula.jurisdiction,
                    number: profile.matricula.number,
                  })}
                </span>
                {profile.matricula.status === 'verified' ? (
                  <StatusBadge status="verified">
                    {t('profile.matriculaStatus.verified')}
                  </StatusBadge>
                ) : (
                  <StatusBadge status="unverified" />
                )}
              </>
            ) : (
              <span>{t('member.matriculaMissing')}</span>
            )}
          </p>
        </div>
      ) : null}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <MapPin className="size-4 shrink-0" aria-hidden="true" />
        {member.locations.length > 0 ? (
          member.locations.map((place, index) => (
            <span key={place.id}>
              {index > 0 ? <span aria-hidden="true">· </span> : null}
              {place.name}
            </span>
          ))
        ) : (
          <span>{t('member.noLocations')}</span>
        )}
      </p>
    </li>
  );
}
