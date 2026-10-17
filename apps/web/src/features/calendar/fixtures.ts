import type {
  AppointmentTypeDto,
  CalendarEntryDto,
  LocationDto,
  StaffMemberDto,
} from '@consultorio/contracts';

/** Test data of the scheduling screens: a small center with two professionals and two locations. */
export const IDS = {
  ana: '0190a000-0000-7000-8000-00000000000a',
  beto: '0190a000-0000-7000-8000-00000000000b',
  anaMembership: '0190a000-0000-7000-8000-0000000000a2',
  betoMembership: '0190a000-0000-7000-8000-0000000000a3',
  receptionMembership: '0190a000-0000-7000-8000-0000000000a4',
  central: '0190a000-0000-7000-8000-0000000000c1',
  norte: '0190a000-0000-7000-8000-0000000000c2',
  first: '0190a000-0000-7000-8000-0000000000d1',
  control: '0190a000-0000-7000-8000-0000000000d2',
  patientGomez: '0190a000-0000-7000-8000-0000000000e1',
  patientRios: '0190a000-0000-7000-8000-0000000000e2',
  appointmentGomez: '0190a000-0000-7000-8000-0000000000f1',
  appointmentRios: '0190a000-0000-7000-8000-0000000000f2',
  appointmentCancelled: '0190a000-0000-7000-8000-0000000000f3',
} as const;

export const BA = 'America/Argentina/Buenos_Aires';

export const LOCATIONS: LocationDto[] = [
  { id: IDS.central, name: 'Sede Central', timeZone: BA, active: true },
  { id: IDS.norte, name: 'Consultorios Norte', timeZone: BA, active: true },
];

export const PROFESSIONALS: StaffMemberDto[] = [
  {
    membershipId: IDS.anaMembership,
    displayName: 'Dra. Ana Pérez',
    roles: ['professional'],
    status: 'active',
    email: 'cardiologia@demo.invalid',
    locations: [{ id: IDS.central, name: 'Sede Central' }],
    professional: {
      id: IDS.ana,
      status: 'active',
      specialties: ['Cardiología'],
      matricula: null,
    },
  },
  {
    membershipId: IDS.betoMembership,
    displayName: 'Dr. Beto Ruiz',
    roles: ['professional'],
    status: 'active',
    email: null,
    locations: [{ id: IDS.central, name: 'Sede Central' }],
    professional: {
      id: IDS.beto,
      status: 'active',
      specialties: ['Pediatría'],
      matricula: null,
    },
  },
  {
    membershipId: IDS.receptionMembership,
    displayName: 'Camila Duarte',
    roles: ['reception'],
    status: 'active',
    email: 'recepcion@demo.invalid',
    locations: [{ id: IDS.central, name: 'Sede Central' }],
    professional: null,
  },
];

export const TYPES: AppointmentTypeDto[] = [
  {
    id: IDS.first,
    name: 'Primera consulta',
    description: null,
    durationMinutes: 45,
    bufferMinutes: 0,
    mode: 'in_person',
    priceReference: null,
    requiresApproval: false,
    color: '#0f766e',
    professionalIds: [],
    specialties: [],
    active: true,
  },
  {
    id: IDS.control,
    name: 'Control',
    description: null,
    durationMinutes: 30,
    bufferMinutes: 10,
    mode: 'in_person',
    priceReference: null,
    requiresApproval: false,
    color: '#1d4ed8',
    professionalIds: [],
    specialties: [],
    active: true,
  },
];

export function entry(overrides: Partial<CalendarEntryDto> = {}): CalendarEntryDto {
  return {
    id: IDS.appointmentGomez,
    patientId: IDS.patientGomez,
    professionalId: IDS.ana,
    locationId: IDS.central,
    appointmentTypeId: IDS.control,
    startsAt: '2026-10-17T13:00:00.000Z', // 10:00 in Buenos Aires
    endsAt: '2026-10-17T13:30:00.000Z',
    bufferMinutes: 10,
    status: 'confirmed',
    source: 'staff',
    bookedBy: IDS.receptionMembership,
    identityConfirmed: true,
    identityConfirmation: null,
    outOfHours: false,
    seriesId: null,
    seriesIndex: null,
    version: 3,
    patientName: 'Gómez, Valentina',
    typeName: 'Control',
    typeColor: '#1d4ed8',
    ...overrides,
  };
}

export const FEED_ENTRIES: CalendarEntryDto[] = [
  entry(),
  entry({
    id: IDS.appointmentRios,
    patientId: IDS.patientRios,
    professionalId: IDS.beto,
    appointmentTypeId: IDS.first,
    startsAt: '2026-10-17T14:00:00.000Z',
    endsAt: '2026-10-17T14:45:00.000Z',
    status: 'pending_approval',
    patientName: 'Ríos, Tomás',
    typeName: 'Primera consulta',
    typeColor: '#0f766e',
    version: 1,
  }),
  entry({
    id: IDS.appointmentCancelled,
    startsAt: '2026-10-17T16:00:00.000Z',
    endsAt: '2026-10-17T16:30:00.000Z',
    status: 'cancelled',
    patientName: 'Sosa, Marta',
    version: 2,
  }),
];
