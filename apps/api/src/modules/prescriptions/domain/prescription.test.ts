import type { PrescriptionItem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  cancelKeyOf,
  cleanProviderMessage,
  documentDate,
  issueKeyOf,
  medicationLine,
  nextAttemptDelayMs,
  parseContent,
  providerRequestOf,
  serializeContent,
  type PrescriptionContent,
} from './prescription.js';

const item: PrescriptionItem = {
  genericName: 'Amoxicilina',
  dose: '500 mg',
  form: 'comprimidos',
  quantity: 21,
  instructions: '1 cada 8 horas durante 7 días',
};

const content: PrescriptionContent = {
  patient: {
    fullName: 'Paula Pérez',
    documentType: 'dni',
    documentNumber: '30123456',
    coverage: { payerName: 'Obra Social Ejemplo', planName: 'Plan 210' },
  },
  prescriber: {
    fullName: 'Dra. Ana Gómez',
    matricula: 'MP 12345',
    jurisdiction: 'AR-B',
    specialty: 'Clínica médica',
  },
  date: '2026-10-19',
  items: [item],
};

describe('what the provider is asked', () => {
  it('writes a line with the generic name first, then dose, form, quantity and instructions', () => {
    expect(medicationLine(item)).toBe(
      'Amoxicilina 500 mg, comprimidos, cantidad 21. 1 cada 8 horas durante 7 días',
    );
  });

  it('sends the registration, the document of the patient and one line per medication', () => {
    const second: PrescriptionItem = { ...item, genericName: 'Ibuprofeno', dose: '400 mg' };

    const request = providerRequestOf({ ...content, items: [item, second] });

    expect(request).toEqual({
      matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
      patientDocument: { type: 'dni', number: '30123456' },
      items: [
        'Amoxicilina 500 mg, comprimidos, cantidad 21. 1 cada 8 horas durante 7 días',
        'Ibuprofeno 400 mg, comprimidos, cantidad 21. 1 cada 8 horas durante 7 días',
      ],
    });
  });

  it('asks with the passport when that is the document of the patient', () => {
    const request = providerRequestOf({
      ...content,
      patient: { ...content.patient, documentType: 'passport', documentNumber: 'AAB123456' },
    });

    expect(request.patientDocument).toEqual({ type: 'passport', number: 'AAB123456' });
  });
});

describe('the keys the provider sees', () => {
  it('derives the issue key from the organization and the prescription, never from the client', () => {
    const key = issueKeyOf('tenant-a', 'rx-1');

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(issueKeyOf('tenant-a', 'rx-1')).toBe(key);
    expect(issueKeyOf('tenant-b', 'rx-1')).not.toBe(key);
    expect(issueKeyOf('tenant-a', 'rx-2')).not.toBe(key);
  });

  it('keeps the cancellation key apart from the issue key of the same prescription', () => {
    expect(cancelKeyOf('tenant-a', 'rx-1')).not.toBe(issueKeyOf('tenant-a', 'rx-1'));
    expect(cancelKeyOf('tenant-a', 'rx-1')).toBe(cancelKeyOf('tenant-a', 'rx-1'));
  });
});

describe('the content that is stored encrypted', () => {
  it('reads back exactly what was written', () => {
    expect(parseContent(serializeContent(content))).toEqual(content);
  });

  it('keeps a patient without coverage and a prescriber without specialty', () => {
    const bare: PrescriptionContent = {
      ...content,
      patient: { ...content.patient, coverage: null },
      prescriber: { ...content.prescriber, specialty: null },
    };

    expect(parseContent(serializeContent(bare))).toEqual(bare);
  });

  it('refuses stored text that is not a prescription', () => {
    expect(() => parseContent('{"items": "no"}')).toThrow();
    expect(() => parseContent('not json')).toThrow();
  });
});

describe('the date printed on the prescription', () => {
  it('is the day in the time zone of the practice, not in UTC', () => {
    // 01:30 UTC of the 20th is still the evening of the 19th in Buenos Aires.
    const lateEvening = new Date('2026-10-20T01:30:00Z');

    expect(documentDate(lateEvening, 'America/Argentina/Buenos_Aires')).toBe('2026-10-19');
    expect(documentDate(lateEvening, 'UTC')).toBe('2026-10-20');
  });
});

describe('the wait between attempts', () => {
  it('starts at a minute and doubles, up to an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(nextAttemptDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('the words of the provider', () => {
  it('turns control characters into spaces, trims and cuts what is too long', () => {
    expect(cleanProviderMessage('  Línea\nvacía\t en la receta  ')).toBe(
      'Línea vacía en la receta',
    );
    expect(cleanProviderMessage('x'.repeat(900))).toHaveLength(300);
  });

  it('never shows an empty message', () => {
    expect(cleanProviderMessage('  \n ')).toBe('El proveedor rechazó la receta.');
  });
});
