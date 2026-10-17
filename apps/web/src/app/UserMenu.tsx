import type { MeResponse } from '@consultorio/contracts';
import { useRouter, Link } from '@tanstack/react-router';
import { ListChecks, LogOut, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChecklistDialog } from '../features/onboarding/FirstRunChecklist.js';
import { readColorScheme, writeColorScheme } from '../shared/lib/preferences.js';
import type { ColorSchemePreference } from '../shared/lib/theme-boot.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../shared/ui/dropdown-menu.js';

import { useServices } from './providers.js';

const SCHEMES: readonly ColorSchemePreference[] = ['light', 'dark', 'system'];

function initialsOf(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

/** Account actions: security, color scheme and sign out. */
export function UserMenu({ me }: { me: MeResponse }) {
  const { t } = useTranslation(['shell', 'common']);
  const { api, clearSession } = useServices();
  const router = useRouter();
  const [scheme, setScheme] = useState<ColorSchemePreference>(readColorScheme);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const runsOnboarding = me.permissions.includes('onboarding.manage');

  async function signOut() {
    try {
      await api.post('/auth/logout');
    } catch {
      // Whatever the server answered, nothing of this session stays in the browser.
    }
    clearSession();
    await router.navigate({ to: '/login' });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('shell:user.menu')}
            className="touch-target grid cursor-pointer place-content-center rounded-full"
          >
            <span
              aria-hidden="true"
              className="grid size-9 place-content-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
            >
              {initialsOf(me.user.email)}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="grid">
            <span>{t('shell:user.signedInAs')}</span>
            <span className="truncate text-sm font-medium text-foreground">{me.user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/account/security">
              <ShieldCheck aria-hidden="true" />
              {t('shell:user.security')}
            </Link>
          </DropdownMenuItem>
          {runsOnboarding ? (
            <DropdownMenuItem
              onSelect={() => {
                setChecklistOpen(true);
              }}
            >
              <ListChecks aria-hidden="true" />
              {t('shell:user.firstSteps')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('shell:user.appearance')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={scheme}
            onValueChange={(value) => {
              const next = SCHEMES.find((option) => option === value) ?? 'system';
              writeColorScheme(next);
              setScheme(next);
            }}
          >
            {SCHEMES.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {t(`common:theme.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void signOut();
            }}
          >
            <LogOut aria-hidden="true" />
            {t('common:action.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {runsOnboarding ? (
        <ChecklistDialog open={checklistOpen} onOpenChange={setChecklistOpen} />
      ) : null}
    </>
  );
}
