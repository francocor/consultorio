import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The go-live checklist (`docs/go-live-checklist.md`, task 6.46) lists every real-provider task that
 * was deferred because it needs something only the owner can bring, with what it needs. A deferred
 * task that is added to the plan and missing from the checklist would be forgotten on the day the
 * owner signs the first customer, so the list is read from the plan: this test fails when a task
 * tagged "deferred: needs owner credentials/contract" is not in the checklist, when the checklist
 * does not repeat what the task needs, and when the checklist names a task that is no longer open.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const TASKS = `${REPO}openspec/changes/health-practice-saas/tasks.md`;
const CHECKLIST = `${REPO}docs/go-live-checklist.md`;

interface Deferred {
  id: string;
  needs: string;
}

/** The open tasks tagged as deferred, with the thing each one needs (the parenthesis of the tag). */
export function deferredTasksIn(plan: string): Deferred[] {
  return [
    ...plan.matchAll(
      /^- \[ \] (\d+\.\d+) deferred: needs owner credentials\/contract \(([^)]*)\)/gm,
    ),
  ].map((match) => ({ id: match[1] ?? '', needs: match[2] ?? '' }));
}

/** The task ids a checklist names in the first column of its tables. */
export function listedIn(checklist: string): string[] {
  return [...checklist.matchAll(/^\| (\d+\.\d+) \|/gm)].map((match) => match[1] ?? '');
}

describe('the go-live checklist', () => {
  const plan = readFileSync(TASKS, 'utf8');
  const checklist = existsSync(CHECKLIST) ? readFileSync(CHECKLIST, 'utf8') : '';
  const deferred = deferredTasksIn(plan);

  it('finds the deferred tasks of the plan (the check is not silently empty)', () => {
    expect(deferred.map((task) => task.id)).toEqual(
      expect.arrayContaining([
        '3.80',
        '3.81',
        '3.82',
        '3.83',
        '4.68',
        '4.69',
        '5.53',
        '5.54',
        '6.50',
        '6.51',
        '6.52',
      ]),
    );
  });

  it('lists every deferred task of the plan', () => {
    const listed = new Set(listedIn(checklist));

    expect(
      deferred.filter((task) => !listed.has(task.id)).map((task) => task.id),
      'deferred tasks missing from docs/go-live-checklist.md',
    ).toEqual([]);
  });

  it('says what each one needs, in the words of the plan (or points at the task it shares it with)', () => {
    const rows = new Map(
      checklist
        .split('\n')
        .filter((line) => /^\| \d+\.\d+ \|/.test(line))
        .map((line) => [/^\| (\d+\.\d+) \|/.exec(line)?.[1] ?? '', line]),
    );

    for (const task of deferred) {
      const row = rows.get(task.id) ?? '';
      // "same" in the plan means the credential of the task above it; the row then names that task.
      const wanted = task.needs === 'same' ? /same as \d+\.\d+/i : task.needs;
      expect(row, `${task.id} needs: ${task.needs}`).toMatch(
        typeof wanted === 'string'
          ? new RegExp(wanted.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          : wanted,
      );
    }
  });

  it('names no task that is not an open deferred one: a finished task leaves the list', () => {
    const open = new Set(deferred.map((task) => task.id));

    expect(
      listedIn(checklist).filter((id) => !open.has(id)),
      'tasks in the checklist that are not deferred and open',
    ).toEqual([]);
  });

  it('keeps the legal decisions of the owner as actions, not as tasks', () => {
    expect(checklist).toMatch(/hosting.*Q1/is);
    expect(checklist).toMatch(/erasure.*Q7/is);
    expect(checklist).toMatch(/## Owner actions/);
  });

  it('is refused by the check itself when a deferred task is missing', () => {
    const forgotten = deferredTasksIn(
      `${plan}\n- [ ] 6.99 deferred: needs owner credentials/contract (A new provider account). Something.\n`,
    );

    expect(forgotten.map((task) => task.id)).toContain('6.99');
    expect(listedIn(checklist)).not.toContain('6.99');
  });
});
