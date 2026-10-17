import { useCallback, useMemo, useRef } from 'react';

import { useApi } from '../../../app/providers.js';
import { publicBookingApi } from '../api/booking-api.js';
import { parsePuzzle, solvePuzzle, type Puzzle } from '../domain/pow.js';

/** A proof is good for five minutes on the server; one older than this is solved again. */
const FRESH_MS = 4 * 60_000;

/** The proof an organization that needs none accepts (the demo organizations' fake challenge). */
const NO_CHALLENGE_PROOF = 'not-needed';

/** Solves a puzzle in a Web Worker; where there is none (tests, very old browsers) it runs inline. */
export function solveInWorker(puzzle: Puzzle): Promise<string> {
  if (typeof Worker === 'undefined') return Promise.resolve(solvePuzzle(puzzle));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/pow.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(solvePuzzle(puzzle));
      return;
    }
    worker.onmessage = (event: MessageEvent<{ proof?: string; error?: boolean }>) => {
      worker.terminate();
      if (typeof event.data.proof === 'string') resolve(event.data.proof);
      else reject(new Error('The bot challenge could not be solved'));
    };
    worker.onerror = () => {
      worker.terminate();
      try {
        resolve(solvePuzzle(puzzle));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('The bot challenge failed'));
      }
    };
    worker.postMessage(puzzle);
  });
}

export interface ProofSource {
  /** Starts solving a challenge now, so the proof is ready when the visitor needs it. */
  warm: () => void;
  /** A proof for one request: the warmed one if it is still good, else a new one. */
  take: () => Promise<string>;
}

/**
 * The bot challenge of the public forms, solved without the visitor noticing: the page warms a
 * proof when it knows one is coming (the form is opened) and takes it when the visitor sends. A
 * proof works once, so each request takes its own.
 */
export function useBotChallenge(): ProofSource {
  const api = useApi();
  const warmed = useRef<{ promise: Promise<string>; at: number } | null>(null);

  const solve = useCallback(async () => {
    const puzzle = parsePuzzle(await publicBookingApi(api).challenge());
    return puzzle ? solveInWorker(puzzle) : NO_CHALLENGE_PROOF;
  }, [api]);

  const warm = useCallback(() => {
    const current = warmed.current;
    if (current && Date.now() - current.at < FRESH_MS) return;
    const promise = solve();
    // A failure is reported when the proof is taken, not as an unhandled rejection now.
    promise.catch(() => undefined);
    warmed.current = { promise, at: Date.now() };
  }, [solve]);

  const take = useCallback(async () => {
    const current = warmed.current;
    warmed.current = null;
    if (current && Date.now() - current.at < FRESH_MS) {
      try {
        return await current.promise;
      } catch {
        // Solve again below.
      }
    }
    return solve();
  }, [solve]);

  return useMemo(() => ({ warm, take }), [warm, take]);
}
