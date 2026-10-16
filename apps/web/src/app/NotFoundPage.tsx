import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '../shared/ui/states/empty-state.js';

/** An address that does not exist. Calm, with the way home; never an error trace. */
export function NotFoundPage() {
  const { t } = useTranslation(['common', 'shell']);
  return (
    <div className="mx-auto max-w-xl py-10">
      <EmptyState
        icon={Compass}
        title={t('common:state.notFound.title')}
        description={t('common:state.notFound.description')}
        action={
          <Link
            to="/"
            className="inline-flex touch-target-md items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('shell:notFound.action')}
          </Link>
        }
      />
    </div>
  );
}
