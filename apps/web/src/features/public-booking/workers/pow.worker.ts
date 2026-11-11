import { solvePuzzle, type Puzzle } from '../domain/pow.js';

/**
 * Solves the proof-of-work puzzle of a public form away from the page, so scrolling and typing stay
 * smooth while it runs. It answers with the proof or, if the puzzle was not valid, with an error.
 */
self.addEventListener('message', (event: MessageEvent<Puzzle>) => {
  try {
    self.postMessage({ proof: solvePuzzle(event.data) });
  } catch {
    self.postMessage({ error: true });
  }
});
