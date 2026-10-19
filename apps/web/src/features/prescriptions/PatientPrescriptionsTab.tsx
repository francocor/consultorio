import { useTranslation } from 'react-i18next';

/**
 * Seam stub of Stage 5: the prescriptions tab of the patient record (`patient-detail-tab`, which
 * hands it `patientId`). The e-Rx track (A3, S5.05) replaces it with the patient's prescriptions
 * and the issue form.
 */
export function PatientPrescriptionsTab() {
  const { t } = useTranslation('prescriptions');
  return <p className="text-sm text-muted-foreground">{t('patientTab.stub')}</p>;
}
