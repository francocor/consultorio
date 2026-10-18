import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../shared/test/a11y.js';
import { bootFor } from '../shared/test/fixtures.js';
import { renderInRouter } from '../shared/test/render-app.js';
import { renderWithApp } from '../shared/test/render.js';
import { SimulatedBillingBanner } from '../shared/ui/states/banners.js';

import { BOOT_QUERY_KEY } from './boot.js';
import { SimulatedBillingNotice } from './SimulatedBillingNotice.js';

describe('SimulatedBillingBanner (what a simulator produced is said to be one)', () => {
  it('says the invoices are test documents without fiscal validity, in plain words', async () => {
    const { container, missingKeys } = renderWithApp(<SimulatedBillingBanner />);

    expect(screen.getByRole('status')).toHaveTextContent('Facturación de prueba');
    expect(screen.getByRole('status')).toHaveTextContent(/sin validez fiscal/);
    expect(await a11yViolations(container)).toEqual([]);
    expect(missingKeys).toEqual([]);
  });
});

describe('SimulatedBillingNotice (driven by the boot payload)', () => {
  it('shows when the AFIP simulator serves the deployment', async () => {
    renderInRouter(<SimulatedBillingNotice />, {
      boot: bootFor('Clínica Norte', { localProviders: { afip: true } }),
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Facturación de prueba');
  });

  it('shows for a demo organization, which only ever has the fake issuer', async () => {
    renderInRouter(<SimulatedBillingNotice />, {
      boot: bootFor('Demo', { isDemo: true, localProviders: { afip: false } }),
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Facturación de prueba');
  });

  it('shows nothing when invoices are real: no simulator, not a demo', async () => {
    const view = renderInRouter(<SimulatedBillingNotice />, {
      boot: bootFor('Clínica Norte', { localProviders: { afip: false }, isDemo: false }),
    });

    // Wait for the boot payload to arrive, then look: nothing was drawn.
    await waitFor(() => {
      expect(view.services.queryClient.getQueryData(BOOT_QUERY_KEY)).toBeDefined();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing until the boot payload is known', () => {
    renderInRouter(<SimulatedBillingNotice />, {
      boot: bootFor('Clínica Norte', { localProviders: { afip: true } }),
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
