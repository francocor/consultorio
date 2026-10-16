import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHARED_TEMPLATES,
  PSYCHOLOGY_TEMPLATE,
  initialSharedTemplates,
  readable,
  readableBasis,
  sharedReadAuditReason,
  type ClinicalEntry,
  type SharingSettings,
} from './sharing-scope.js';

const ME = 'professional-me';
const COLLEAGUE = 'professional-colleague';
const PATIENT = 'patient-1';

const SHARING_ON: SharingSettings = {
  clinicalSharing: true,
  sharedTemplates: ['general', 'odontology', 'physiotherapy', 'nutrition'],
};
const SHARING_OFF: SharingSettings = { clinicalSharing: false, sharedTemplates: [] };

function note(over: Partial<ClinicalEntry> = {}): ClinicalEntry {
  return {
    kind: 'note',
    patientId: PATIENT,
    authorProfessionalId: COLLEAGUE,
    visibility: 'default',
    templateKind: 'general',
    ...over,
  };
}

const verdict = (
  entry: ClinicalEntry,
  options: { treating?: boolean; settings?: SharingSettings; me?: string } = {},
) =>
  readableBasis({
    entry,
    professionalId: options.me ?? ME,
    treating: options.treating ?? false,
    settings: options.settings ?? SHARING_OFF,
  });

describe('the author', () => {
  it('always reads their own entry, whatever the settings and whoever treats the patient', () => {
    for (const settings of [SHARING_ON, SHARING_OFF]) {
      for (const visibility of ['default', 'author_only'] as const) {
        expect(verdict(note({ authorProfessionalId: ME, visibility }), { settings })).toEqual({
          readable: true,
          basis: 'author',
        });
      }
    }
  });

  it('reads their own entry even after losing the care relationship', () => {
    expect(verdict(note({ authorProfessionalId: ME }), { treating: false })).toEqual({
      readable: true,
      basis: 'author',
    });
  });
});

describe('treating professionals (sharing off)', () => {
  it('read the entries of a patient they treat', () => {
    expect(verdict(note(), { treating: true })).toEqual({ readable: true, basis: 'treating' });
  });

  it('cannot read the entries of a patient they do not treat', () => {
    expect(verdict(note(), { treating: false })).toEqual({ readable: false });
  });

  it('read every kind of entry of a treated patient, prescriptions included', () => {
    for (const kind of ['note', 'anamnesis', 'document', 'consent', 'prescription'] as const) {
      const entry = note({ kind, ...(kind === 'note' ? {} : { templateKind: null }) });
      expect(verdict(entry, { treating: true }), kind).toEqual({
        readable: true,
        basis: 'treating',
      });
    }
  });
});

describe('author_only', () => {
  it('hides the entry from a treating professional', () => {
    expect(verdict(note({ visibility: 'author_only' }), { treating: true })).toEqual({
      readable: false,
    });
  });

  it('hides the entry from a non-treating one even when sharing includes the template', () => {
    expect(
      verdict(note({ visibility: 'author_only' }), { settings: SHARING_ON, treating: false }),
    ).toEqual({ readable: false });
  });

  it('hides the entry whatever the sharing settings and treatment are', () => {
    for (const treating of [true, false]) {
      for (const settings of [SHARING_ON, SHARING_OFF]) {
        expect(verdict(note({ visibility: 'author_only' }), { treating, settings })).toEqual({
          readable: false,
        });
      }
    }
  });
});

describe('sharing (read-only access for colleagues who do not treat the patient)', () => {
  it('lets a non-treating professional read a template that is in the shared scope', () => {
    for (const template of SHARING_ON.sharedTemplates) {
      expect(verdict(note({ templateKind: template }), { settings: SHARING_ON })).toEqual({
        readable: true,
        basis: 'shared',
      });
    }
  });

  it('does not share anything while sharing is off, even a listed template', () => {
    expect(verdict(note(), { settings: { ...SHARING_ON, clinicalSharing: false } })).toEqual({
      readable: false,
    });
  });

  it('excludes psychology by default (not on the initial list)', () => {
    expect(verdict(note({ templateKind: 'psychology' }), { settings: SHARING_ON })).toEqual({
      readable: false,
    });
  });

  it('shares psychology only when the organization explicitly added it', () => {
    const withPsychology = {
      ...SHARING_ON,
      sharedTemplates: [...SHARING_ON.sharedTemplates, PSYCHOLOGY_TEMPLATE],
    };

    expect(verdict(note({ templateKind: 'psychology' }), { settings: withPsychology })).toEqual({
      readable: true,
      basis: 'shared',
    });
  });

  it('never adds a template published later: it is not shared until the owner lists it', () => {
    expect(verdict(note({ templateKind: 'dermatology' }), { settings: SHARING_ON })).toEqual({
      readable: false,
    });
    expect(
      verdict(note({ templateKind: 'dermatology' }), {
        settings: {
          ...SHARING_ON,
          sharedTemplates: [...SHARING_ON.sharedTemplates, 'dermatology'],
        },
      }),
    ).toEqual({ readable: true, basis: 'shared' });
  });

  it.each(['anamnesis', 'document', 'consent'] as const)(
    'shares %s under the general ceiling when sharing is on, and not when it is off',
    (kind) => {
      const entry = note({ kind, templateKind: null });

      expect(verdict(entry, { settings: SHARING_ON })).toEqual({ readable: true, basis: 'shared' });
      expect(verdict(entry, { settings: SHARING_OFF })).toEqual({ readable: false });
    },
  );

  it('reports a treating professional as treating, not shared, when both would apply', () => {
    expect(verdict(note(), { settings: SHARING_ON, treating: true })).toEqual({
      readable: true,
      basis: 'treating',
    });
  });
});

describe('prescriptions never follow sharing (D17)', () => {
  const prescription = note({ kind: 'prescription', templateKind: null });

  it('are refused to a non-treating professional with sharing on', () => {
    expect(verdict(prescription, { settings: SHARING_ON })).toEqual({ readable: false });
  });

  it('are refused even if the shared scope lists everything, "prescription" included', () => {
    const everything: SharingSettings = {
      clinicalSharing: true,
      sharedTemplates: ['general', 'prescription', 'psychology'],
    };

    expect(verdict(prescription, { settings: everything })).toEqual({ readable: false });
    expect(
      verdict(note({ kind: 'prescription', templateKind: 'prescription' }), {
        settings: everything,
      }),
    ).toEqual({ readable: false });
  });

  it('are readable by the prescriber and by treating professionals', () => {
    expect(verdict({ ...prescription, authorProfessionalId: ME })).toEqual({
      readable: true,
      basis: 'author',
    });
    expect(verdict(prescription, { treating: true })).toEqual({
      readable: true,
      basis: 'treating',
    });
  });
});

describe('the initial shared scope', () => {
  it('contains every published template except psychology', () => {
    expect(
      initialSharedTemplates(['general', 'odontology', 'psychology', 'physiotherapy', 'nutrition']),
    ).toEqual(['general', 'odontology', 'physiotherapy', 'nutrition']);
    expect(DEFAULT_SHARED_TEMPLATES).toEqual([
      'general',
      'odontology',
      'physiotherapy',
      'nutrition',
    ]);
  });

  it('does not include psychology even if it is the only template', () => {
    expect(initialSharedTemplates(['psychology'])).toEqual([]);
  });
});

describe('readable() with the care relationship behind a port', () => {
  it('asks the port once per patient and never for the author', async () => {
    const asked: [string, string][] = [];
    const context = {
      settings: SHARING_OFF,
      isTreating: (professionalId: string, patientId: string) => {
        asked.push([professionalId, patientId]);
        return Promise.resolve(true);
      },
    };

    const own = await readable(note({ authorProfessionalId: ME }), ME, context);
    const colleague = await readable(note(), ME, context);

    expect(own).toEqual({ readable: true, basis: 'author' });
    expect(colleague).toEqual({ readable: true, basis: 'treating' });
    expect(asked).toEqual([[ME, PATIENT]]);
  });

  it("does not ask the port when the entry is author_only and not the actor's", async () => {
    let calls = 0;
    const context = {
      settings: SHARING_ON,
      isTreating: () => {
        calls += 1;
        return Promise.resolve(true);
      },
    };

    const result = await readable(note({ visibility: 'author_only' }), ME, context);

    expect(result).toEqual({ readable: false });
    expect(calls).toBe(0);
  });

  it('fails closed when the port fails', async () => {
    const context = {
      settings: SHARING_OFF,
      isTreating: () => Promise.reject(new Error('database down')),
    };

    expect(await readable(note(), ME, context)).toEqual({ readable: false });
  });
});

describe('audit marker of shared reads', () => {
  it('marks only the shared basis, with the reason the audit log expects', () => {
    expect(sharedReadAuditReason({ readable: true, basis: 'shared' })).toBe('shared');
    expect(sharedReadAuditReason({ readable: true, basis: 'treating' })).toBeUndefined();
    expect(sharedReadAuditReason({ readable: true, basis: 'author' })).toBeUndefined();
    expect(sharedReadAuditReason({ readable: false })).toBeUndefined();
  });
});

describe('properties', () => {
  const kinds = ['note', 'anamnesis', 'document', 'consent', 'prescription'] as const;
  const templates = [
    'general',
    'odontology',
    'physiotherapy',
    'nutrition',
    'psychology',
    'newcomer',
  ];

  const entryArb = fc.record({
    kind: fc.constantFrom(...kinds),
    patientId: fc.constant(PATIENT),
    authorProfessionalId: fc.constantFrom(ME, COLLEAGUE),
    visibility: fc.constantFrom('default', 'author_only'),
    templateKind: fc.option(fc.constantFrom(...templates), { nil: null }),
  }) as fc.Arbitrary<ClinicalEntry>;
  const settingsArb = fc.record({
    clinicalSharing: fc.boolean(),
    sharedTemplates: fc.subarray([...templates, 'prescription']),
  });

  it('nobody but the author ever reads an author_only entry', () => {
    fc.assert(
      fc.property(entryArb, settingsArb, fc.boolean(), (entry, settings, treating) => {
        const result = readableBasis({
          entry: { ...entry, visibility: 'author_only' },
          professionalId: ME,
          treating,
          settings,
        });
        expect(result.readable).toBe(entry.authorProfessionalId === ME);
      }),
    );
  });

  it('a prescription of someone else is readable exactly when the actor treats the patient', () => {
    fc.assert(
      fc.property(entryArb, settingsArb, fc.boolean(), (entry, settings, treating) => {
        const result = readableBasis({
          entry: {
            ...entry,
            kind: 'prescription',
            authorProfessionalId: COLLEAGUE,
            visibility: 'default',
          },
          professionalId: ME,
          treating,
          settings,
        });
        expect(result.readable).toBe(treating);
      }),
    );
  });

  it('with sharing off, an entry of someone else is readable exactly when the actor treats the patient and it is not author_only', () => {
    fc.assert(
      fc.property(entryArb, fc.boolean(), (entry, treating) => {
        const other: ClinicalEntry = { ...entry, authorProfessionalId: COLLEAGUE };
        const result = readableBasis({
          entry: other,
          professionalId: ME,
          treating,
          settings: SHARING_OFF,
        });
        expect(result.readable).toBe(treating && other.visibility === 'default');
      }),
    );
  });

  it('turning sharing on only ever widens what a non-treating professional reads, never narrows it', () => {
    fc.assert(
      fc.property(entryArb, settingsArb, fc.boolean(), (entry, settings, treating) => {
        const off = readableBasis({
          entry,
          professionalId: ME,
          treating,
          settings: { ...settings, clinicalSharing: false },
        });
        const on = readableBasis({
          entry,
          professionalId: ME,
          treating,
          settings: { ...settings, clinicalSharing: true },
        });
        if (off.readable) expect(on.readable).toBe(true);
      }),
    );
  });

  it('a shared read is never a read of a template that is off the list', () => {
    fc.assert(
      fc.property(entryArb, settingsArb, (entry, settings) => {
        const result = readableBasis({
          entry: { ...entry, authorProfessionalId: COLLEAGUE },
          professionalId: ME,
          treating: false,
          settings,
        });
        if (result.readable && entry.kind === 'note' && entry.templateKind) {
          expect(settings.sharedTemplates).toContain(entry.templateKind);
        }
      }),
    );
  });
});
