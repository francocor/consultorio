/**
 * The key that makes a submission idempotent (billing-payments, "Duplicate payment protection").
 * The same payment sent again (a double click, a retry after the connection dropped) must carry the
 * same key, so the server records it once; a different payment (another amount, another method)
 * must carry another, or the server refuses the reuse. So the key follows what is sent: it is kept
 * while the signature of the request is the same, replaced when it changes, and replaced after a
 * submission went through.
 */
export interface SubmissionKeys {
  /** The key for a request with this signature. */
  keyFor(signature: string): string;
  /** Call when the submission succeeded: the next one is a new payment. */
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
