import type { NoteDto } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { captureLogs, type LogCapture } from '../../src/testing/log-capture.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';

/**
 * Clinical routes never log bodies (clinical-records, "Audit of clinical access"; app-shell
 * SHL-09). The server runs at the most verbose level and a request carries words that must not
 * appear anywhere in the output: not in the request lines, not in the response lines, not in the
 * error lines, and not in the query string.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let logs: LogCapture;
let author: Professional;
let colleague: Professional;

const SECRETS = {
  reason: 'MOTIVOSECRETO-alfa',
  diagnosis: 'DIAGNOSTICOSECRETO-beta',
  addendum: 'ADENDASECRETA-gamma',
  correctionReason: 'RAZONSECRETA-delta',
  query: 'BUSQUEDASECRETA-epsilon',
  errorReason: 'EQUIVOCADOSECRETO-zeta',
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  logs = captureLogs();
  world = await createClinicalWorld(runtime, 'clinical-logging', {
    logLevel: 'trace',
    logStream: logs.stream,
  });
  author = await world.professional();
  colleague = await world.professional();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

describe('what the server writes to its log', () => {
  it('never contains the words of a note, an addendum, a search or an error mark', async () => {
    const patientId = await world.patient([author, colleague]);
    const draft = await world.open(author, patientId);
    const saved = await world.api.put(
      `/encounters/${draft.encounterId}/note/draft`,
      author.session,
      {
        content: { reasonForConsultation: SECRETS.reason, diagnosis: SECRETS.diagnosis },
        baseRevision: 0,
      },
    );
    const signed = await world.api.post(`/notes/${draft.id}/sign`, author.session, {
      expectedRevision: 1,
    });
    await world.api.get(`/notes/${draft.id}`, colleague.session);
    await world.api.post(`/notes/${draft.id}/addenda`, colleague.session, {
      kind: 'correction',
      reason: SECRETS.correctionReason,
      text: SECRETS.addendum,
    });
    await world.api.get(`/notes/${draft.id}/versions`, colleague.session);
    await world.api.get(`/patients/${patientId}/clinical/timeline`, colleague.session);
    const search = await world.api.get(
      `/patients/${patientId}/clinical/search?q=${SECRETS.query}`,
      colleague.session,
    );
    // Error paths: a body that fails validation, a state conflict, a refusal.
    await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
      content: { reasonForConsultation: SECRETS.reason, notAField: SECRETS.diagnosis },
      baseRevision: 1,
    });
    await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
      content: { reasonForConsultation: SECRETS.reason },
      baseRevision: 1,
    });
    await world.api.post(`/notes/${draft.id}/entered-in-error`, world.reception, {
      reason: SECRETS.errorReason,
    });
    await world.api.post(`/notes/${draft.id}/entered-in-error`, colleague.session, {
      reason: SECRETS.errorReason,
    });

    // The calls worked (the words really travelled) ...
    expect(saved.statusCode).toBe(200);
    expect(signed.json<NoteDto>().content['reasonForConsultation']).toBe(SECRETS.reason);
    expect(search.statusCode).toBe(200);
    // ... and the log, which is not empty, holds none of them.
    const output = logs.raw();
    expect(logs.lines().length).toBeGreaterThan(30);
    expect(output).toContain('/encounters/');
    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(output, label).not.toContain(secret);
    }
  });
});
