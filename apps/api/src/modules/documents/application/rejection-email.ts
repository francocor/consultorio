import type { DocumentRejectionReason } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { userAccount } from '../../../db/schema/identity.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { RenderedEmail } from '../../../platform/mail/templates.js';
import { readOrganizationName } from '../../tenancy/index.js';

import type { RejectionNotice } from './scan-job.js';

const REASON_TEXT: Record<DocumentRejectionReason, string> = {
  infected: 'el archivo contiene software malicioso',
  type_not_allowed: 'el tipo de archivo no está permitido',
  type_mismatch: 'el contenido no coincide con el tipo de archivo declarado',
  corrupt: 'el archivo está dañado o contiene datos adicionales',
  too_large: 'el archivo supera el tamaño máximo de 20 MB',
};

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * "Un archivo no pudo cargarse": sent to whoever uploaded a file the checks refused. It names no
 * file and no patient (an email travels outside the application) and has no link: it says what
 * happened and where to look, and the list of documents shows the rest.
 */
export function renderRejectionEmail(input: {
  organizationName: string;
  reason: DocumentRejectionReason;
}): RenderedEmail {
  const organization = input.organizationName;
  const reason = REASON_TEXT[input.reason];
  const subject = `Un archivo no pudo cargarse en ${organization}`;

  const text = [
    'Un archivo que usted subió no pasó los controles de seguridad y no fue guardado.',
    '',
    `Motivo: ${reason}.`,
    '',
    `Ingrese a ${organization} para ver el detalle y volver a intentarlo si corresponde.`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">Un archivo no pudo cargarse</h1>
<p>Un archivo que usted subió no pasó los controles de seguridad y no fue guardado.</p>
<p><strong>Motivo:</strong> ${escapeHtml(reason)}.</p>
<p>Ingrese a ${escapeHtml(organization)} para ver el detalle y volver a intentarlo si corresponde.</p>
</body>
</html>`;
  return { subject, text, html };
}

/**
 * Builds the notifier the scan job calls for a refused file: finds the uploader's address and the
 * organization's name, and sends the email. Runs inside the job's transaction as the system user,
 * which can read the account because the uploader is a member of the organization.
 */
export function createRejectionNotifier(deps: { email: EmailSender }) {
  return async (tx: Tx, notice: RejectionNotice): Promise<void> => {
    const [account] = await tx
      .select({ email: userAccount.email })
      .from(userAccount)
      .where(eq(userAccount.id, notice.uploaderUserId));
    if (!account) return;
    const [organization] = await tx
      .select({ isDemo: tenant.isDemo })
      .from(tenant)
      .where(eq(tenant.id, notice.tenantId));
    const rendered = renderRejectionEmail({
      organizationName: await readOrganizationName(tx),
      reason: notice.reason,
    });
    await deps.email.send({
      to: account.email,
      ...rendered,
      tenant: { id: notice.tenantId, isDemo: organization?.isDemo ?? false },
    });
  };
}
