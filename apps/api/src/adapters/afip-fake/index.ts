import type { InvoiceIssuer } from '@consultorio/contracts';

/**
 * The fake invoice issuer for demo organizations and unit tests (design section 6: "deterministic
 * fake CAE"). This is the seam's placeholder: it implements the port so the adapter registry is
 * complete, and it never invents a voucher. The invoicing track (task 4.41) turns it into the
 * in-memory issuer with sequential numbers and a deterministic CAE, and runs the shared contract
 * suite (`adapters/invoice-issuer.contract.ts`) against it.
 */
export function createFakeInvoiceIssuer(): InvoiceIssuer & { readonly simulated: true } {
  return {
    simulated: true,
    issue: () =>
      Promise.resolve({
        status: 'retryable',
        message: 'The invoice issuer of this deployment is not available yet.',
        outcomeUnknown: false,
      }),
    findIssued: () => Promise.resolve(null),
  };
}
