/**
 * The key that makes a submission idempotent (e-invoicing-afip, "Issuing an invoice with CAE"). The
 * same request sent again (a double click, a retry after the connection dropped) must carry the same
 * key, so the server creates one invoice; a different request must carry another, or the server
 * refuses the reuse. So the key follows what is sent: it is kept while the signature of the request
 * is the same, replaced when it changes, and replaced after a submission went through.
 */
export interface SubmissionKeys {
  /** The key for a request with this signature. */
  keyFor(signature: string): string;
  /** Call when the submission succeeded: the next one is a new request. */
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
