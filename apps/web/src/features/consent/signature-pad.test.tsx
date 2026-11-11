import type { ConsentMarkInput } from '@consultorio/contracts';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../../shared/test/a11y.js';
import { renderWithApp } from '../../shared/test/render.js';

import { SignaturePad } from './index.js';

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A canvas jsdom can draw on: it records the calls and answers with an image. */
function stubCanvas() {
  const calls: string[] = [];
  const context = {
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    stroke: () => calls.push('stroke'),
    clearRect: () => calls.push('clearRect'),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(IMAGE);
  return calls;
}

function open() {
  const marks: (ConsentMarkInput | null)[] = [];
  const app = renderWithApp(
    <SignaturePad
      onChange={(mark) => {
        marks.push(mark);
      }}
    />,
  );
  return { marks, app };
}

describe('the signature pad: drawing', () => {
  it('offers the canvas first and hands over the drawing as a PNG when the stroke ends', async () => {
    const calls = stubCanvas();
    const { marks, app } = open();

    const canvas = await screen.findByRole('img', { name: /Espacio para dibujar la firma/ });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    expect(calls).toContain('stroke');
    expect(marks.at(-1)).toEqual({ kind: 'drawn', imageDataUrl: IMAGE });
    expect(screen.getByRole('img', { name: /Firma dibujada/ })).toBeInTheDocument();
    expect(app.missingKeys).toEqual([]);
  });

  it('forgets the drawing when it is cleared, and hands over nothing', async () => {
    const calls = stubCanvas();
    const { marks } = open();
    const user = userEvent.setup();
    const canvas = await screen.findByRole('img', { name: /Espacio para dibujar la firma/ });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    await user.click(screen.getByRole('button', { name: 'Borrar firma' }));

    expect(calls).toContain('clearRect');
    expect(marks.at(-1)).toBeNull();
  });

  it('does not hand over a mark for a move that was never started with a press', async () => {
    stubCanvas();
    const { marks } = open();

    const canvas = await screen.findByRole('img', { name: /Espacio para dibujar la firma/ });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    expect(marks.every((mark) => mark === null)).toBe(true);
  });
});

describe('the signature pad: the typed name', () => {
  it('is a full alternative a keyboard can reach: two buttons come before the canvas', async () => {
    const { marks } = open();
    const user = userEvent.setup();

    const [draw, type] = await screen.findAllByRole('button');
    expect(draw).toHaveAccessibleName('Dibujar la firma');
    expect(type).toHaveAccessibleName('Escribir el nombre');
    await user.click(type as HTMLElement);
    await user.type(screen.getByLabelText('Nombre completo, como firma'), 'Ana Pérez');

    expect(marks.at(-1)).toEqual({ kind: 'typed', name: 'Ana Pérez' });
    expect(screen.getByRole('button', { name: 'Escribir el nombre', pressed: true })).toBeVisible();
    expect(screen.queryByRole('img', { name: /Espacio para dibujar/ })).not.toBeInTheDocument();
  });

  it('hands over nothing while the name is too short to be a signature', async () => {
    const { marks } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Escribir el nombre' }));

    await user.type(screen.getByLabelText('Nombre completo, como firma'), 'A');

    expect(marks.at(-1)).toBeNull();
  });

  it('forgets the typed name when the signer goes back to drawing', async () => {
    stubCanvas();
    const { marks } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Escribir el nombre' }));
    await user.type(screen.getByLabelText('Nombre completo, como firma'), 'Ana Pérez');
    expect(marks.at(-1)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Dibujar la firma' }));

    expect(marks.at(-1)).toBeNull();
  });
});

describe('the signature pad: accessibility', () => {
  it('has no accessibility violations in either mode', async () => {
    const { app } = open();
    const user = userEvent.setup();
    await screen.findByRole('group', { name: 'Cómo dejar la firma' });
    expect(await a11yViolations(app.container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Escribir el nombre' }));
    expect(await a11yViolations(app.container)).toEqual([]);
  });
});
