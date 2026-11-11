import { FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useBoot } from '../../../app/boot.js';
import { cn } from '../../../shared/lib/cn.js';

/**
 * Tells the person that the prescriptions they are looking at come from a simulator, when they do:
 * a demo organization only ever has the fake provider, and a deployment that runs the local
 * e-prescription provider says so in the boot payload (`localProviders.erx`). The documents it makes
 * carry the same warning on every page. It draws nothing until the boot payload is known, so a real
 * deployment never flashes a banner it does not need.
 */
export function SimulatedPrescriptionNotice({ className }: { className?: string }) {
  const { t } = useTranslation('prescriptions');
  const boot = useBoot();
  if (!boot || !(boot.isDemo || boot.localProviders.erx === true)) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground',
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">{t('notice.simulated.title')}</p>
        <p>{t('notice.simulated.description')}</p>
      </div>
    </div>
  );
}
