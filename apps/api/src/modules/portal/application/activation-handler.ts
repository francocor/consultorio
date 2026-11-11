import { eq } from 'drizzle-orm';

import { portalIdentity } from '../../../db/schema/portal.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { TokenHandler, TokenPage } from '../../../platform/public/token-router.js';

import { activateInvitation, type IdentityDeps } from './identities.js';

/**
 * What the activation link of the invitation does (`portal_activation`, spec "Portal account
 * activation and identity linking"). Opening it only shows what it is for; pressing the button
 * makes the identity active and gives it its link. It tells nothing about the person: a link is not
 * a login, and a mail scanner that opens it must not activate anything.
 */
export function createActivationHandler(
  deps: IdentityDeps & { origins: PublicOrigins },
): TokenHandler {
  return {
    // Creating an account is not one of the writes that protect the patient.
    allowedWhenReadOnly: false,
    audits: ['portal.identity.linked'],

    async describe(context) {
      const [identity] = await context.tx
        .select({ status: portalIdentity.status })
        .from(portalIdentity)
        .where(eq(portalIdentity.id, context.subjectId));
      if (identity?.status !== 'invited') return null;
      return {
        title: 'Active su acceso al portal de pacientes',
        message:
          'Con el portal puede ver sus turnos y sus documentos. No necesita contraseña: cada vez que ingrese le enviaremos un código a este correo.',
        action: { label: 'Activar mi acceso' },
      } satisfies TokenPage;
    },

    async perform(context) {
      const [organization] = await context.tx
        .select({ country: tenant.country, slug: tenant.slug })
        .from(tenant);
      if (!organization) return null;
      // Spend the link first: two presses at once activate once.
      if (!(await context.redeem())) return null;
      const outcome = await activateInvitation(context.tx, deps, {
        actor: context.actor,
        country: organization.country,
        identityId: context.subjectId,
        payload: context.payload,
      });
      if (outcome !== 'activated') return null;
      return {
        title: 'Su acceso está activo',
        message:
          'Ya puede ingresar al portal de pacientes con su correo. Le enviaremos un código cada vez que ingrese.',
        link: { label: 'Ir al portal', href: `${deps.origins(organization.slug)}/portal` },
      } satisfies TokenPage;
    },
  };
}
