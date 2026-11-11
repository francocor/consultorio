import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../test/a11y.js';

import { Alert, AlertDescription, AlertTitle } from './alert.js';
import { Badge } from './badge.js';
import { Button } from './button.js';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card.js';
import { Checkbox, Switch } from './checkbox.js';
import { Input, Select, Textarea } from './input.js';
import { Label } from './label.js';
import { Skeleton } from './skeleton.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from './table.js';

describe('Button', () => {
  it('is a real button that does not submit forms by accident', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.SyntheticEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button>Cancelar</Button>
        <Button type="submit">Guardar</Button>
      </form>,
    );

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('while loading it keeps its label, is busy and ignores clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Guardar
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Guardar' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can render a link with the look of a button', () => {
    render(
      <Button asChild>
        <a href="/patients/new">Nuevo paciente</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Nuevo paciente' });
    expect(link).toHaveAttribute('href', '/patients/new');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('form controls', () => {
  function Sample() {
    const [accepted, setAccepted] = useState(false);
    const [notify, setNotify] = useState(false);
    return (
      <form>
        <Label htmlFor="name">Nombre</Label>
        <Input id="name" aria-invalid="true" />
        <Label htmlFor="notes">Notas</Label>
        <Textarea id="notes" />
        <Label htmlFor="role">Rol</Label>
        <Select id="role" defaultValue="reception">
          <option value="reception">Recepción</option>
          <option value="admin">Administración</option>
        </Select>
        <Checkbox
          id="terms"
          checked={accepted}
          onCheckedChange={(v) => {
            setAccepted(v === true);
          }}
        />
        <Label htmlFor="terms">Acepto</Label>
        <Switch id="notify" checked={notify} onCheckedChange={setNotify} />
        <Label htmlFor="notify">Avisarme</Label>
      </form>
    );
  }

  it('are reachable by their visible labels and accept typing and choices', async () => {
    const user = userEvent.setup();
    render(<Sample />);

    await user.type(screen.getByLabelText('Nombre'), 'Ana');
    expect(screen.getByLabelText('Nombre')).toHaveValue('Ana');
    expect(screen.getByLabelText('Nombre')).toBeInvalid();

    await user.selectOptions(screen.getByLabelText('Rol'), 'admin');
    expect(screen.getByLabelText('Rol')).toHaveValue('admin');
    expect(
      screen.getByRole('option', { name: 'Administración', selected: true }),
    ).toBeInTheDocument();
  });

  it('checkbox and switch toggle with the mouse and the space bar', async () => {
    const user = userEvent.setup();
    render(<Sample />);

    const terms = screen.getByRole('checkbox', { name: 'Acepto' });
    expect(terms).not.toBeChecked();
    await user.click(terms);
    expect(terms).toBeChecked();
    await user.keyboard(' ');
    expect(terms).not.toBeChecked();

    const notify = screen.getByRole('switch', { name: 'Avisarme' });
    expect(notify).not.toBeChecked();
    await user.click(screen.getByText('Avisarme'));
    expect(notify).toBeChecked();
  });

  it('a form built from them has no accessibility violations', async () => {
    const { container } = render(<Sample />);

    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe('Badge, Card, Alert and Skeleton', () => {
  it('Card exposes a heading and its parts', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Equipo</CardTitle>
          <CardDescription>Personas con acceso</CardDescription>
        </CardHeader>
        <CardContent>Cuatro personas</CardContent>
        <CardFooter>Ver todo</CardFooter>
      </Card>,
    );

    expect(screen.getByRole('heading', { name: 'Equipo' })).toBeInTheDocument();
    expect(screen.getByText('Personas con acceso')).toBeInTheDocument();
    expect(screen.getByText('Ver todo')).toBeInTheDocument();
  });

  it('Badge renders its text for every tone', () => {
    render(
      <div>
        <Badge tone="success">Activo</Badge>
        <Badge tone="warning">Pendiente</Badge>
        <Badge tone="danger">Bloqueado</Badge>
        <Badge tone="info">Nuevo</Badge>
        <Badge tone="neutral">Archivado</Badge>
      </div>,
    );

    for (const label of ['Activo', 'Pendiente', 'Bloqueado', 'Nuevo', 'Archivado']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('Alert is announced as a status or as an alert depending on its tone', () => {
    render(
      <div>
        <Alert tone="info">
          <AlertTitle>Aviso</AlertTitle>
          <AlertDescription>Se guardó el borrador</AlertDescription>
        </Alert>
        <Alert tone="danger">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>No se pudo guardar</AlertDescription>
        </Alert>
      </div>,
    );

    expect(within(screen.getByRole('status')).getByText('Aviso')).toBeInTheDocument();
    expect(within(screen.getByRole('alert')).getByText('No se pudo guardar')).toBeInTheDocument();
  });

  it('Skeleton is decorative: hidden from assistive technology', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Table', () => {
  it('is a semantic table in a focusable, labelled scroll region', async () => {
    const { container } = render(
      <TableContainer aria-label="Pacientes">
        <Table>
          <TableCaption>Lista de pacientes</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>DNI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Ana Pérez</TableCell>
              <TableCell>12.345.678</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>,
    );

    const region = screen.getByRole('region', { name: 'Pacientes' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('columnheader', { name: 'DNI' })).toHaveAttribute('scope', 'col');
    expect(
      within(screen.getByRole('table')).getByRole('cell', { name: 'Ana Pérez' }),
    ).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
