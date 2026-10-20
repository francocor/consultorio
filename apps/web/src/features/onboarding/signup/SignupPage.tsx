import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 6: the public signup page. The signup track (B, S6.07) replaces it with the
 * form (organization, owner name, email, password, the two acceptances, the bot challenge), the
 * "check your email" screen, and the verification landing into the wizard.
 */
export function SignupPage() {
  const { t } = useTranslation('signup');
  return <PageHeader title={t('title')} description={t('stub.description')} />;
}
