import type { Permission } from '@consultorio/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useBoot } from '../../app/boot.js';
import { hasAnyPermission, useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { Card, CardDescription, CardHeader, CardTitle } from '../../shared/ui/card.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { PatientPicker } from '../patients/components/PatientPicker.js';

interface QuickAction {
  id: 'patients' | 'staff' | 'audit' | 'settings' | 'security';
  to: string;
  icon: LucideIcon;
  anyOf: readonly Permission[];
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'patients', to: '/patients', icon: Users, anyOf: ['patients.read'] },
  { id: 'staff', to: '/staff', icon: UsersRound, anyOf: ['staff.manage'] },
  { id: 'audit', to: '/audit', icon: ScrollText, anyOf: ['audit.read'] },
  {
    id: 'settings',
    to: '/settings',
    icon: Settings,
    anyOf: ['tenant.settings.manage', 'tenant.branding.manage', 'locations.manage'],
  },
  { id: 'security', to: '/account/security', icon: ShieldCheck, anyOf: [] },
];

/** The landing page of every role: where to go next, with only the areas the user can use. */
export function HomePage() {
  const { t } = useTranslation('shell');
  const me = useMe();
  const boot = useBoot();
  const organization = boot?.name ?? t('org.fallbackName');
  usePageTitle(t('nav.home'));

  const roles = me.roles.map((role) => t(`role.${role}`)).join(', ');
  const actions = QUICK_ACTIONS.filter((action) => hasAnyPermission(me.permissions, action.anyOf));
  const canSearchPatients = hasAnyPermission(me.permissions, ['patients.read']);
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title={t('home.welcome', { organization })}
        description={t('home.signedInAs', { roles })}
      />

      {canSearchPatients ? (
        <section aria-labelledby="find-patient" className="mb-8 grid gap-2">
          <h2 id="find-patient" className="font-display text-base font-semibold">
            {t('home.search.title')}
          </h2>
          <PatientPicker
            className="max-w-xl"
            onSelect={(patient) => {
              void navigate({ to: `/patients/${patient.id}` });
            }}
          />
        </section>
      ) : null}

      <section aria-labelledby="quick-actions" className="grid gap-3">
        <h2 id="quick-actions" className="font-display text-base font-semibold">
          {t('home.quick.title')}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <li key={action.id}>
                <Link
                  to={action.to}
                  className="group block h-full rounded-lg focus-visible:outline-offset-4"
                >
                  <Card className="h-full transition-colors group-hover:border-primary/50 group-hover:bg-accent/40">
                    <CardHeader>
                      <span className="mb-2 grid size-10 place-content-center rounded-md bg-primary-soft text-primary-ink">
                        <Icon className="size-5" aria-hidden="true" />
                      </span>
                      <CardTitle as="h3" className="flex items-center justify-between gap-2">
                        {t(`home.quick.${action.id}.title`)}
                        <ArrowRight
                          className="size-4 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </CardTitle>
                      <CardDescription>{t(`home.quick.${action.id}.description`)}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-8 rounded-lg border border-dashed bg-card p-5">
        <h2 className="font-display text-base font-semibold">{t('home.soon.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('home.soon.description')}</p>
      </section>
    </div>
  );
}
