import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/** Scaffold of the public booking page `/book/{slug}`; the booking flow arrives in Stage 3. */
export function BookingPage({ slug }: { slug: string }) {
  const { t } = useTranslation('shell');
  return (
    <div>
      <PageHeader title={t('book.title')} description={t('book.description')} />
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarClock className="size-4" aria-hidden="true" />
        {t('book.slug', { slug })}
      </p>
    </div>
  );
}
