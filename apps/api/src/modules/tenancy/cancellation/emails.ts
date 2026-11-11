import type { ExportKind } from '../application/export-registry.js';

/**
 * The notice that a package of the cancellation export is ready. It names the organization and where
 * to go, and nothing else: no patient, no record, no file name, and no link to the file itself (the
 * download link is issued inside the product, to the signed-in session, and lasts minutes).
 */

export interface ReadyNotice {
  subject: string;
  text: string;
}

export function packageReadyNotice(
  kind: ExportKind,
  input: { organizationName: string; url: string },
): ReadyNotice {
  if (kind === 'clinical') {
    return {
      subject: `Su exportación clínica de ${input.organizationName} está lista`,
      text: [
        `La organización ${input.organizationName} fue dada de baja y su paquete clínico ya está listo para descargar.`,
        '',
        'Contiene los registros de los pacientes que usted atiende. Es personal: solo usted puede descargarlo, desde su cuenta.',
        '',
        `Ingrese con su usuario en ${input.url} y elija "Descargar". El enlace de descarga vence a los pocos minutos y puede pedir uno nuevo cuando lo necesite.`,
      ].join('\n'),
    };
  }
  return {
    subject: `La exportación administrativa de ${input.organizationName} está lista`,
    text: [
      `La organización ${input.organizationName} fue dada de baja y el paquete administrativo de su información ya está listo para descargar.`,
      '',
      'Contiene los datos de la organización, el personal, los pacientes y su cobertura, la agenda, los cobros y facturas, y el registro de auditoría. No incluye información clínica: cada profesional recibe la suya por separado.',
      '',
      `Ingrese con su usuario titular en ${input.url} y elija "Descargar". El enlace de descarga vence a los pocos minutos y puede pedir uno nuevo cuando lo necesite.`,
    ].join('\n'),
  };
}
