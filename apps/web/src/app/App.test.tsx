import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../shared/test/a11y.js';

import { App } from './App.js';

describe('App', () => {
  it('renders the tenant-neutral placeholder shell', () => {
    render(<App />);

    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Aplicación en preparación');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<App />);

    expect(await a11yViolations(container)).toEqual([]);
  });
});
