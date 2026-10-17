// Lint fixture: this import is forbidden. A module reaches another module only through its index.ts.
import { findHoursProblems } from '../../staff/domain/hours.js';

export const problems = findHoursProblems([], new Map());
