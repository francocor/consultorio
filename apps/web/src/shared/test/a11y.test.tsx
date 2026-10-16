import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from './a11y.js';

describe('a11yViolations', () => {
  it('reports a violation for a known-bad fixture (image without alt text)', async () => {
    // eslint-disable-next-line jsx-a11y/alt-text -- the missing alt text is the point of this fixture
    const { container } = render(<img src="/x.png" />);

    const violations = await a11yViolations(container);

    expect(violations.map((violation) => violation.id)).toContain('image-alt');
  });

  it('reports nothing for an accessible fixture', async () => {
    const { container } = render(<img src="/x.png" alt="Clinic entrance" />);

    expect(await a11yViolations(container)).toEqual([]);
  });
});
