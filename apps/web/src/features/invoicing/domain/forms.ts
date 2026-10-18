import type { TaxCondition, UpsertFiscalProfileRequest } from '@consultorio/contracts';

/** What the owner typed in the fiscal profile form. `taxCondition` is empty until one is chosen. */
export interface ProfileDraft {
  cuit: string;
  taxCondition: TaxCondition | '';
  businessName: string;
  address: string;
  activityStartedOn: string;
}

export type ProfileField = keyof ProfileDraft;

export const EMPTY_PROFILE: ProfileDraft = {
  cuit: '',
  taxCondition: '',
  businessName: '',
  address: '',
  activityStartedOn: '',
};

/** The fields still empty. The CUIT check digit is the server's job (the country pack). */
export function missingProfileFields(draft: ProfileDraft): ProfileField[] {
  return (Object.keys(draft) as ProfileField[]).filter((field) => draft[field].trim() === '');
}

/** The request for a complete draft, or null while a field is missing. */
export function profileRequest(draft: ProfileDraft): UpsertFiscalProfileRequest | null {
  if (missingProfileFields(draft).length > 0 || draft.taxCondition === '') return null;
  return {
    cuit: draft.cuit.trim(),
    taxCondition: draft.taxCondition,
    businessName: draft.businessName.trim(),
    address: draft.address.trim(),
    activityStartedOn: draft.activityStartedOn,
  };
}

export function sameProfile(a: ProfileDraft, b: ProfileDraft): boolean {
  return (Object.keys(a) as ProfileField[]).every((field) => a[field] === b[field]);
}

const MAX_POINT_OF_SALE = 99_999;

/** A point of sale number as typed: whole digits from 1 to 99999, otherwise null. */
export function parsePointOfSale(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_POINT_OF_SALE ? value : null;
}
