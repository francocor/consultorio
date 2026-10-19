import { WORKLIST_KINDS, type WorklistItemDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { countByKind, filterItems, identityDifferences } from './worklist-items.js';

const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function item(overrides: Partial<WorklistItemDto> = {}): WorklistItemDto {
  return {
    id: ID(1),
    kind: 'identity_review',
    subjectType: 'appointment',
    subjectId: ID(2),
    locationId: ID(3),
    status: 'open',
    createdAt: '2026-10-17T12:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    detail: null,
    appointment: null,
    actions: [],
    ...overrides,
  };
}

describe('identityDifferences', () => {
  it('reads what the booking submitted against what the record says', () => {
    const differences = identityDifferences({
      differences: [
        { field: 'phone', submitted: '+54 11 5555 0000', onFile: '+54 11 4444 1111' },
        { field: 'email', submitted: 'nueva@example.test', onFile: null },
      ],
    });

    expect(differences).toEqual([
      { field: 'phone', submitted: '+54 11 5555 0000', onFile: '+54 11 4444 1111' },
      { field: 'email', submitted: 'nueva@example.test', onFile: null },
    ]);
  });

  it('shows nothing when the item carries no differences, or something unexpected', () => {
    expect(identityDifferences(null)).toEqual([]);
    expect(identityDifferences({})).toEqual([]);
    expect(identityDifferences({ differences: 'many' })).toEqual([]);
    expect(identityDifferences({ differences: [{ field: 7 }] })).toEqual([]);
  });
});

describe('countByKind and filterItems', () => {
  const items = [
    item({ id: ID(10), kind: 'identity_review' }),
    item({ id: ID(11), kind: 'identity_review', locationId: ID(4) }),
    item({ id: ID(12), kind: 'pending_approval' }),
    item({ id: ID(13), kind: 'reminder_not_sent', locationId: null }),
  ];

  it('counts the items of each kind, including the ones with none', () => {
    const counts = countByKind(items);

    expect(counts).toEqual({
      pending_approval: 1,
      identity_review: 2,
      reminder_not_sent: 1,
      reminder_not_delivered: 0,
      reply_to_review: 0,
      waitlist_manual_contact: 0,
      invoice_attention: 0,
    });
    expect(Object.keys(counts)).toEqual([...WORKLIST_KINDS]);
  });

  it('filters by kind', () => {
    expect(filterItems(items, { kind: 'identity_review' }).map((entry) => entry.id)).toEqual([
      ID(10),
      ID(11),
    ]);
  });

  it('filters by location, keeping the items of the whole organization', () => {
    expect(filterItems(items, { locationId: ID(3) }).map((entry) => entry.id)).toEqual([
      ID(10),
      ID(12),
      ID(13),
    ]);
  });

  it('combines both and returns everything without filters', () => {
    expect(filterItems(items, { kind: 'identity_review', locationId: ID(4) })).toHaveLength(1);
    expect(filterItems(items, {})).toHaveLength(4);
  });
});
