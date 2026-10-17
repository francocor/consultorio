import { AUDIT_ACTIONS } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import audit from '../../../locales/es-AR/audit.json';

describe('audit action labels', () => {
  it('every action the server can write has a plain-language label', () => {
    const labels: Record<string, string> = audit;
    const missing = AUDIT_ACTIONS.filter((action) => !labels[`action.${action}`]);

    expect(missing).toEqual([]);
  });
});
