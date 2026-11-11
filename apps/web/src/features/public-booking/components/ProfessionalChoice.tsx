import type { PublicProfessionalDto } from '@consultorio/contracts';
import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/ui/button.js';

/**
 * The professionals an organization lets visitors book with. One card each, with a button that names
 * the professional so a screen reader hears whom it chooses.
 */
export function ProfessionalChoice({
  professionals,
  onChoose,
}: {
  professionals: readonly PublicProfessionalDto[];
  onChoose: (slug: string) => void;
}) {
  const { t } = useTranslation('booking');
  return (
    <section aria-labelledby="professional-legend" className="grid gap-3">
      <h2 id="professional-legend" className="font-display text-lg font-semibold">
        {t('choose.professional.legend')}
      </h2>
      <ul className="grid gap-3">
        {professionals.map((professional) => (
          <li
            key={professional.slug}
            className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-10 shrink-0 place-content-center rounded-full bg-primary-soft text-primary-ink">
                <UserRound className="size-5" aria-hidden="true" />
              </span>
              <div className="grid min-w-0">
                <span className="truncate font-medium">{professional.name}</span>
                {professional.specialties.length > 0 ? (
                  <span className="truncate text-sm text-muted-foreground">
                    {professional.specialties.join(' · ')}
                  </span>
                ) : null}
              </div>
            </div>
            <Button
              variant="outline"
              aria-label={t('choose.professional.pick', { name: professional.name })}
              onClick={() => {
                onChoose(professional.slug);
              }}
            >
              {t('choose.professional.select')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
