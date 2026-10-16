import type { StaffRole } from '@consultorio/contracts';

/**
 * DEMO, DEV-ONLY CREDENTIALS. They are public on purpose: they belong to a fictitious
 * organization with fictitious data, they are documented in `docs/demo.md`, and the seed refuses to
 * run when `NODE_ENV=production`. Never reuse them anywhere else, and never put them in a `.env`.
 *
 * The email addresses use the reserved `.invalid` domain (RFC 2606), so nothing sent to them can
 * ever be delivered. A deployed demo organization rotates its passwords on every reset instead
 * (see `resetDemoTenant`, option `rotateCredentials`).
 */
export const DEMO_PASSWORD = 'Demo-Aillu-2026-clave';

export const DEMO_EMAIL_DOMAIN = 'demo.invalid';

export interface DemoAccount {
  /** Stable key of the account inside the seed. */
  key: string;
  email: string;
  roles: readonly StaffRole[];
  /** The role-labelled sign-in shown in the documentation and in the console. */
  label: string;
  displayName: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: 'owner',
    email: `propietaria@${DEMO_EMAIL_DOMAIN}`,
    roles: ['owner'],
    label: 'Propietaria',
    displayName: 'Marcela Quiroga',
  },
  {
    key: 'admin',
    email: `administracion@${DEMO_EMAIL_DOMAIN}`,
    roles: ['admin'],
    label: 'Administración',
    displayName: 'Tomás Beltrán',
  },
  {
    key: 'reception',
    email: `recepcion@${DEMO_EMAIL_DOMAIN}`,
    roles: ['reception'],
    label: 'Recepción (todas las sedes)',
    displayName: 'Camila Duarte',
  },
  {
    key: 'reception-north',
    email: `recepcion.norte@${DEMO_EMAIL_DOMAIN}`,
    roles: ['reception'],
    label: 'Recepción (sede Norte)',
    displayName: 'Julián Acosta',
  },
  {
    key: 'cardiology',
    email: `cardiologia@${DEMO_EMAIL_DOMAIN}`,
    roles: ['professional'],
    label: 'Profesional: Cardiología',
    displayName: 'Dra. Lucía Paz Ferrer',
  },
  {
    key: 'pediatrics',
    email: `pediatria@${DEMO_EMAIL_DOMAIN}`,
    roles: ['professional'],
    label: 'Profesional: Pediatría',
    displayName: 'Dr. Mateo Rivas Ibarra',
  },
  {
    key: 'psychology',
    email: `psicologia@${DEMO_EMAIL_DOMAIN}`,
    roles: ['professional'],
    label: 'Profesional: Psicología',
    displayName: 'Lic. Julia Costa Maidana',
  },
];
