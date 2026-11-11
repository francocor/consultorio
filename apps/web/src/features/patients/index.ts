/**
 * What other features may use of the patients feature: the picker that finds a patient by document
 * or name while typing. Everything else is private to the feature (it predates the feature
 * boundary, so its older neighbours still import its files directly).
 */
export { PatientPicker } from './components/PatientPicker.js';
