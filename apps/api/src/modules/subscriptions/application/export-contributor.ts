import type { ExportContributor } from '../../tenancy/index.js';

/**
 * The subscriptions part of the cancellation export. Seam skeleton of Stage 6: its shape and its
 * registration (and the test that a module cannot be forgotten) exist from the start; the
 * subscriptions track (A, S6.05 and S6.35) fills it in. No table exists yet, so there is nothing to
 * hand over.
 *
 * It is administrative: the plan, the state and the dates of the subscription and its published
 * statements (professionals counted, prices, prorations, overage lines). It holds no clinical data,
 * no message text, and never a payment method (the platform keeps only the label the provider
 * gives, and the card is never stored). A key the export would read from the provider (the payer
 * email, the preapproval id) is administrative too.
 */
export const exportSubscriptions: ExportContributor = () =>
  Promise.resolve({ subscription: null, statements: [] });
