import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { createSchedulingPorts, type WorklistService } from '../../scheduling/index.js';

import type { Worklist } from './deps.js';

/**
 * The reception worklist as messaging uses it, through the scheduling module's public API: the
 * queue belongs to scheduling, and messaging only adds and settles its items. The same code serves
 * the API process (the planner) and the worker (the sending jobs).
 */
export function createWorklist(deps: { keys: TenantKeys }): Worklist {
  return {
    async open(tx, item) {
      await createSchedulingPorts(tx, { keys: deps.keys }).openWorklistItem(item);
    },
    async close(tx, item) {
      await createSchedulingPorts(tx, { keys: deps.keys }).closeWorklistItem({
        ...item,
        status: 'resolved',
        resolution: 'no_longer_needed',
        actor: {
          userId: SYSTEM_USER_ID,
          actingRole: null,
          ip: null,
          userAgent: null,
          requestId: null,
        },
      });
    },
  };
}

const SYSTEM_ACTOR = {
  userId: SYSTEM_USER_ID,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
} as const;

/**
 * The same worklist backed by scheduling's service, which the API process holds: it keeps the
 * detail of an item (the text of a reply that reception has to read), encrypted.
 */
export function createWorklistFromService(service: WorklistService): Worklist {
  return {
    async open(tx, item) {
      await service.openItem(tx, {
        kind: item.kind,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        locationId: item.locationId ?? undefined,
        detail: item.detail,
      });
    },
    async close(tx, item) {
      await service.closeBySubject(tx, {
        ...item,
        status: 'resolved',
        resolution: 'no_longer_needed',
        actor: SYSTEM_ACTOR,
      });
    },
  };
}
