import type { LocationDto, StaffMemberDto } from '@consultorio/contracts';

/** Test data of the staff screens: the people of a small organization. */
export const IDS = {
  owner: '0190a000-0000-7000-8000-0000000000a1',
  professional: '0190a000-0000-7000-8000-0000000000a2',
  reception: '0190a000-0000-7000-8000-0000000000a3',
  deactivated: '0190a000-0000-7000-8000-0000000000a4',
  professionalProfile: '0190a000-0000-7000-8000-0000000000b2',
  central: '0190a000-0000-7000-8000-0000000000c1',
  norte: '0190a000-0000-7000-8000-0000000000c2',
} as const;

export const LOCATIONS: LocationDto[] = [
  {
    id: IDS.central,
    name: 'Sede Central',
    timeZone: 'America/Argentina/Buenos_Aires',
    active: true,
  },
  {
    id: IDS.norte,
    name: 'Consultorios Norte',
    timeZone: 'America/Argentina/Cordoba',
    active: true,
  },
];

export const MEMBERS: StaffMemberDto[] = [
  {
    membershipId: IDS.owner,
    displayName: 'Marcela Quiroga',
    roles: ['owner'],
    status: 'active',
    email: 'propietaria@demo.invalid',
    locations: [{ id: IDS.central, name: 'Sede Central' }],
    professional: null,
  },
  {
    membershipId: IDS.professional,
    displayName: 'Dra. Lucía Paz Ferrer',
    roles: ['professional'],
    status: 'active',
    email: 'cardiologia@demo.invalid',
    locations: [
      { id: IDS.central, name: 'Sede Central' },
      { id: IDS.norte, name: 'Consultorios Norte' },
    ],
    professional: {
      id: IDS.professionalProfile,
      status: 'active',
      specialties: ['Cardiología'],
      matricula: { jurisdiction: 'AR-C', number: '41258', status: 'unverified' },
    },
  },
  {
    membershipId: IDS.reception,
    displayName: 'Camila Duarte',
    roles: ['reception'],
    status: 'active',
    email: 'recepcion@demo.invalid',
    locations: [],
    professional: null,
  },
];

export const DEACTIVATED: StaffMemberDto = {
  membershipId: IDS.deactivated,
  displayName: 'Julián Acosta',
  roles: ['reception'],
  status: 'deactivated',
  email: 'ex@demo.invalid',
  locations: [],
  professional: null,
};
