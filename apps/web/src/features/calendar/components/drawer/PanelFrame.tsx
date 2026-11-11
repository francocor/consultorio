import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/ui/button.js';

/** The frame of the step an action opens inside the drawer: a title, the fields and a way back. */
export function PanelFrame({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('common');
  return (
    <div role="group" aria-label={title} className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-base font-semibold">{title}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {t('action.back')}
        </Button>
      </div>
      {children}
    </div>
  );
}
