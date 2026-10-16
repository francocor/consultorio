import { validateMatricula, validateNationalId } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './credentials.js';
import { buildDemoDataset } from './dataset.js';

describe('demo dataset', () => {
  it('is the same every time: seeded, no clock, no randomness from the environment', () => {
    expect(buildDemoDataset()).toEqual(buildDemoDataset());
  });

  it('covers every staff role, several locations and different disciplines', () => {
    const data = buildDemoDataset();

    const roles = new Set(data.staff.flatMap((person) => person.roles));
    expect([...roles].sort()).toEqual(['admin', 'owner', 'professional', 'reception']);
    expect(data.locations.length).toBeGreaterThanOrEqual(2);
    const specialties = data.staff.flatMap((person) => person.professional?.specialties ?? []);
    expect(new Set(specialties).size).toBeGreaterThanOrEqual(3);
    expect(
      data.staff.filter((person) => person.roles.includes('reception')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('every staff account is one of the documented demo credentials', () => {
    const data = buildDemoDataset();

    expect(data.staff.map((person) => person.email).sort()).toEqual(
      DEMO_ACCOUNTS.map((account) => account.email).sort(),
    );
    expect(DEMO_PASSWORD.length).toBeGreaterThanOrEqual(14);
  });

  it('uses only reserved, non-routable contact points', () => {
    const data = buildDemoDataset();

    for (const email of [
      ...data.staff.map((person) => person.email),
      ...data.patients.flatMap((patient) => (patient.email ? [patient.email] : [])),
      ...data.patients.flatMap((patient) =>
        patient.representative?.email ? [patient.representative.email] : [],
      ),
    ]) {
      expect(email, email).toMatch(/@demo\.invalid$/);
    }
    for (const phone of data.patients.flatMap((patient) =>
      patient.phone ? [patient.phone] : [],
    )) {
      expect(phone, phone).toMatch(/^\+54 11 0000 \d{4}$/);
    }
  });

  it('documents are valid for the country pack, unique, and recognizably synthetic', () => {
    const data = buildDemoDataset();

    const documents = data.patients.flatMap((patient) =>
      patient.document ? [patient.document] : [],
    );
    expect(documents.length).toBeGreaterThan(15);
    expect(new Set(documents.map((document) => document.number)).size).toBe(documents.length);
    for (const document of documents) {
      const checked = validateNationalId(document.number);
      expect(checked.ok, document.number).toBe(true);
      expect(document.number, document.number).toMatch(/^99000\d{3}$/);
    }
  });

  it('matriculas pass the country format and are distinct', () => {
    const data = buildDemoDataset();

    const registrations = data.staff.flatMap((person) =>
      person.professional ? [person.professional] : [],
    );
    expect(registrations).toHaveLength(3);
    for (const professional of registrations) {
      expect(validateMatricula(professional.jurisdiction, professional.matricula).ok).toBe(true);
    }
    expect(
      new Set(registrations.map((entry) => `${entry.jurisdiction}${entry.matricula}`)).size,
    ).toBe(3);
  });

  it('has patients with coverage, without it, minors with a representative and one without consent', () => {
    const data = buildDemoDataset();

    expect(data.patients.length).toBeGreaterThanOrEqual(24);
    expect(data.patients.filter((patient) => patient.coverage).length).toBeGreaterThan(12);
    expect(data.patients.filter((patient) => !patient.coverage).length).toBeGreaterThan(2);
    const minors = data.patients.filter((patient) => patient.birthDate > '2008-01-01');
    expect(minors.length).toBeGreaterThanOrEqual(3);
    for (const minor of minors) expect(minor.representative, minor.familyName).toBeDefined();
    expect(data.patients.filter((patient) => !patient.consent).length).toBeGreaterThanOrEqual(1);
    expect(data.patients.some((patient) => patient.document === null)).toBe(true);
  });

  it('shows the Aillu look', () => {
    expect(buildDemoDataset().branding).toMatchObject({
      displayName: 'Centro Médico Aillu',
      primaryColor: '#03a550',
    });
  });
});
