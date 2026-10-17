import type { NoteDto } from '@consultorio/contracts';

import { jsonBody, jsonResponse, problemResponse } from '../../shared/test/render.js';
import { patient } from '../patients/fixtures.js';

import { CLINICAL_IDS, draftNote, signedNote } from './fixtures.js';

export interface SavedDraft {
  content: Record<string, unknown>;
  baseRevision: number;
  visibility?: string;
}

type Handler = (url: string, init: RequestInit) => Response;

/**
 * A fake server holding one draft, for the component tests. It behaves like the API: a save must
 * carry the current revision (409 otherwise) and gets the next one back; signing locks the note.
 */
export function draftServer(initial: NoteDto = draftNote()) {
  const state = { note: initial, saves: [] as SavedDraft[], signs: [] as unknown[] };
  const routes: Record<string, Handler> = {
    [`GET /api/notes/${initial.id}`]: () => jsonResponse(state.note),
    [`GET /api/patients/${initial.patientId}`]: () => jsonResponse(patient()),
    [`GET /api/patients/${initial.patientId}/representatives`]: () =>
      jsonResponse({ minor: false, representatives: [] }),
    [`PUT /api/encounters/${initial.encounterId}/note/draft`]: (_url, init) => {
      const body = jsonBody(init) as SavedDraft;
      state.saves.push(body);
      if (body.baseRevision !== state.note.draftRevision) {
        return problemResponse(409, 'stale_revision');
      }
      state.note = {
        ...state.note,
        content: body.content,
        draftRevision: body.baseRevision + 1,
        visibility: body.visibility === 'author_only' ? 'author_only' : state.note.visibility,
      };
      return jsonResponse(state.note);
    },
    [`POST /api/notes/${initial.id}/sign`]: (_url, init) => {
      state.signs.push(jsonBody(init));
      state.note = signedNote({ ...state.note, status: 'signed' });
      return jsonResponse(state.note);
    },
  };
  return { state, routes, ids: CLINICAL_IDS };
}
