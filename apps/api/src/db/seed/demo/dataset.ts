import {
  AILLU_PRESET,
  type AddendumKind,
  type AnamnesisContent,
  type ClinicalTemplateKind,
  type Role,
} from '@consultorio/contracts';

import { DEMO_ACCOUNTS, DEMO_EMAIL_DOMAIN } from './credentials.js';
import { createRng, type Rng } from './rng.js';

/**
 * The content of the demo organization, as plain data. Everything is fictitious: names are
 * generic, documents live in the synthetic block 99.000.xxx, phones are `+54 11 0000 xxxx` (no
 * such line exists) and emails use the reserved `.invalid` domain, so nothing here can reach a
 * real person. The data is a pure function of a fixed seed: running it twice gives equal results.
 */

const SEED = 20_260_101;

export interface DemoLocation {
  key: string;
  name: string;
  timeZone: string;
}

export interface DemoHours {
  location: string;
  /** 1 = Monday ... 7 = Sunday */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface DemoStaff {
  key: string;
  email: string;
  displayName: string;
  roles: readonly Role[];
  /** Keys of the locations the person works at. */
  locations: readonly string[];
  professional?: {
    specialties: readonly string[];
    jurisdiction: string;
    matricula: string;
    hours: readonly DemoHours[];
  };
}

export interface DemoPatient {
  familyName: string;
  givenNames: string;
  birthDate: string;
  sex: 'female' | 'male';
  document: { type: 'dni'; number: string } | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  coverage: { payerCode: string; planName: string; memberNumber: string } | null;
  /** The data-processing consent was recorded at registration. */
  consent: boolean;
  representative?: {
    fullName: string;
    relation: 'mother' | 'father' | 'guardian';
    phone: string;
    email: string;
  };
}

/**
 * Who looks after whom: a professional is assigned to a patient (by position in `patients`), and
 * may have recorded the anamnesis. The anamnesis is what raises the safety alerts reception sees
 * as "consult the professional".
 */
export interface DemoCare {
  professional: 'cardiology' | 'pediatrics' | 'psychology';
  patientIndex: number;
  anamnesis?: AnamnesisContent;
}

/**
 * A clinical note the demo professionals wrote, so the chart, the search and the drafts view have
 * something to show. `state` is `signed` unless said otherwise: a `draft` stays unsigned, an `error`
 * is signed and then marked entered in error (with the reason). A note may carry one addendum.
 * The professional must be the one assigned to the patient in `care`.
 */
export interface DemoNote {
  professional: DemoCare['professional'];
  patientIndex: number;
  templateKind: ClinicalTemplateKind;
  content: Record<string, unknown>;
  state?: 'signed' | 'draft' | 'error';
  errorReason?: string;
  visibility?: 'default' | 'author_only';
  addendum?: { kind: AddendumKind; reason: string; text: string };
}

export interface DemoDataset {
  branding: {
    displayName: string;
    shortName: string;
    primaryColor: string;
    radius: string;
    headingFont: string;
  };
  locations: readonly DemoLocation[];
  staff: readonly DemoStaff[];
  /** Payer plans the organization has enabled, from the platform catalog. */
  payerPlans: readonly { payerCode: string; planName: string }[];
  patients: readonly DemoPatient[];
  care: readonly DemoCare[];
  notes: readonly DemoNote[];
}

const LOCATIONS: readonly DemoLocation[] = [
  { key: 'central', name: 'Sede Central', timeZone: 'America/Argentina/Buenos_Aires' },
  { key: 'norte', name: 'Consultorios Norte', timeZone: 'America/Argentina/Buenos_Aires' },
  { key: 'cordoba', name: 'Sucursal Córdoba', timeZone: 'America/Argentina/Cordoba' },
];

const hours = (
  location: string,
  weekdays: readonly number[],
  from: number,
  to: number,
): DemoHours[] =>
  weekdays.map((weekday) => ({
    location,
    weekday,
    startMinute: from * 60,
    endMinute: to * 60,
  }));

const PROFESSIONALS: Readonly<Record<string, NonNullable<DemoStaff['professional']>>> = {
  cardiology: {
    specialties: ['Cardiología'],
    jurisdiction: 'AR-C',
    matricula: '41258',
    hours: [...hours('central', [1, 3, 5], 9, 13), ...hours('cordoba', [2], 15, 19)],
  },
  pediatrics: {
    specialties: ['Pediatría'],
    jurisdiction: 'AR-B',
    matricula: '188204',
    hours: [...hours('central', [2, 4], 14, 19), ...hours('norte', [1], 9, 12)],
  },
  psychology: {
    specialties: ['Psicología'],
    jurisdiction: 'AR-X',
    matricula: '9117',
    hours: hours('norte', [1, 2, 3, 4], 15, 20),
  },
};

const LOCATIONS_OF: Readonly<Record<string, readonly string[]>> = {
  owner: ['central', 'norte', 'cordoba'],
  admin: ['central', 'norte', 'cordoba'],
  reception: ['central', 'norte'],
  'reception-north': ['norte'],
  cardiology: ['central', 'cordoba'],
  pediatrics: ['central', 'norte'],
  psychology: ['norte'],
};

function buildStaff(): DemoStaff[] {
  return DEMO_ACCOUNTS.map((account) => {
    const professional = PROFESSIONALS[account.key];
    return {
      key: account.key,
      email: account.email,
      displayName: account.displayName,
      roles: account.roles,
      locations: LOCATIONS_OF[account.key] ?? ['central'],
      ...(professional ? { professional } : {}),
    };
  });
}

const PAYER_PLANS = [
  { payerCode: 'osde', planName: '210' },
  { payerCode: 'osde', planName: '310' },
  { payerCode: 'swiss_medical', planName: 'SMG20' },
  { payerCode: 'galeno', planName: 'Oro' },
  { payerCode: 'medife', planName: 'Plata' },
  { payerCode: 'pami', planName: 'Afiliado' },
  { payerCode: 'ioma', planName: 'Afiliado' },
] as const;

/** [family name, given names, sex, birth year, plan index or null, consent] */
const PEOPLE: readonly [string, string, 'female' | 'male', number, number | null, boolean][] = [
  ['Gómez', 'Valentina', 'female', 1988, 0, true],
  ['Rodríguez', 'Santiago', 'male', 1975, 1, true],
  ['Fernández Ruiz', 'Martina', 'female', 1992, 2, true],
  ['López', 'Joaquín', 'male', 1964, 5, true],
  ['Martínez', 'Sofía Belén', 'female', 2001, 3, true],
  ['Sánchez', 'Benjamín', 'male', 1983, null, true],
  ['Pérez Molina', 'Camila', 'female', 1979, 0, true],
  ['Romero', 'Facundo', 'male', 1996, 4, true],
  ['Díaz', 'Julieta', 'female', 1958, 5, true],
  ['Torres', 'Nicolás Andrés', 'male', 1971, 1, true],
  ['Álvarez', 'Florencia', 'female', 1990, 2, true],
  ['Ruiz', 'Emiliano', 'male', 1985, null, true],
  ['Suárez', 'Pilar', 'female', 1949, 6, true],
  ['Herrera', 'Bautista', 'male', 1999, 3, false],
  ['Medina', 'Renata', 'female', 1967, 0, true],
  ['Castro', 'Lautaro', 'male', 1981, null, true],
  ['Ortiz', 'Milagros', 'female', 1994, 4, true],
  ['Silva', 'Agustín', 'male', 1953, 5, true],
  ['Molina', 'Abril', 'female', 1987, null, true],
  ['Rojas', 'Tomás', 'male', 1973, 1, true],
  ['Vega', 'Antonella', 'female', 1998, 2, true],
  ['Aguirre', 'Ramiro', 'male', 1961, null, true],
  ['Domínguez', 'Isabella', 'female', 2019, 0, true],
  ['Benítez', 'Thiago', 'male', 2016, 3, true],
  ['Acosta', 'Delfina', 'female', 2012, 4, true],
];

const STREETS = [
  'Calle Demo',
  'Avenida de Prueba',
  'Pasaje Ficticio',
  'Calle Ejemplo',
  'Avenida Simulada',
] as const;

const GUARDIANS = [
  ['Lorena', 'mother'],
  ['Gustavo', 'father'],
  ['Natalia', 'mother'],
] as const;

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

function birthDate(rng: Rng, year: number): string {
  const month = String(rng.int(1, 12)).padStart(2, '0');
  const day = String(rng.int(1, 28)).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

function phone(rng: Rng): string {
  return `+54 11 0000 ${String(rng.int(0, 9999)).padStart(4, '0')}`;
}

function buildPatients(rng: Rng): DemoPatient[] {
  const patients: DemoPatient[] = PEOPLE.map(
    ([familyName, givenNames, sex, year, planIndex, consent], index) => {
      const plan = planIndex === null ? undefined : PAYER_PLANS[planIndex];
      const isMinor = year > 2008;
      const guardian = isMinor ? GUARDIANS[index % GUARDIANS.length] : undefined;
      const owner = `${slug(givenNames.split(' ')[0] ?? givenNames)}.${slug(familyName.split(' ')[0] ?? familyName)}`;
      return {
        familyName,
        givenNames,
        birthDate: birthDate(rng, year),
        sex,
        document: { type: 'dni', number: `99000${String(index + 1).padStart(3, '0')}` },
        phone: isMinor ? null : phone(rng),
        email: isMinor ? null : `${owner}@${DEMO_EMAIL_DOMAIN}`,
        address: `${rng.pick(STREETS)} ${String(rng.int(100, 4999))}, Ciudad de Buenos Aires`,
        coverage: plan
          ? {
              payerCode: plan.payerCode,
              planName: plan.planName,
              memberNumber: `${String(rng.int(1_000_000, 9_999_999))}/${String(rng.int(0, 9))}`,
            }
          : null,
        consent,
        ...(guardian
          ? {
              representative: {
                fullName: `${guardian[0]} ${familyName.split(' ')[0] ?? familyName}`,
                relation: guardian[1],
                phone: phone(rng),
                email: `${slug(guardian[0])}.${slug(familyName.split(' ')[0] ?? familyName)}@${DEMO_EMAIL_DOMAIN}`,
              },
            }
          : {}),
      };
    },
  );

  // A newborn who has no identity document yet: registered with a name and a birth date.
  patients.push({
    familyName: 'Navarro',
    givenNames: 'Ian',
    birthDate: '2025-11-20',
    sex: 'male',
    document: null,
    phone: null,
    email: null,
    address: null,
    coverage: null,
    consent: true,
    representative: {
      fullName: 'Paula Navarro',
      relation: 'mother',
      phone: phone(rng),
      email: `paula.navarro@${DEMO_EMAIL_DOMAIN}`,
    },
  });
  return patients;
}

const NONE = { pregnant: false, implantedDevice: false, anticoagulated: false } as const;

/** Positions are those of `PEOPLE` (and the newborn added after them, index 25). */
const CARE: readonly DemoCare[] = [
  {
    professional: 'cardiology',
    patientIndex: 0,
    anamnesis: {
      allergies: [{ substance: 'Penicilina', reaction: 'Urticaria', severity: 'severe' }],
      medications: [{ name: 'Enalapril', dose: '10 mg por día' }],
      conditions: [{ name: 'Hipertensión arterial', since: '2019' }],
      antecedents: 'Madre con diabetes tipo 2. No fuma. Realiza caminatas tres veces por semana.',
      indicators: NONE,
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 1,
    anamnesis: {
      allergies: [],
      medications: [{ name: 'Acenocumarol', dose: '2 mg por día', anticoagulant: true }],
      conditions: [{ name: 'Fibrilación auricular', since: '2021' }],
      antecedents: 'Control de anticoagulación cada 30 días. Marcapasos colocado en 2022.',
      indicators: { pregnant: false, implantedDevice: true, anticoagulated: true },
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 2,
    anamnesis: {
      allergies: [],
      medications: [],
      conditions: [{ name: 'Migraña', since: '2015' }],
      antecedents: 'Sin antecedentes cardiovasculares. Consulta por control de rutina.',
      indicators: NONE,
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 3,
    anamnesis: {
      allergies: [{ substance: 'Ácido acetilsalicílico', severity: 'moderate' }],
      medications: [{ name: 'Metformina', dose: '850 mg dos veces por día' }],
      conditions: [{ name: 'Diabetes tipo 2', since: '2012' }],
      antecedents: 'Control glucémico regular.',
      indicators: NONE,
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 4,
    anamnesis: {
      allergies: [],
      medications: [{ name: 'Ácido fólico', dose: '5 mg por día' }],
      conditions: [],
      antecedents: 'Embarazo de 22 semanas, control cardiológico por palpitaciones.',
      indicators: { pregnant: true, implantedDevice: false, anticoagulated: false },
    },
  },
  { professional: 'cardiology', patientIndex: 8 },
  {
    professional: 'pediatrics',
    patientIndex: 22,
    anamnesis: {
      allergies: [
        { substance: 'Proteína de la leche de vaca', reaction: 'Eccema', severity: 'mild' },
      ],
      medications: [],
      conditions: [],
      antecedents: 'Lactancia materna hasta los 8 meses. Vacunas al día.',
      indicators: NONE,
    },
  },
  {
    professional: 'pediatrics',
    patientIndex: 23,
    anamnesis: {
      allergies: [],
      medications: [],
      conditions: [],
      antecedents: 'Controles de salud al día. Sin antecedentes de relevancia.',
      indicators: NONE,
    },
  },
  {
    professional: 'pediatrics',
    patientIndex: 24,
    anamnesis: {
      allergies: [],
      medications: [{ name: 'Salbutamol', dose: '2 disparos por crisis' }],
      conditions: [{ name: 'Asma leve', since: '2020' }],
      antecedents: 'Crisis ocasionales con los cambios de estación.',
      indicators: NONE,
    },
  },
  { professional: 'pediatrics', patientIndex: 25 },
  {
    professional: 'psychology',
    patientIndex: 6,
    anamnesis: {
      allergies: [],
      medications: [],
      conditions: [],
      antecedents: 'Consulta por estrés laboral. Primera entrevista realizada.',
      indicators: NONE,
    },
  },
  { professional: 'psychology', patientIndex: 7 },
];

const NOTES: readonly DemoNote[] = [
  // Cardiology: the general template.
  {
    professional: 'cardiology',
    patientIndex: 0,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control de hipertensión arterial',
      symptoms: 'Sin cefalea ni palpitaciones. Refiere buena adherencia al tratamiento.',
      measurements: [
        { name: 'Presión arterial', value: '128/82', unit: 'mmHg' },
        { name: 'Frecuencia cardíaca', value: '72', unit: 'lpm' },
        { name: 'Peso', value: '68', unit: 'kg' },
      ],
      diagnosis: 'Hipertensión arterial controlada',
      plan: 'Continuar con el tratamiento actual. Reducir el consumo de sal. Control en tres meses.',
      medications: [{ name: 'Enalapril', dose: '10 mg', frequency: 'una vez por día' }],
    },
    addendum: {
      kind: 'correction',
      reason: 'Se precisa el horario de la dosis',
      text: 'El enalapril se toma por la mañana, en ayunas.',
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 1,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control de anticoagulación y del marcapasos',
      symptoms: 'Sin sangrados ni mareos. Concurre con el último resultado de laboratorio.',
      measurements: [
        { name: 'INR', value: '2,4' },
        { name: 'Presión arterial', value: '134/80', unit: 'mmHg' },
        { name: 'Frecuencia cardíaca', value: '64', unit: 'lpm' },
      ],
      diagnosis: 'Fibrilación auricular anticoagulada, con INR en rango',
      plan: 'Mantener la dosis de acenocumarol. Control de INR en 30 días. Control del marcapasos en seis meses.',
      medications: [{ name: 'Acenocumarol', dose: '2 mg', frequency: 'una vez por día' }],
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 2,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control cardiológico de rutina',
      symptoms: 'Asintomática. Migrañas ocasionales, sin relación con el esfuerzo.',
      measurements: [{ name: 'Presión arterial', value: '112/70', unit: 'mmHg' }],
      diagnosis: 'Examen cardiovascular normal',
      plan: 'Sin indicaciones. Repetir el control en un año.',
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 3,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Dolor opresivo en el pecho al subir escaleras',
      symptoms: 'Dos episodios en el último mes, de unos cinco minutos, que ceden con el reposo.',
      measurements: [
        { name: 'Presión arterial', value: '142/88', unit: 'mmHg' },
        { name: 'Frecuencia cardíaca', value: '78', unit: 'lpm' },
      ],
      diagnosis: 'Angina de esfuerzo a confirmar',
      plan: 'Prueba ergométrica y laboratorio completo. No indicar ácido acetilsalicílico por la alergia registrada. Control con los resultados.',
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 4,
    templateKind: 'general',
    state: 'draft',
    content: {
      reasonForConsultation: 'Palpitaciones durante el embarazo',
      symptoms: 'Episodios breves, de pocos segundos, sobre todo al acostarse.',
    },
  },
  {
    professional: 'cardiology',
    patientIndex: 8,
    templateKind: 'general',
    state: 'error',
    errorReason: 'La nota se cargó en la paciente equivocada',
    content: {
      reasonForConsultation: 'Control de presión arterial',
      measurements: [{ name: 'Presión arterial', value: '150/95', unit: 'mmHg' }],
      diagnosis: 'Hipertensión arterial',
    },
  },
  // Pediatrics: the general template, with the measurements of a child.
  {
    professional: 'pediatrics',
    patientIndex: 22,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control de salud de la niña',
      symptoms: 'Sin molestias. Eccema leve en los pliegues, estable.',
      measurements: [
        { name: 'Peso', value: '22', unit: 'kg' },
        { name: 'Talla', value: '120', unit: 'cm' },
      ],
      diagnosis: 'Control de salud normal. Alergia a la proteína de la leche de vaca.',
      plan: 'Calendario de vacunación al día. Mantener la dieta sin lácteos de vaca. Próximo control en doce meses.',
    },
  },
  {
    professional: 'pediatrics',
    patientIndex: 23,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control de salud para el inicio de las clases',
      measurements: [
        { name: 'Peso', value: '34', unit: 'kg' },
        { name: 'Talla', value: '141', unit: 'cm' },
      ],
      diagnosis: 'Desarrollo acorde a la edad',
      plan: 'Apto para las actividades escolares y deportivas. Control visual anual.',
    },
  },
  {
    professional: 'pediatrics',
    patientIndex: 24,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control de asma',
      symptoms:
        'Dos crisis leves en el último mes, con tos nocturna que cedió con el broncodilatador.',
      measurements: [{ name: 'Saturación de oxígeno', value: '98', unit: '%' }],
      diagnosis: 'Asma leve intermitente',
      plan: 'Revisión de la técnica de inhalación. Evitar los desencadenantes conocidos. Control en tres meses.',
      medications: [{ name: 'Salbutamol', dose: '2 disparos', frequency: 'por crisis' }],
    },
  },
  {
    professional: 'pediatrics',
    patientIndex: 25,
    templateKind: 'general',
    content: {
      reasonForConsultation: 'Control del recién nacido',
      symptoms: 'Lactancia materna exclusiva, buena succión y deposiciones normales.',
      measurements: [
        { name: 'Peso', value: '4,2', unit: 'kg' },
        { name: 'Perímetro cefálico', value: '37', unit: 'cm' },
      ],
      diagnosis: 'Crecimiento adecuado',
      plan: 'Continuar con la lactancia. Aplicar las vacunas de los dos meses. Próximo control en cuatro semanas.',
    },
  },
  // Psychology: its own template; one session is restricted to its author.
  {
    professional: 'psychology',
    patientIndex: 6,
    templateKind: 'psychology',
    content: {
      sessionDate: '2026-09-14',
      modality: 'in_person',
      topics: 'Estrés laboral y dificultad para dormir',
      observations: 'Se muestra colaboradora. Refiere sobrecarga de tareas desde hace seis meses.',
      risk: 'none',
      plan: 'Registro semanal del sueño y ejercicios de respiración. Próxima sesión en dos semanas.',
    },
  },
  {
    professional: 'psychology',
    patientIndex: 6,
    templateKind: 'psychology',
    content: {
      sessionDate: '2026-09-28',
      modality: 'virtual',
      topics: 'Rumiación nocturna y límites con el trabajo',
      observations:
        'Mejoró la rutina de sueño, pero persisten los despertares. Refiere desánimo los fines de semana.',
      risk: 'medium',
      followUpNote: 'Se acuerda un contacto telefónico a la semana si el insomnio empeora.',
      plan: 'Continuar con el registro del sueño. Trabajar la organización de las tareas.',
    },
  },
  {
    professional: 'psychology',
    patientIndex: 7,
    templateKind: 'psychology',
    visibility: 'author_only',
    content: {
      sessionDate: '2026-09-21',
      modality: 'in_person',
      topics: 'Primera entrevista',
      observations: 'Consulta por ansiedad ante exámenes. Sin antecedentes de tratamiento previo.',
      risk: 'low',
      plan: 'Definir objetivos en la segunda sesión.',
    },
  },
];

export function buildDemoDataset(): DemoDataset {
  const rng = createRng(SEED);
  return {
    branding: {
      displayName: AILLU_PRESET.displayName,
      shortName: AILLU_PRESET.shortName,
      primaryColor: AILLU_PRESET.primaryColor,
      radius: AILLU_PRESET.radius,
      headingFont: AILLU_PRESET.headingFont,
    },
    locations: LOCATIONS,
    staff: buildStaff(),
    payerPlans: PAYER_PLANS,
    patients: buildPatients(rng),
    care: CARE,
    notes: NOTES,
  };
}
