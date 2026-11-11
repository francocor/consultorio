// Lint fixture: this import is fine. It goes through the public API of the other module.
import { findHoursProblems } from '../../staff/index.js';

export const problems = findHoursProblems([], new Map());
