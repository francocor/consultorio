import {
  validateDraftContent,
  type FieldIssue,
  type NoteDto,
  type NoteVisibility,
} from '@consultorio/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { clinicalApi } from '../api/clinical-api.js';

import { cleanContent, contentKey } from './content.js';

/**
 * Where the draft stands against the server:
 * - `saved`: what is on screen is on file.   - `dirty`: changed, the save is on its way.
 * - `saving`: a request is in flight.       - `invalid`: a value is wrong in itself, nothing is sent.
 * - `failed`: the request failed (network, server); the next change tries again.
 * - `stale`: another screen saved a newer revision; nothing is sent until the author decides.
 * - `locked`: the note is no longer a draft (signed or marked as error elsewhere).
 */
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'invalid' | 'failed' | 'stale' | 'locked';

export type FlushResult = 'saved' | 'invalid' | 'failed' | 'blocked';

/** Puts the field errors of a validation on the form, replacing the earlier ones. */
export function applyIssues(form: UseFormReturn, issues: readonly FieldIssue[]): void {
  form.clearErrors();
  for (const issue of issues) {
    form.setError(issue.path, { type: 'validate', message: issue.i18nKey });
  }
}

interface AutosaveOptions {
  note: NoteDto;
  form: UseFormReturn;
  visibility: NoteVisibility;
  delayMs: number;
  /** Called with the note the server answered, so the rest of the screen follows. */
  onSaved: (note: NoteDto) => void;
}

/**
 * Debounced autosave of a draft with optimistic concurrency. Every save carries the revision it was
 * based on; a 409 means another screen saved first and the author chooses what to do (nothing is
 * overwritten silently). Saves never overlap: a change made while one is in flight is sent after it.
 */
export function useAutosave({ note, form, visibility, delayMs, onSaved }: AutosaveOptions) {
  const api = useApi();
  const [status, setStatus] = useState<SaveStatus>('saved');
  const revision = useRef(note.draftRevision);
  const serverVisibility = useRef<NoteVisibility>(note.visibility);
  const savedKey = useRef(`${contentKey(note.content)}|${note.visibility}`);
  const visibilityRef = useRef(visibility);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<unknown> | null>(null);
  const state = useRef<SaveStatus>('saved');
  const onSavedRef = useRef(onSaved);

  const update = useCallback((next: SaveStatus) => {
    state.current = next;
    setStatus(next);
  }, []);

  visibilityRef.current = visibility;
  onSavedRef.current = onSaved;

  const currentKey = useCallback(
    () => `${contentKey(form.getValues())}|${visibilityRef.current}`,
    [form],
  );

  const flush = useCallback(async (): Promise<FlushResult> => {
    clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current.catch(() => undefined);
    if (state.current === 'stale' || state.current === 'locked') return 'blocked';

    const key = currentKey();
    if (key === savedKey.current) {
      update('saved');
      return 'saved';
    }
    const content = cleanContent(form.getValues());
    const checked = validateDraftContent(note.templateKind, note.templateVersion, content);
    if (!checked.ok) {
      applyIssues(form, checked.errors);
      update('invalid');
      return 'invalid';
    }
    form.clearErrors();

    update('saving');
    const sentVisibility = visibilityRef.current;
    const request = clinicalApi(api).saveDraft(note.encounterId, {
      content,
      baseRevision: revision.current,
      ...(sentVisibility === serverVisibility.current ? {} : { visibility: sentVisibility }),
    });
    inFlight.current = request;
    try {
      const saved = await request;
      revision.current = saved.draftRevision;
      serverVisibility.current = saved.visibility;
      savedKey.current = key;
      onSavedRef.current(saved);
      if (currentKey() === key) {
        update('saved');
      } else {
        update('dirty');
        timer.current = setTimeout(() => void flush(), delayMs);
      }
      return 'saved';
    } catch (error) {
      if (isApiError(error) && error.code === 'stale_revision') {
        update('stale');
        return 'blocked';
      }
      if (isApiError(error) && error.code === 'conflict') {
        update('locked');
        return 'blocked';
      }
      update('failed');
      return 'failed';
    } finally {
      inFlight.current = null;
    }
  }, [
    api,
    currentKey,
    delayMs,
    form,
    note.encounterId,
    note.templateKind,
    note.templateVersion,
    update,
  ]);

  const schedule = useCallback(() => {
    if (state.current === 'stale' || state.current === 'locked') return;
    if (currentKey() === savedKey.current) return;
    if (state.current !== 'saving') update('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
  }, [currentKey, delayMs, flush, update]);

  // Every change of the form starts (or restarts) the countdown.
  useEffect(() => {
    const subscription = form.watch(() => {
      schedule();
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [form, schedule]);

  // The restriction to the author is part of the draft, outside the form fields.
  useEffect(() => {
    schedule();
  }, [visibility, schedule]);

  // Leaving the screen with something unsaved: send it now rather than lose it.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (state.current === 'dirty' || state.current === 'failed') void flush();
    },
    [flush],
  );

  /** The author looked at the newer version and wants it: the screen takes the server's text. */
  const takeServerVersion = useCallback(async () => {
    const fresh = await clinicalApi(api).note(note.id);
    revision.current = fresh.draftRevision;
    serverVisibility.current = fresh.visibility;
    savedKey.current = `${contentKey(fresh.content)}|${fresh.visibility}`;
    form.reset(fresh.content);
    update(fresh.status === 'draft' ? 'saved' : 'locked');
    onSavedRef.current(fresh);
  }, [api, form, note.id, update]);

  /** The author keeps what is on screen: it is based on the newer revision and sent as theirs. */
  const keepMine = useCallback(async () => {
    const fresh = await clinicalApi(api).note(note.id);
    if (fresh.status !== 'draft') {
      update('locked');
      onSavedRef.current(fresh);
      return;
    }
    revision.current = fresh.draftRevision;
    serverVisibility.current = fresh.visibility;
    savedKey.current = '';
    update('dirty');
    await flush();
  }, [api, flush, note.id, update]);

  return {
    status,
    flush,
    takeServerVersion,
    keepMine,
    /** The revision the next save (or the signature) is based on. */
    revision: () => revision.current,
    markLocked: () => {
      update('locked');
    },
    markStale: () => {
      update('stale');
    },
  };
}
