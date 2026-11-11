/** One datum of the identity that the booking submitted and the record says otherwise. */
export interface IdentityDifference {
  field: 'givenNames' | 'familyName' | 'birthDate' | 'phone' | 'email';
  submitted: string | null;
  onFile: string | null;
}

export interface IdentityFacts {
  givenNames: string;
  familyName: string;
  birthDate: string;
  phone: string | null;
  email: string | null;
}

const FIELDS = ['givenNames', 'familyName', 'birthDate', 'phone', 'email'] as const;

/** Letters without accents or case, single spaces: how two spellings of a name compare. */
function plain(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A phone number by its digits, with the country prefix of Argentina left out. */
function digits(value: string): string {
  return value.replace(/\D/g, '').replace(/^54/, '');
}

function normalized(field: IdentityDifference['field'], value: string): string {
  switch (field) {
    case 'phone':
      return digits(value);
    case 'birthDate':
      return value.trim();
    default:
      return plain(value);
  }
}

/**
 * What the identity review shows next to the record (patients, "Identity review of online
 * matches"): the data the visitor submitted that is not what the record holds. The comparison
 * ignores accents, case and how a phone number is punctuated, so the review shows real differences
 * and not noise. A datum the visitor did not give is no difference. Nothing here changes the
 * record: staff decide which differences to apply.
 */
export function identityDifferences(
  onFile: IdentityFacts,
  submitted: IdentityFacts,
): IdentityDifference[] {
  const differences: IdentityDifference[] = [];
  for (const field of FIELDS) {
    const given = submitted[field];
    if (given === null || given.trim() === '') continue;
    const current = onFile[field];
    if (current !== null && normalized(field, current) === normalized(field, given)) continue;
    differences.push({ field, submitted: given, onFile: current });
  }
  return differences;
}
