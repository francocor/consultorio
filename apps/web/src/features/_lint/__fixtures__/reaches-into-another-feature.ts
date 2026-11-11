// Deliberately wrong: a feature added after Stage 2 imports a file inside another feature.
import { PatientPicker } from '../../patients/components/PatientPicker.js';

export const probe = PatientPicker;
