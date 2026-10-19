import type { ExportContributor } from '../../tenancy/index.js';

/**
 * The portal part of the cancellation export. Seam skeleton of Stage 5: it returns nothing yet, so
 * the registration (and the test that a module cannot be forgotten) exists from the start; the
 * portal track (B, S5.06) fills it in.
 *
 * It is administrative and goes to the owner: the portal identities, their links and the sessions'
 * dates. The portal owns no clinical table, so it has no clinical part: consents, prescriptions and
 * documents travel with the module that owns them.
 */
export const exportPortal: ExportContributor = () => Promise.resolve({});
