import { PrescriptionItem } from '@consultorio/contracts';

/** The fields of one medication line, in the order the form shows them. */
export const ITEM_FIELDS = ['genericName', 'dose', 'form', 'quantity', 'instructions'] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];

/** A medication line as the form holds it: text everywhere, because that is what a person types. */
export type ItemDraft = Record<ItemField, string>;

export const EMPTY_ITEM: ItemDraft = {
  genericName: '',
  dose: '',
  form: '',
  quantity: '',
  instructions: '',
};

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 999;

/** The quantity typed, when it is a whole number the contract accepts. */
function quantityOf(text: string): number | null {
  const typed = text.trim();
  if (!/^\d+$/.test(typed)) return null;
  const quantity = Number(typed);
  return quantity >= MIN_QUANTITY && quantity <= MAX_QUANTITY ? quantity : null;
}

/** The fields of a line that are blank or invalid (a quantity must be a whole number from 1 to 999). */
export function missingFields(item: ItemDraft): ItemField[] {
  return ITEM_FIELDS.filter((field) =>
    field === 'quantity' ? quantityOf(item.quantity) === null : item[field].trim() === '',
  );
}

/** The lines in the shape of the contract, or null while one of them is incomplete (or there is none). */
export function requestItems(items: readonly ItemDraft[]): PrescriptionItem[] | null {
  if (items.length === 0) return null;
  const request: PrescriptionItem[] = [];
  for (const item of items) {
    const quantity = quantityOf(item.quantity);
    const parsed = PrescriptionItem.safeParse({
      genericName: item.genericName,
      dose: item.dose,
      form: item.form,
      quantity,
      instructions: item.instructions,
    });
    if (!parsed.success) return null;
    request.push(parsed.data);
  }
  return request;
}

/**
 * What makes two submissions the same one: the patient and the lines. The key that makes a
 * submission idempotent follows this signature, so pressing the button twice sends one prescription
 * and changing a line sends another.
 */
export function signatureOf(patientId: string, items: readonly ItemDraft[]): string {
  return JSON.stringify([patientId, items.map((item) => ITEM_FIELDS.map((field) => item[field]))]);
}

/**
 * The key a form attaches to what it sends: kept while the signature is the same, replaced when it
 * changes, and replaced after a submission went through.
 */
export interface SubmissionKeys {
  keyFor(signature: string): string;
  done(): void;
}

export function createSubmissionKeys(
  make: () => string = () => crypto.randomUUID(),
): SubmissionKeys {
  let current: { signature: string; key: string } | null = null;
  return {
    keyFor(signature) {
      if (current?.signature !== signature) current = { signature, key: make() };
      return current.key;
    },
    done() {
      current = null;
    },
  };
}
