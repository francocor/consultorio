import type { PortalLinkDto } from '@consultorio/contracts';
import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/ui/button.js';

/** What the representative is to the dependent, in the words of the screen. */
export function relationLabel(
  t: (key: string) => string,
  link: Pick<PortalLinkDto, 'relationship' | 'relation'>,
): string {
  if (link.relationship === 'self') return t('portal:subject.self');
  return t(`portal:subject.relation.${link.relation ?? 'other'}`);
}

export interface SubjectPickerProps {
  links: readonly PortalLinkDto[];
  /** The one that is shown now, when the person is switching. */
  current: string | null;
  onPick: (linkId: string) => void;
  picking: boolean;
  onCancel?: () => void;
}

/**
 * Who the portal shows: a person with several records (a parent with two children, or themselves and
 * a child) picks one, and the header keeps naming it. Nothing is shown until they choose.
 */
export function SubjectPicker({ links, current, onPick, picking, onCancel }: SubjectPickerProps) {
  const { t } = useTranslation('portal');
  return (
    <section aria-labelledby="portal-subject-title" className="grid gap-4">
      <div className="grid gap-1">
        <h1
          id="portal-subject-title"
          className="font-display text-2xl font-semibold tracking-tight"
        >
          {t('subject.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subject.description')}</p>
      </div>
      <ul className="grid gap-3">
        {links.map((link) => (
          <li key={link.id}>
            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 whitespace-normal py-3 text-left"
              disabled={picking}
              aria-current={link.id === current ? 'true' : undefined}
              onClick={() => {
                onPick(link.id);
              }}
            >
              <UserRound aria-hidden="true" className="size-5" />
              <span className="grid">
                <span className="font-medium">{link.patientName}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {relationLabel(t, link)}
                </span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {onCancel ? (
        <Button variant="ghost" className="justify-self-start" onClick={onCancel}>
          {t('subject.cancel')}
        </Button>
      ) : null}
    </section>
  );
}
