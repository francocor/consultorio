import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { a11yViolations } from '../test/a11y.js';
import { renderWithApp } from '../test/render.js';

import { Button } from './button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './sheet.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js';
import { Toaster, toast } from './toaster.js';

function SampleDialog({ onConfirm }: { onConfirm?: () => void }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Abrir</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invitar</DialogTitle>
          <DialogDescription>Se enviará un correo.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onConfirm}>Enviar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens as a modal named by its title, traps focus inside and closes with Escape', async () => {
    const user = userEvent.setup();
    renderWithApp(<SampleDialog />);

    await user.click(screen.getByRole('button', { name: 'Abrir' }));

    const dialog = await screen.findByRole('dialog', { name: 'Invitar' });
    expect(within(dialog).getByText('Se enviará un correo.')).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Abrir' })).toHaveFocus();
  });

  it('has a translated close button and runs the footer action', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithApp(<SampleDialog onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    await user.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('has no accessibility violations while open', async () => {
    const user = userEvent.setup();
    renderWithApp(<SampleDialog />);
    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    const dialog = await screen.findByRole('dialog');

    expect(await a11yViolations(dialog)).toEqual([]);
  });
});

describe('Sheet', () => {
  it('slides in from a side as a dialog and closes with its button', async () => {
    const user = userEvent.setup();
    renderWithApp(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Más</Button>
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetTitle>Más opciones</SheetTitle>
          <SheetDescription>Otras secciones</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    await user.click(screen.getByRole('button', { name: 'Más' }));
    expect(await screen.findByRole('dialog', { name: 'Más opciones' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('Tabs', () => {
  it('moves between tabs with the arrow keys and shows only the active panel', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="one">
        <TabsList aria-label="Secciones">
          <TabsTrigger value="one">Uno</TabsTrigger>
          <TabsTrigger value="two">Dos</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Contenido uno</TabsContent>
        <TabsContent value="two">Contenido dos</TabsContent>
      </Tabs>,
    );

    expect(screen.getByRole('tab', { name: 'Uno', selected: true })).toBeInTheDocument();
    expect(screen.getByText('Contenido uno')).toBeVisible();
    expect(screen.queryByText('Contenido dos')).not.toBeInTheDocument();

    screen.getByRole('tab', { name: 'Uno' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Dos', selected: true })).toHaveFocus();
    expect(screen.getByText('Contenido dos')).toBeVisible();
    expect(screen.queryByText('Contenido uno')).not.toBeInTheDocument();
  });
});

describe('DropdownMenu', () => {
  it('opens from the keyboard, lists items and runs the chosen one', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Cuenta</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Ana</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut}>Salir</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    screen.getByRole('button', { name: 'Cuenta' }).focus();
    await user.keyboard('{Enter}');

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Salir' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Salir' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('Toaster', () => {
  it('announces a message politely and lets it be dismissed', async () => {
    render(<Toaster />);

    toast.success('Cambios guardados');

    const message = await screen.findByText('Cambios guardados');
    expect(message).toBeInTheDocument();
    expect(message.closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
  });
});
