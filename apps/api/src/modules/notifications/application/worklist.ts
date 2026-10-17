import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { createSchedulingPorts } from '../../scheduling/index.js';

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
