import { GRANTABLE } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import staff from '../../locales/es-AR/staff.json';

const labels: Record<string, string> = staff;

describe('the permissions an owner can hand out', () => {
  it('each has a title and an explanation in Spanish, so no switch is shown without words', () => {
    const missing = GRANTABLE.flatMap((permission) =>
      ['title', 'description']
        .map((part) => `permission.${permission}.${part}`)
        .filter((key) => (labels[key] ?? '').trim() === ''),
    );

    expect(missing).toEqual([]);
  });

  it('says what running the first run means, since an admin only gets it by a grant', () => {
    expect(labels['permission.onboarding.manage.title']).toBe('Configuración inicial');
    expect(labels['permission.onboarding.manage.description']).toMatch(/asistente/i);
  });
});
