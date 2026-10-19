import { PortalFrame } from './PortalFrame.js';
import { AppointmentsSection } from './sections/AppointmentsSection.js';
import { ConsentDetail } from './sections/ConsentDetail.js';
import { ConsentsSection } from './sections/ConsentsSection.js';
import { DocumentsSection } from './sections/DocumentsSection.js';
import { InvoicesSection } from './sections/InvoicesSection.js';
import { PrescriptionsSection } from './sections/PrescriptionsSection.js';
import { ProfileSection } from './sections/ProfileSection.js';
import { SessionsSection } from './sections/SessionsSection.js';

/**
 * The screens of the portal, one per address. Each one sits in the frame (who is signed in, whose
 * record is shown) and hands its section the record that is shown. They are loaded together, the
 * first time a patient opens the portal: the staff application never pays for them.
 */
export function AppointmentsPage() {
  return <PortalFrame>{({ link }) => <AppointmentsSection link={link} />}</PortalFrame>;
}

export function DocumentsPage() {
  return <PortalFrame>{({ link }) => <DocumentsSection link={link} />}</PortalFrame>;
}

export function ConsentsPage() {
  return <PortalFrame>{({ link }) => <ConsentsSection link={link} />}</PortalFrame>;
}

export function ConsentPage({ consentId }: { consentId: string }) {
  return (
    <PortalFrame>{({ link }) => <ConsentDetail link={link} consentId={consentId} />}</PortalFrame>
  );
}

export function PrescriptionsPage() {
  return <PortalFrame>{({ link }) => <PrescriptionsSection link={link} />}</PortalFrame>;
}

export function InvoicesPage() {
  return <PortalFrame>{({ link }) => <InvoicesSection link={link} />}</PortalFrame>;
}

export function ProfilePage() {
  return <PortalFrame>{({ link }) => <ProfileSection link={link} />}</PortalFrame>;
}

export function SessionsPage() {
  return <PortalFrame>{() => <SessionsSection />}</PortalFrame>;
}
