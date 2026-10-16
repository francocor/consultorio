import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import { a11yViolations } from '../../test/a11y.js';
import { renderWithApp } from '../../test/render.js';
import { Button } from '../button.js';

import {
  OfflineBanner,
  ReadOnlyBanner,
  TwoFactorGraceBanner,
  TwoFactorRequiredState,
} from './banners.js';
import { EmptyState } from './empty-state.js';
import { ErrorState } from './error-state.js';
import { ForbiddenState } from './forbidden-state.js';
import { DetailSkeleton, FormSkeleton, ListSkeleton } from './loading-skeleton.js';
import { SafetyFlag } from './safety-flag.js';
import { StatusBadge } from './status-badge.js';

describe('EmptyState', () => {
  it('says what the screen is for and offers the primary next action', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { container, missingKeys } = renderWithApp(
      <EmptyState
        title="Todavía no hay pacientes"
        description="Registre al primer paciente para empezar."
        action={<Button onClick={onCreate}>Registrar paciente</Button>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Todavía no hay pacientes' })).toBeInTheDocument();
    expect(screen.getByText('Registre al primer paciente para empezar.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Registrar paciente' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(await a11yViolations(container)).toEqual([]);
    expect(missingKeys).toEqual([]);
  });

  it('works without an action', () => {
    renderWithApp(<EmptyState title="Sin resultados" description="Pruebe con otra búsqueda." />);

    expect(screen.getByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  const apiError = new ApiError({
    status: 500,
    kind: 'problem',
    code: 'internal_error',
    i18nKey: 'errors.internal_error',
    requestId: 'req-4242',
  });

  it('shows plain-language text, the reference code and a retry that works', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container, missingKeys } = renderWithApp(
      <ErrorState error={apiError} onRetry={onRetry} />,
    );

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/problema de nuestro lado/)).toBeInTheDocument();
    expect(within(alert).getByText('Código de referencia: req-4242')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(await a11yViolations(container)).toEqual([]);
    expect(missingKeys).toEqual([]);
  });

  it('never exposes technical detail of an unknown error', () => {
    renderWithApp(<ErrorState error={new Error('connect ECONNREFUSED 10.1.2.3:5432')} />);

    expect(screen.getByRole('alert')).not.toHaveTextContent('ECONNREFUSED');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Código de referencia');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('explains a network failure as a connection problem', () => {
    renderWithApp(
      <ErrorState
        error={new ApiError({ status: 0, kind: 'network', code: null, i18nKey: 'errors.network' })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Revise su conexión a internet');
  });
});

describe('ForbiddenState', () => {
  it('is a clear "no access" with no data and an optional way out', async () => {
    const { container, missingKeys } = renderWithApp(
      <ForbiddenState action={<a href="/">Ir al inicio</a>} />,
    );

    expect(
      screen.getByRole('heading', { name: 'No tiene acceso a esta sección' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir al inicio' })).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
    expect(missingKeys).toEqual([]);
  });
});

describe('banners', () => {
  it('OfflineBanner tells the person what still works', async () => {
    const { container, missingKeys } = renderWithApp(<OfflineBanner />);

    expect(screen.getByRole('status')).toHaveTextContent('Sin conexión');
    expect(await a11yViolations(container)).toEqual([]);
    expect(missingKeys).toEqual([]);
  });

  it('ReadOnlyBanner explains the state and the way out', async () => {
    const { container } = renderWithApp(<ReadOnlyBanner />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Organización en modo de solo lectura');
    expect(banner).toHaveTextContent('regularice la suscripción');
    expect(await a11yViolations(container)).toEqual([]);
  });

  it('TwoFactorRequiredState blocks with an action; the grace banner shows the date', async () => {
    const { container } = renderWithApp(
      <div>
        <TwoFactorRequiredState action={<a href="/account/security">Activar ahora</a>} />
        <TwoFactorGraceBanner endsAt="2026-03-12T15:00:00.000Z" />
      </div>,
    );

    expect(
      screen.getByRole('heading', { name: 'Active la verificación en dos pasos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Activar ahora' })).toHaveAttribute(
      'href',
      '/account/security',
    );
    expect(screen.getByText(/Tiene tiempo hasta el 12\/03\/2026/)).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('loading skeletons', () => {
  it('announce that content is loading, once, and hide the placeholder shapes', async () => {
    const { container } = renderWithApp(
      <div>
        <ListSkeleton rows={3} />
        <DetailSkeleton />
        <FormSkeleton fields={2} />
      </div>,
    );

    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(3);
    for (const region of regions) {
      expect(region).toHaveAttribute('aria-busy', 'true');
      expect(region).toHaveTextContent('Cargando contenido');
    }
    expect(await a11yViolations(container)).toEqual([]);
  });

  it('the list skeleton draws as many rows as asked', () => {
    const { container } = renderWithApp(<ListSkeleton rows={4} />);

    expect(container.querySelectorAll('[data-skeleton-row]')).toHaveLength(4);
  });
});

describe('StatusBadge', () => {
  it.each([
    ['active', 'Activo'],
    ['inactive', 'Inactivo'],
    ['pending', 'Pendiente'],
    ['unverified', 'Sin verificar'],
    ['verified', 'Verificado'],
  ] as const)('%s shows an icon and the word %s, never color alone', (status, label) => {
    const { container } = renderWithApp(<StatusBadge status={status} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('accepts a custom label for the same status', () => {
    renderWithApp(<StatusBadge status="warning">Matrícula por vencer</StatusBadge>);

    expect(screen.getByText('Matrícula por vencer')).toBeInTheDocument();
    expect(screen.queryByText('Atención')).not.toBeInTheDocument();
  });
});

describe('SafetyFlag', () => {
  it('a professional sees which conditions are on file', () => {
    renderWithApp(<SafetyFlag flags={['allergy_on_file', 'pregnancy']} detail="kinds" />);

    expect(screen.getByText('Alergias registradas')).toBeInTheDocument();
    expect(screen.getByText('Embarazo')).toBeInTheDocument();
  });

  it('everyone else sees a single "see professional" and nothing about the condition', () => {
    const { container } = renderWithApp(
      <SafetyFlag flags={['allergy_on_file', 'anticoagulant_on_file']} detail="summary" />,
    );

    expect(screen.getByText('Consultar con el profesional')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('Alergias');
    expect(container).not.toHaveTextContent('Anticoagulantes');
  });

  it('renders nothing when there is no flag', () => {
    const { container } = renderWithApp(<SafetyFlag flags={[]} detail="summary" />);

    expect(container.querySelector('[data-safety-flag]')).toBeNull();
  });
});
