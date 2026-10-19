import type { SignConsentRequest } from '@consultorio/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../../shared/lib/api-client.js';
import { a11yViolations } from '../../shared/test/a11y.js';
import { renderWithApp } from '../../shared/test/render.js';

import { BODY, signingView, VERSION } from './test-fixtures.js';

import { ConsentSigningForm } from './index.js';

function open(view = signingView(), extra: { error?: unknown } = {}) {
  const sent: SignConsentRequest[] = [];
  const app = renderWithApp(
    <ConsentSigningForm
      view={view}
      error={extra.error}
      onSubmit={(request) => {
        sent.push(request);
      }}
    />,
  );
  return { sent, app };
}

async function typeMark(user: ReturnType<typeof userEvent.setup>, name = 'Ana Pérez') {
  await user.click(screen.getByRole('button', { name: 'Escribir el nombre' }));
  await user.type(screen.getByLabelText('Nombre completo, como firma'), name);
}

describe('the signing screen', () => {
  it('shows the full text of the version the signer will sign, and who and which version', async () => {
    const { app } = open();

    expect(
      await screen.findByRole('heading', { name: 'Extracción de muela del juicio' }),
    ).toBeVisible();
    expect(screen.getByText(/Autorizo la extracción de la muela del juicio\./)).toBeVisible();
    expect(screen.getByText(/Entiendo los riesgos\./)).toBeVisible();
    expect(screen.getByText(/Paciente: Ana Pérez · Versión 3/)).toBeVisible();
    expect(app.missingKeys).toEqual([]);
  });

  it('rejects a signature without the explicit acceptance, says why and sends nothing', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    await typeMark(user);

    await user.click(screen.getByRole('button', { name: 'Firmar consentimiento' }));

    expect(sent).toEqual([]);
    expect(
      await screen.findByText('Para firmar hay que aceptar el texto del consentimiento.'),
    ).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /acepto este consentimiento/ })).not.toBeChecked();
  });

  it('asks for the mark as well, and sends nothing until it is there', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    await user.click(screen.getByRole('checkbox', { name: /acepto este consentimiento/ }));

    await user.click(screen.getByRole('button', { name: 'Firmar consentimiento' }));

    expect(sent).toEqual([]);
    expect(await screen.findByText('Falta la firma: dibújela o escriba el nombre.')).toBeVisible();
  });

  it('sends the signature bound to the version on screen once it is accepted and signed', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    await typeMark(user);
    await user.click(screen.getByRole('checkbox', { name: /acepto este consentimiento/ }));

    await user.click(screen.getByRole('button', { name: 'Firmar consentimiento' }));

    expect(sent).toEqual([
      {
        versionId: VERSION,
        accepted: true,
        signer: 'patient',
        mark: { kind: 'typed', name: 'Ana Pérez' },
      },
    ]);
  });

  it('is the signature of a representative, with their data, for a minor', async () => {
    const user = userEvent.setup();
    const { sent } = open(signingView({ requiresRepresentative: true }));
    expect(
      screen.getByText(/El paciente es menor de edad: firma su representante legal/),
    ).toBeVisible();
    // There is no way to sign as the patient: the choice is not offered.
    expect(
      screen.queryByRole('checkbox', { name: /Firma un representante legal/ }),
    ).not.toBeInTheDocument();
    await typeMark(user, 'Luis Gómez');
    await user.click(screen.getByRole('checkbox', { name: /acepto este consentimiento/ }));

    await user.click(screen.getByRole('button', { name: 'Firmar consentimiento' }));
    expect(sent).toEqual([]);
    expect(
      await screen.findByText('Complete el nombre, el documento y el vínculo del representante.'),
    ).toBeVisible();

    await user.type(screen.getByLabelText('Nombre y apellido del representante'), 'Luis Gómez');
    await user.type(screen.getByLabelText('Documento del representante'), '20123456');
    await user.type(screen.getByLabelText('Vínculo con el paciente'), 'padre');
    await user.click(screen.getByRole('button', { name: 'Firmar consentimiento' }));

    expect(sent).toEqual([
      {
        versionId: VERSION,
        accepted: true,
        signer: 'representative',
        representative: { name: 'Luis Gómez', nationalId: '20123456', relation: 'padre' },
        mark: { kind: 'typed', name: 'Luis Gómez' },
      },
    ]);
  });

  it('lets an adult have a legal representative sign in their name, recorded as such', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    await user.click(screen.getByRole('checkbox', { name: /Firma un representante legal/ }));
    await user.type(screen.getByLabelText('Nombre y apellido del representante'), 'Rosa Díaz');
    await user.type(screen.getByLabelText('Documento del representante'), '12345678');
    await user.type(screen.getByLabelText('Vínculo con el paciente'), 'hija');
    await typeMark(user, 'Rosa Díaz');
    await user.click(screen.getByRole('checkbox', { name: /acepto este consentimiento/ }));

    await user.click(screen.getByRole('button', { name: 'Firmar consentimiento' }));

    expect(sent[0]).toMatchObject({
      signer: 'representative',
      representative: { name: 'Rosa Díaz' },
    });
  });

  it('shows what the server answered, such as an expired request', async () => {
    const error = new ApiError({
      status: 409,
      kind: 'problem',
      code: 'consent_request_expired',
      i18nKey: 'errors.consent_request_expired',
      requestId: 'req-1',
      fieldErrors: [],
    });
    open(signingView(), { error });

    expect(
      await screen.findByText('La solicitud venció y ya no se puede firmar. Genere una nueva.'),
    ).toBeVisible();
  });

  it('has no accessibility violations, with the text, the representative and the mark', async () => {
    const user = userEvent.setup();
    const { app } = open(signingView({ requiresRepresentative: true }));
    await typeMark(user);

    expect(await a11yViolations(app.container)).toEqual([]);
    expect(BODY.length).toBeGreaterThan(0);
  });
});
