import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { fiscalCredential, fiscalProfile } from '../../../db/schema/index.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { RenderedEmail } from '../../../platform/mail/templates.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { loadOrganization } from '../application/settings.js';
import { credentialState } from '../domain/credential.js';

export const CREDENTIAL_WATCH_JOB = 'fiscal.credential_watch';

const DAY_MS = 86_400_000;
const ZONE = 'America/Argentina/Buenos_Aires';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

export interface CredentialExpiryEmailInput {
  organizationName: string;
  notAfter: Date;
  now: Date;
}

/**
 * The warning to the owner: the certificate for the tax authority ends soon, or ended. It names no
 * certificate detail beyond the date, and no link: it says where to renew it.
 */
export function renderCredentialExpiryEmail(input: CredentialExpiryEmailInput): RenderedEmail {
  const organization = input.organizationName;
  const date = DateTime.fromJSDate(input.notAfter, { zone: ZONE }).toFormat('dd/MM/yyyy');
  const remaining = input.notAfter.getTime() - input.now.getTime();
  const expired = remaining <= 0;
  const days = Math.max(0, Math.ceil(remaining / DAY_MS));

  const subject = expired
    ? `El certificado de facturación de ${organization} venció`
    : `El certificado de facturación de ${organization} vence en ${String(days)} días`;
  const first = expired
    ? `El certificado digital que ${organization} usa para emitir facturas electrónicas venció el ${date}.`
    : `El certificado digital que ${organization} usa para emitir facturas electrónicas vence el ${date}, dentro de ${String(days)} días.`;
  const second = expired
    ? 'Mientras no cargue uno nuevo no se pueden emitir facturas. Puede registrar facturas emitidas por fuera del sistema.'
    : 'Cuando venza no se podrán emitir facturas. Genere uno nuevo en el sitio de ARCA y cárguelo antes de esa fecha.';
  const where = 'Lo carga en Configuración, pestaña Facturación.';

  const text = [first, '', second, '', where].join('\n');
  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">${escapeHtml(subject)}</h1>
<p>${escapeHtml(first)}</p>
<p>${escapeHtml(second)}</p>
<p>${escapeHtml(where)}</p>
</body>
</html>`;
  return { subject, text, html };
}

export interface CredentialWatchDeps {
  email: EmailSender;
  clock: () => Date;
}

/**
 * `fiscal.credential_watch`, one run per organization (e-invoicing-afip, "Fiscal credentials
 * lifecycle"): emails every owner once per certificate when it has 30 days or fewer left, or has
 * ended without a warning. The certificate is marked as warned in the same transaction, after the
 * email went out; if no owner could be reached the job fails and the next run tries again.
 */
export function createCredentialWatchJob(deps: CredentialWatchDeps) {
  return defineJob({
    name: CREDENTIAL_WATCH_JOB,
    category: 'write',
    payload: JobPayload,
    async handler({ tx }) {
      const [credential] = await tx
        .select()
        .from(fiscalCredential)
        .where(eq(fiscalCredential.active, true));
      const [profile] = await tx.select().from(fiscalProfile);
      if (!credential || !profile || credential.expiryWarnedAt !== null) return;

      const now = deps.clock();
      const state = credentialState({
        notBefore: credential.notBefore,
        notAfter: credential.notAfter,
        subjectCuit: credential.subjectCuit,
        profileCuit: profile.cuit,
        now,
      });
      if (state !== 'expiring' && state !== 'expired') return;

      const owners = await tx
        .select({ email: userAccount.email })
        .from(membership)
        .innerJoin(userAccount, eq(userAccount.id, membership.userId))
        .where(and(eq(membership.status, 'active'), sql`'owner' = any(${membership.roles})`));
      const recipients = [...new Set(owners.map((owner) => owner.email.toLowerCase()))];
      if (recipients.length === 0) return;

      const organization = await loadOrganization(tx);
      const rendered = renderCredentialExpiryEmail({
        organizationName: await readOrganizationName(tx),
        notAfter: credential.notAfter,
        now,
      });
      const results = await Promise.allSettled(
        recipients.map((to) =>
          deps.email.send({
            to,
            ...rendered,
            tenant: { id: organization.id, isDemo: organization.isDemo },
          }),
        ),
      );
      // Reaching one owner is enough to stop; reaching none is a failure to try again.
      if (!results.some((result) => result.status === 'fulfilled')) {
        throw new Error('the credential warning could not be delivered to any owner');
      }

      await tx
        .update(fiscalCredential)
        .set({ expiryWarnedAt: now })
        .where(eq(fiscalCredential.id, credential.id));
    },
  });
}
