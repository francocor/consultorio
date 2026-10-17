import { describe, expect, it } from 'vitest';

import { CLINICAL_TEMPLATE_KINDS } from '../access.js';

import {
  PLAUSIBLE_LIMITS,
  computeBmi,
  deriveContent,
  deriveCurrentOdontogram,
  isToothCode,
  latestTemplate,
  templateFor,
  templatesForSpecialties,
  validateDraftContent,
  validateSignContent,
  type OdontogramEntry,
} from './index.js';

/** Paths of the field errors of a failed validation. */
function failedPaths(result: ReturnType<typeof validateSignContent>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.path);
}

describe('the template registry', () => {
  it('has a version 1 for every template kind the organization can share', () => {
    for (const kind of CLINICAL_TEMPLATE_KINDS) {
      const template = latestTemplate(kind);
      expect(template?.kind).toBe(kind);
      expect(template?.version).toBe(1);
      expect(template?.labelKey).toBe(`clinical.template.${kind}`);
    }
  });

  it('finds an exact version and refuses an unknown kind or version', () => {
    expect(templateFor('psychology', 1)?.kind).toBe('psychology');
    expect(templateFor('psychology', 2)).toBeUndefined();
    expect(templateFor('astrology', 1)).toBeUndefined();
  });

  it('rejects content for a template kind that does not exist', () => {
    const result = validateDraftContent('astrology', 1, { reasonForConsultation: 'x' });

    expect(result).toEqual({
      ok: false,
      errors: [{ path: '(template)', i18nKey: 'clinical.template.unknown' }],
    });
  });
});

describe('general template', () => {
  const complete = {
    reasonForConsultation: 'Control de presión arterial',
    symptoms: 'Cefalea ocasional',
    measurements: [
      { name: 'Presión arterial', value: '130/85', unit: 'mmHg' },
      { name: 'Peso', value: '72', unit: 'kg' },
    ],
    diagnosis: 'Hipertensión arterial leve',
    plan: 'Dieta hiposódica y control en 30 días',
    medications: [{ name: 'Enalapril', dose: '10 mg', frequency: 'cada 12 horas' }],
  };

  it('accepts a complete note to sign', () => {
    expect(validateSignContent('general', 1, complete)).toEqual({ ok: true, content: complete });
  });

  it('accepts a partial draft', () => {
    expect(validateDraftContent('general', 1, { symptoms: 'Tos' }).ok).toBe(true);
    expect(validateDraftContent('general', 1, {}).ok).toBe(true);
  });

  it('rejects signing without the reason for consultation, and names the field', () => {
    for (const content of [{}, { reasonForConsultation: '' }, { reasonForConsultation: '   ' }]) {
      expect(failedPaths(validateSignContent('general', 1, content))).toEqual([
        'reasonForConsultation',
      ]);
    }
    const result = validateSignContent('general', 1, {});
    expect(result.ok ? null : result.errors[0]?.i18nKey).toBe('validation.required');
  });

  it('rejects fields the template does not define, and values that are too long', () => {
    expect(validateDraftContent('general', 1, { reasonForConsultation: 'x', bmi: 22 }).ok).toBe(
      false,
    );
    expect(failedPaths(validateDraftContent('general', 1, { symptoms: 'x'.repeat(4001) }))).toEqual(
      ['symptoms'],
    );
  });

  it('reports a nested path for a bad measurement', () => {
    const result = validateDraftContent('general', 1, { measurements: [{ name: 'Peso' }] });

    expect(failedPaths(result)).toEqual(['measurements.0.value']);
  });
});

describe('psychology template', () => {
  const session = {
    sessionDate: '2026-05-04',
    modality: 'in_person',
    topics: 'Ansiedad laboral',
    observations: 'Paciente colaborador',
    risk: 'none',
    plan: 'Registro de pensamientos',
  };

  it('accepts a session without risk', () => {
    expect(validateSignContent('psychology', 1, session).ok).toBe(true);
  });

  it('asks for a follow-up note before signing when the risk is medium or high', () => {
    for (const risk of ['medium', 'high']) {
      const result = validateSignContent('psychology', 1, { ...session, risk });
      expect(failedPaths(result)).toEqual(['followUpNote']);
      expect(result.ok ? null : result.errors[0]?.i18nKey).toBe(
        'clinical.psychology.follow_up_required',
      );
    }
    expect(
      validateSignContent('psychology', 1, {
        ...session,
        risk: 'high',
        followUpNote: 'Llamar en 48 h',
      }).ok,
    ).toBe(true);
    expect(validateSignContent('psychology', 1, { ...session, risk: 'low' }).ok).toBe(true);
  });

  it('lets a draft with high risk be saved before the follow-up note is written', () => {
    expect(validateDraftContent('psychology', 1, { ...session, risk: 'high' }).ok).toBe(true);
  });

  it('rejects an unknown modality or risk level, and a bad date', () => {
    expect(
      failedPaths(validateSignContent('psychology', 1, { ...session, modality: 'phone' })),
    ).toEqual(['modality']);
    expect(
      failedPaths(validateSignContent('psychology', 1, { ...session, risk: 'extreme' })),
    ).toEqual(['risk']);
    expect(
      failedPaths(validateDraftContent('psychology', 1, { sessionDate: '04/05/2026' })),
    ).toEqual(['sessionDate']);
  });

  it('requires the session date, the modality and the risk to sign', () => {
    expect(failedPaths(validateSignContent('psychology', 1, { observations: 'x' })).sort()).toEqual(
      ['modality', 'risk', 'sessionDate'],
    );
  });
});

describe('physiotherapy template', () => {
  const session = {
    painIntensity: 6,
    affectedRegion: 'Rodilla derecha',
    sessionNumber: 3,
    totalSessions: 10,
    rangeOfMotion: [{ joint: 'Rodilla', value: 95, unit: 'deg' }],
    functionalTests: 'Sentadilla asistida',
    procedures: 'Ultrasonido, ejercicios isométricos',
    goals: 'Flexión de 120 grados',
  };

  it('accepts pain 6, region "Rodilla derecha" and session 3 of 10', () => {
    expect(validateSignContent('physiotherapy', 1, session).ok).toBe(true);
  });

  it('rejects pain outside 0 to 10 on a draft and on signing, and accepts the limits', () => {
    for (const pain of [-1, 11, 10.5]) {
      expect(
        failedPaths(validateDraftContent('physiotherapy', 1, { painIntensity: pain })),
      ).toEqual(['painIntensity']);
      expect(
        failedPaths(validateSignContent('physiotherapy', 1, { ...session, painIntensity: pain })),
      ).toEqual(['painIntensity']);
    }
    for (const pain of [0, 10]) {
      expect(validateSignContent('physiotherapy', 1, { ...session, painIntensity: pain }).ok).toBe(
        true,
      );
    }
  });

  it('refuses a session number above the planned total', () => {
    const result = validateSignContent('physiotherapy', 1, { ...session, sessionNumber: 11 });

    expect(failedPaths(result)).toEqual(['sessionNumber']);
    expect(validateSignContent('physiotherapy', 1, { ...session, sessionNumber: 10 }).ok).toBe(
      true,
    );
  });

  it('requires pain, region and session number to sign', () => {
    expect(failedPaths(validateSignContent('physiotherapy', 1, {})).sort()).toEqual([
      'affectedRegion',
      'painIntensity',
      'sessionNumber',
    ]);
  });
});

describe('nutrition template', () => {
  const visit = { weightKg: 70, heightM: 1.75, dietaryHabits: 'Cuatro comidas' };

  it('computes the BMI from weight and height: 70 kg and 1.75 m give 22.9', () => {
    expect(computeBmi(70, 1.75)).toBe(22.9);
    expect(computeBmi(90, 1.6)).toBe(35.2);
    expect(computeBmi(0, 1.75)).toBeNull();
    expect(computeBmi(70, 0)).toBeNull();
  });

  it('derives the BMI for the screen without storing it: the field cannot be sent', () => {
    expect(deriveContent('nutrition', visit)).toEqual({ bmi: 22.9 });
    expect(deriveContent('nutrition', { dietaryHabits: 'x' })).toEqual({ bmi: null });
    expect(deriveContent('general', visit)).toEqual({});
    expect(validateDraftContent('nutrition', 1, { ...visit, bmi: 99 }).ok).toBe(false);
  });

  it('requires a positive weight and height', () => {
    for (const bad of [0, -3]) {
      expect(failedPaths(validateDraftContent('nutrition', 1, { weightKg: bad }))).toEqual([
        'weightKg',
      ]);
      expect(failedPaths(validateDraftContent('nutrition', 1, { heightM: bad }))).toEqual([
        'heightM',
      ]);
    }
    expect(failedPaths(validateSignContent('nutrition', 1, { weightKg: 70 }))).toEqual(['heightM']);
  });

  it('asks for a confirmation when a value is implausible (17.5 m), and accepts it once confirmed', () => {
    const bad = validateDraftContent('nutrition', 1, { weightKg: 70, heightM: 17.5 });
    expect(failedPaths(bad)).toEqual(['heightM']);
    expect(bad.ok ? null : bad.errors[0]?.i18nKey).toBe('clinical.nutrition.implausible');

    expect(
      validateDraftContent('nutrition', 1, {
        weightKg: 70,
        heightM: 17.5,
        confirmImplausible: true,
      }).ok,
    ).toBe(true);
    expect(
      failedPaths(validateSignContent('nutrition', 1, { weightKg: 700, heightM: 1.7 })),
    ).toEqual(['weightKg']);
    expect(PLAUSIBLE_LIMITS.heightM).toEqual({ min: 0.4, max: 2.5 });
  });

  it('accepts the values at the limits of the plausible range', () => {
    expect(
      validateSignContent('nutrition', 1, {
        weightKg: PLAUSIBLE_LIMITS.weightKg.max,
        heightM: PLAUSIBLE_LIMITS.heightM.min,
      }).ok,
    ).toBe(true);
  });
});

describe('odontology template and its odontogram', () => {
  const exam = {
    reasonForConsultation: 'Dolor en molar',
    odontogram: {
      '16': {
        condition: 'caries',
        surfaces: { occlusal: { finding: 'caries', treatment: 'Restauración' } },
      },
      '55': { condition: 'healthy' },
    },
    treatmentPlan: 'Restaurar la pieza 16',
  };

  it('accepts permanent and primary teeth in FDI notation', () => {
    expect(validateSignContent('odontology', 1, exam).ok).toBe(true);
  });

  it('knows exactly the FDI tooth codes: 32 permanent and 20 primary', () => {
    const teeth = (quadrants: number[], count: number) =>
      quadrants.flatMap((quadrant) =>
        Array.from({ length: count }, (_, index) => `${String(quadrant)}${String(index + 1)}`),
      );
    const permanent = teeth([1, 2, 3, 4], 8);
    const primary = teeth([5, 6, 7, 8], 5);
    expect(permanent).toHaveLength(32);
    expect(primary).toHaveLength(20);
    expect(permanent.every(isToothCode)).toBe(true);
    expect(primary.every(isToothCode)).toBe(true);
    for (const bad of ['19', '00', '9', '49', '56', '86', '111', 'a1', '', '1.6']) {
      expect(isToothCode(bad), bad).toBe(false);
    }
  });

  it('rejects an invalid tooth number with a validation message at the tooth', () => {
    const result = validateDraftContent('odontology', 1, {
      odontogram: { '19': { condition: 'caries' } },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      {
        path: expect.stringMatching(/^odontogram/) as unknown,
        i18nKey: 'clinical.odontology.invalid_tooth',
      },
    ]);
  });

  it('rejects an unknown condition, surface or finding', () => {
    expect(
      validateDraftContent('odontology', 1, { odontogram: { '16': { condition: 'sparkly' } } }).ok,
    ).toBe(false);
    expect(
      validateDraftContent('odontology', 1, {
        odontogram: { '16': { surfaces: { top: { finding: 'caries' } } } },
      }).ok,
    ).toBe(false);
    expect(
      validateDraftContent('odontology', 1, {
        odontogram: { '16': { surfaces: { mesial: { finding: 'shiny' } } } },
      }).ok,
    ).toBe(false);
  });

  it('derives the current odontogram from the signed series without overwriting the earlier state', () => {
    const entries: OdontogramEntry[] = [
      {
        signedAt: '2026-03-01T10:00:00.000Z',
        authorProfessionalId: 'dentist-1',
        odontogram: {
          '16': { condition: 'caries', surfaces: { occlusal: { finding: 'caries' } } },
          '26': { condition: 'healthy' },
        },
      },
      {
        signedAt: '2026-05-01T10:00:00.000Z',
        authorProfessionalId: 'dentist-2',
        odontogram: {
          '16': { condition: 'restoration', surfaces: { occlusal: { finding: 'restoration' } } },
        },
      },
    ];

    const current = deriveCurrentOdontogram(entries);

    expect(current['16']).toMatchObject({
      condition: 'restoration',
      surfaces: { occlusal: { finding: 'restoration' } },
      updatedAt: '2026-05-01T10:00:00.000Z',
      authorProfessionalId: 'dentist-2',
    });
    expect(current['26']).toMatchObject({
      condition: 'healthy',
      updatedAt: '2026-03-01T10:00:00.000Z',
    });
    // The input is untouched: the earlier signed state still says "caries".
    expect(entries[0]?.odontogram['16']?.condition).toBe('caries');
    // Order of the series does not matter, the signature date does.
    expect(deriveCurrentOdontogram([...entries].reverse())['16']?.condition).toBe('restoration');
    expect(deriveCurrentOdontogram([])).toEqual({});
  });
});

describe('which templates a professional is offered', () => {
  it('offers the generic template plus the ones of every specialty', () => {
    expect(templatesForSpecialties(['Kinesiología', 'Nutrición'])).toEqual([
      'general',
      'physiotherapy',
      'nutrition',
    ]);
    expect(templatesForSpecialties(['Odontología', 'Psicología'])).toEqual([
      'general',
      'odontology',
      'psychology',
    ]);
  });

  it('falls back to the generic template for a specialty that has none', () => {
    expect(templatesForSpecialties(['Cardiología'])).toEqual(['general']);
    expect(templatesForSpecialties([])).toEqual(['general']);
  });

  it('matches accents, case and common spellings', () => {
    expect(templatesForSpecialties(['PSICOLOGÍA CLÍNICA'])).toContain('psychology');
    expect(templatesForSpecialties(['Fisioterapia'])).toContain('physiotherapy');
    expect(templatesForSpecialties(['odontologa'])).toContain('odontology');
    expect(templatesForSpecialties(['Lic. en nutricion'])).toContain('nutrition');
  });
});
