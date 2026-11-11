import { useTranslation } from 'react-i18next';

import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { TwoFactorRequiredState } from '../../shared/ui/states/banners.js';

import { SessionsSection } from './components/SessionsSection.js';
import { TwoFactorSection } from './components/TwoFactorSection.js';

/** The account's own security: second factor, recovery codes and open sessions. */
export function AccountSecurityPage() {
  const { t } = useTranslation('auth');
  usePageTitle(t('security.title'));
  const me = useMe();
  // A session that can only enroll cannot list sessions: it shows the explanation and the factor.
  const enrollmentOnly = me.scope === 'two_factor_enrollment';

  return (
    <div className="grid gap-6">
      <PageHeader
        title={t('security.title')}
        description={t('security.description')}
        className="mb-0"
      />
      {enrollmentOnly ? <TwoFactorRequiredState /> : null}
      <TwoFactorSection me={me} />
      {enrollmentOnly ? null : <SessionsSection />}
    </div>
  );
}
