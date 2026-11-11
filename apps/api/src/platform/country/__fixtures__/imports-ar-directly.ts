// Lint fixture: this import is forbidden. Only the country registry may import country/ar.
import { createArPack } from '../../../country/ar/index.js';

export const pack = createArPack({
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
});
