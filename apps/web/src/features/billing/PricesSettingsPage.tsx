import { useTranslation } from 'react-i18next';

import { usePageTitle } from '../../app/use-page-title.js';
import { PageHeader } from '../../shared/ui/page-header.js';

import { PayersSection } from './components/PayersSection.js';
import { PricesSection } from './components/PricesSection.js';

/**
 * Settings > Precios y obras sociales, for whoever manages prices (`pricing.manage`: owner and
 * administrators). The payers the organization bills, with the CUIT a Factura A needs, and the
 * price list: private prices and what each payer plan pays.
 */
export function PricesSettingsPage() {
  const { t } = useTranslation('billing');
  usePageTitle(t('settings.title'));
  return (
    <div className="grid gap-8">
      <PageHeader
        title={t('settings.title')}
        description={t('settings.description')}
        className="mb-0"
      />
      <section aria-labelledby="payers-title" className="grid gap-3">
        <h2 id="payers-title" className="font-display text-lg font-semibold">
          {t('settings.payers')}
        </h2>
        <PayersSection />
      </section>
      <section aria-labelledby="prices-title" className="grid gap-3">
        <h2 id="prices-title" className="font-display text-lg font-semibold">
          {t('settings.prices')}
        </h2>
        <PricesSection />
      </section>
    </div>
  );
}
