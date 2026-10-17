// Lint fixture: a module may import its own internals freely.
import { overlaps } from '../domain/lanes.js';

export const result = overlaps({ start: 0, end: 1 }, { start: 1, end: 2 });
