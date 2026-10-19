import { useTranslation } from 'react-i18next';

/**
 * Seam stub of Stage 5: the consents tab of the patient record (`patient-detail-tab`, which hands
 * it `patientId`). The consent track (A2, S5.11) replaces it with the list under the neutral-label
 * rules and the request and revocation actions.
 */
export function PatientConsentsTab() {
  const { t } = useTranslation('consent');
  return <p className="text-sm text-muted-foreground">{t('patientTab.stub')}</p>;
}
