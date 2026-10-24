import type { ConsentMarkInput, SignConsentRequest } from '@consultorio/contracts';

/**
 * The state of the signing form and what makes it complete (informed-consent, "Signature capture
 * and binding" and "Minors, incapacitated patients and representatives"). Pure: the screen holds
 * the state and asks here what is missing and what to send. The server decides again.
 */
export interface SigningFormState {
  /** The explicit acceptance action. */
  accepted: boolean;
  /** A representative signs instead of the patient: always for a minor, by choice otherwise. */
  representativeSigns: boolean;
  representative: { name: string; nationalId: string; relation: string };
  /** A typed name or a drawing; null until the signer leaves one. */
  mark: ConsentMarkInput | null;
}

export type SigningProblem = 'accept' | 'representative' | 'mark';

const MIN_NAME = 2;
const MIN_DOCUMENT = 5;
const MIN_RELATION = 2;

function representativeComplete(state: SigningFormState): boolean {
  const { name, nationalId, relation } = state.representative;
  return (
    name.trim().length >= MIN_NAME &&
    nationalId.trim().length >= MIN_DOCUMENT &&
    relation.trim().length >= MIN_RELATION
  );
}

/** What is still missing, in the order the screen shows it. */
export function signingProblems(state: SigningFormState): SigningProblem[] {
  const problems: SigningProblem[] = [];
  if (!state.accepted) problems.push('accept');
  if (state.representativeSigns && !representativeComplete(state)) problems.push('representative');
  if (state.mark === null) problems.push('mark');
  return problems;
}

/** The body of the signature, or null while the form is incomplete. */
export function buildSignRequest(
  versionId: string,
  state: SigningFormState,
): SignConsentRequest | null {
  if (signingProblems(state).length > 0 || state.mark === null) return null;
  if (!state.representativeSigns) {
    return { versionId, accepted: true, signer: 'patient', mark: state.mark };
  }
  return {
    versionId,
    accepted: true,
    signer: 'representative',
    representative: {
      name: state.representative.name.trim(),
      nationalId: state.representative.nationalId.trim(),
      relation: state.representative.relation.trim(),
    },
    mark: state.mark,
  };
}
