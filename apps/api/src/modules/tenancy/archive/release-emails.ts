/**
 * The two notices of a release. Neither carries a record, and the one to the former contact of the
 * organization carries neither the name nor the document of the requester: it says that archived
 * records were handed over, to what kind of requester, and when.
 */

export interface Notice {
  subject: string;
  text: string;
}

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** To the requester, at the address that was verified: the link, and what it is. */
export function requesterNotice(input: {
  organizationName: string;
  requesterKind: 'patient' | 'professional';
  link: string;
  linkExpiresAt: Date;
}): Notice {
  const what =
    input.requesterKind === 'patient'
      ? 'una copia de sus registros'
      : 'una copia de los registros de sus pacientes';
  return {
    subject: `Su copia de los registros archivados de ${input.organizationName}`,
    text: [
      `Se aprobó su solicitud y se preparó ${what} que ${input.organizationName} tenía antes de cerrar.`,
      '',
      `Puede descargarla una sola vez desde este enlace, hasta el ${dayOf(input.linkExpiresAt)}:`,
      input.link,
      '',
      'El enlace es personal. Si no hizo esta solicitud, ignore este mensaje: el enlace vence solo.',
    ].join('\n'),
  };
}

/** To the former contact of the organization: records in custody were handed over. */
export function contactNotice(input: {
  organizationName: string;
  requesterKind: 'patient' | 'professional';
  at: Date;
}): Notice {
  const who = input.requesterKind === 'patient' ? 'un paciente' : 'un profesional';
  return {
    subject: `Se entregó una copia de registros archivados de ${input.organizationName}`,
    text: [
      `La plataforma conserva en custodia los registros de ${input.organizationName}, que se dio de baja.`,
      '',
      `El ${dayOf(input.at)} se entregó una copia de registros archivados a ${who} que acreditó su identidad ante el equipo de la plataforma. El equipo de la plataforma no tiene acceso al contenido de esos registros.`,
      '',
      'Este aviso es informativo; no hace falta que responda.',
    ].join('\n'),
  };
}
