import {
  Problem,
  type NoteDto,
  type SettingsDto,
  type TemplatesResponse,
} from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';

/**
 * Specialty templates through the API (clinical-records, "Specialty templates", "Psychology
 * template"): which templates a professional is offered, that every template validates its
 * content on save and on signing, and that psychology stays out of the shared scope by default.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let psychologist: Professional;
let colleague: Professional;
let reader: Professional;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-templates');
  psychologist = await world.professional(['Psicología']);
  colleague = await world.professional(['Medicina general']);
  reader = await world.professional(['Medicina general']);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const saveDraft = (note: NoteDto, by: Professional, content: unknown, baseRevision = 0) =>
  world.api.put(`/encounters/${note.encounterId}/note/draft`, by.session, {
    content,
    baseRevision,
  });

describe('GET /clinical/templates', () => {
  it('offers the generic template plus those of the professional specialties', async () => {
    const both = await world.professional(['Kinesiología', 'Nutrición']);
    const dentist = await world.professional(['Odontología']);

    const first = await world.api.get('/clinical/templates', both.session);
    const second = await world.api.get('/clinical/templates', dentist.session);

    expect(first.statusCode).toBe(200);
    expect(first.json<TemplatesResponse>().templates.map((template) => template.kind)).toEqual([
      'general',
      'physiotherapy',
      'nutrition',
    ]);
    expect(second.json<TemplatesResponse>().templates.map((template) => template.kind)).toEqual([
      'general',
      'odontology',
    ]);
    expect(first.json<TemplatesResponse>().templates[1]).toEqual({
      kind: 'physiotherapy',
      version: 1,
      labelKey: 'clinical.template.physiotherapy',
      requiredFields: ['painIntensity', 'affectedRegion', 'sessionNumber'],
    });
  });

  it('falls back to the generic template for a specialty that has none', async () => {
    const cardiologist = await world.professional(['Cardiología']);

    const response = await world.api.get('/clinical/templates', cardiologist.session);

    expect(response.json<TemplatesResponse>().templates.map((template) => template.kind)).toEqual([
      'general',
    ]);
  });

  it('is for professionals only', async () => {
    expect((await world.api.get('/clinical/templates', world.reception)).statusCode).toBe(403);
    expect((await world.api.get('/clinical/templates', world.owner)).statusCode).toBe(403);
  });
});

describe('every template validates on save and on signing', () => {
  it('saves a physiotherapy draft with pain 6 and refuses pain 11', async () => {
    const note = await world.open(colleague, await world.patient(), {
      templateKind: 'physiotherapy',
    });

    const ok = await saveDraft(note, colleague, {
      painIntensity: 6,
      affectedRegion: 'Rodilla derecha',
      sessionNumber: 3,
      totalSessions: 10,
    });
    const bad = await saveDraft(note, colleague, { painIntensity: 11 }, 1);

    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(400);
  });

  it('refuses an invalid tooth number in the odontogram, with the tooth in the path', async () => {
    const note = await world.open(colleague, await world.patient(), { templateKind: 'odontology' });

    const bad = await saveDraft(note, colleague, { odontogram: { '19': { condition: 'caries' } } });
    const good = await saveDraft(note, colleague, {
      reasonForConsultation: 'Dolor en molar',
      odontogram: { '16': { condition: 'caries', surfaces: { occlusal: { finding: 'caries' } } } },
    });

    expect(bad.statusCode).toBe(400);
    const problem = Problem.parse(bad.json());
    expect(problem.errors?.[0]).toMatchObject({ i18nKey: 'clinical.odontology.invalid_tooth' });
    expect(problem.errors?.[0]?.path.startsWith('odontogram')).toBe(true);
    expect(good.statusCode).toBe(200);
  });

  it('asks for a confirmation of an implausible height and accepts it once confirmed', async () => {
    const note = await world.open(colleague, await world.patient(), { templateKind: 'nutrition' });

    const refused = await saveDraft(note, colleague, { weightKg: 70, heightM: 17.5 });
    const confirmed = await saveDraft(
      note,
      colleague,
      { weightKg: 70, heightM: 17.5, confirmImplausible: true },
      0,
    );

    expect(Problem.parse(refused.json()).errors).toEqual([
      { path: 'heightM', i18nKey: 'clinical.nutrition.implausible' },
    ]);
    expect(confirmed.statusCode).toBe(200);
  });

  it('keeps the note bound to the template version it was created with', async () => {
    const note = await world.open(colleague, await world.patient(), { templateKind: 'general' });

    expect(note).toMatchObject({ templateKind: 'general', templateVersion: 1 });
  });
});

describe('psychology is not shared by default (end to end)', () => {
  async function signedPsychology() {
    const patientId = await world.patient([psychologist, colleague]);
    const note = await world.open(psychologist, patientId, { templateKind: 'psychology' });
    await saveDraft(note, psychologist, {
      sessionDate: '2026-05-04',
      modality: 'in_person',
      risk: 'none',
      observations: 'Sesión reservada',
    });
    await world.api.post(`/notes/${note.id}/sign`, psychologist.session, { expectedRevision: 1 });
    return { patientId, note };
  }

  async function signedGeneral(patientId: string) {
    const note = await world.open(colleague, patientId, { templateKind: 'general' });
    await saveDraft(note, colleague, { reasonForConsultation: 'Control' });
    await world.api.post(`/notes/${note.id}/sign`, colleague.session, { expectedRevision: 1 });
    return note;
  }

  it('hides a psychology entry from a sharing-scope reader, and shows the general one', async () => {
    const { patientId, note } = await signedPsychology();
    const general = await signedGeneral(patientId);
    // The owner turns sharing on and takes the default scope: no psychology.
    const enabled = await world.api.patch('/settings', world.owner, { clinicalSharing: true });
    expect(enabled.json<SettingsDto>().sharedTemplates).not.toContain('psychology');

    const psychologyRead = await world.api.get(`/notes/${note.id}`, reader.session);
    const generalRead = await world.api.get(`/notes/${general.id}`, reader.session);

    expect(psychologyRead.statusCode).toBe(404);
    expect(generalRead.statusCode).toBe(200);
    expect(generalRead.json<NoteDto>().access.basis).toBe('shared');
    // The treating professional keeps reading it.
    expect((await world.api.get(`/notes/${note.id}`, colleague.session)).statusCode).toBe(200);
  });

  it('shows it once the owner adds psychology to the scope on purpose', async () => {
    const { note } = await signedPsychology();
    await world.api.patch('/settings', world.owner, { clinicalSharing: true });
    expect((await world.api.get(`/notes/${note.id}`, reader.session)).statusCode).toBe(404);

    const added = await world.api.patch('/settings', world.owner, {
      sharedTemplates: ['general', 'odontology', 'physiotherapy', 'nutrition', 'psychology'],
      confirmPsychologySharing: true,
    });
    const read = await world.api.get(`/notes/${note.id}`, reader.session);

    expect(added.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(read.json<NoteDto>().access).toMatchObject({ basis: 'shared', canEdit: false });
    await world.api.patch('/settings', world.owner, { clinicalSharing: false });
  });
});
