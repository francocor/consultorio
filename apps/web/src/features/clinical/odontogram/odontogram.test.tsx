import type { Odontogram as OdontogramValue } from '@consultorio/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { a11yViolations } from '../../../shared/test/a11y.js';
import { renderWithApp } from '../../../shared/test/render.js';

import { Odontogram } from './Odontogram.js';

function Harness({
  initial = {},
  readOnly = false,
  current,
}: {
  initial?: OdontogramValue;
  readOnly?: boolean;
  current?: Parameters<typeof Odontogram>[0]['current'];
}) {
  const [value, setValue] = useState<OdontogramValue>(initial);
  return (
    <>
      <Odontogram
        value={value}
        {...(readOnly ? {} : { onChange: setValue })}
        {...(current ? { current } : {})}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

const valueOf = () => JSON.parse(screen.getByTestId('value').textContent) as OdontogramValue;

describe('the chart', () => {
  it('draws the 32 permanent and the 20 primary teeth, each one a labelled button', () => {
    const view = renderWithApp(<Harness />);

    expect(screen.getAllByRole('button', { name: /^Pieza \d\d:/ })).toHaveLength(52);
    expect(screen.getByRole('button', { name: 'Pieza 16: sin registro' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pieza 85: sin registro' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Odontograma' })).toBeInTheDocument();
    expect(view.missingKeys).toEqual([]);
  });

  it('says what each tooth holds in its name: condition and surfaces', () => {
    renderWithApp(
      <Harness
        initial={{
          '16': { condition: 'caries', surfaces: { occlusal: { finding: 'caries' } } },
          '26': { condition: 'crown' },
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Pieza 16: Caries, oclusal o incisal' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pieza 26: Corona' })).toBeInTheDocument();
  });
});

describe('recording a finding', () => {
  it('opens the tooth, sets its condition and the finding of a surface', async () => {
    const user = userEvent.setup();
    renderWithApp(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Pieza 16: sin registro' }));
    const panel = screen.getByRole('region', { name: 'Pieza 16' });
    await user.selectOptions(within(panel).getByLabelText('Estado de la pieza'), 'caries');
    await user.selectOptions(
      within(panel).getByLabelText('Hallazgo, cara oclusal o incisal'),
      'caries',
    );
    await user.type(
      within(panel).getByLabelText('Tratamiento, cara oclusal o incisal'),
      'Restauración',
    );

    expect(valueOf()).toEqual({
      '16': {
        condition: 'caries',
        surfaces: { occlusal: { finding: 'caries', treatment: 'Restauración' } },
      },
    });
    expect(
      screen.getByRole('button', { name: 'Pieza 16: Caries, oclusal o incisal' }),
    ).toBeInTheDocument();
  });

  it('removes a tooth when everything is cleared, or with the clear button', async () => {
    const user = userEvent.setup();
    renderWithApp(
      <Harness initial={{ '16': { condition: 'caries' }, '26': { condition: 'crown' } }} />,
    );

    await user.click(screen.getByRole('button', { name: 'Pieza 16: Caries' }));
    await user.click(screen.getByRole('button', { name: 'Quitar el registro de esta pieza' }));

    expect(valueOf()).toEqual({ '26': { condition: 'crown' } });
    await user.click(screen.getByRole('button', { name: 'Pieza 26: Corona' }));
    await user.selectOptions(screen.getByLabelText('Estado de la pieza'), '');
    expect(valueOf()).toEqual({});
  });

  it('closes the editor with the done button', async () => {
    const user = userEvent.setup();
    renderWithApp(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Pieza 11: sin registro' }));

    await user.click(screen.getByRole('button', { name: 'Listo' }));

    expect(screen.queryByRole('region', { name: 'Pieza 11' })).not.toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  it('moves between teeth with the arrows and opens one with Enter', async () => {
    const user = userEvent.setup();
    renderWithApp(<Harness />);
    const first = screen.getByRole('button', { name: 'Pieza 18: sin registro' });
    first.focus();

    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Pieza 16: sin registro' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Pieza 46: sin registro' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('region', { name: 'Pieza 46' })).toBeInTheDocument();
  });

  it('keeps one tab stop for the whole chart', () => {
    renderWithApp(<Harness />);

    const stops = screen
      .getAllByRole('button', { name: /^Pieza \d\d:/ })
      .filter((tooth) => tooth.getAttribute('tabindex') === '0');

    expect(stops).toHaveLength(1);
  });
});

describe('read only', () => {
  it('shows what was recorded and offers no editor', async () => {
    const user = userEvent.setup();
    renderWithApp(<Harness readOnly initial={{ '16': { condition: 'caries' } }} />);

    await user.click(screen.getByRole('button', { name: 'Pieza 16: Caries' }));

    expect(screen.queryByLabelText('Estado de la pieza')).not.toBeInTheDocument();
  });
});

describe('the current state', () => {
  it('names the state from the signed entries for a tooth this entry does not record', () => {
    renderWithApp(
      <Harness
        current={{
          '16': {
            condition: 'restoration',
            surfaces: {},
            updatedAt: '2026-05-01T10:00:00.000Z',
            authorProfessionalId: '0190a000-0000-7000-8000-0000000000b2',
          },
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Pieza 16: Restauración (estado actual)' }),
    ).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no violations with the chart and an open tooth', async () => {
    const user = userEvent.setup();
    const view = renderWithApp(<Harness initial={{ '16': { condition: 'caries' } }} />);
    await user.click(screen.getByRole('button', { name: 'Pieza 16: Caries' }));

    expect(await a11yViolations(view.container)).toEqual([]);
  });
});
