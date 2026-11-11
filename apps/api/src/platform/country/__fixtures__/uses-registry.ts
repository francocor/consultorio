// Lint fixture: the sanctioned way to reach the Argentina rules is through the registry.
import { getCountryPack } from '../country-pack.js';

export const result = getCountryPack('AR', {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
});
