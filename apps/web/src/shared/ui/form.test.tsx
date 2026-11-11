import { zodResolver } from '@hookform/resolvers/zod';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from '../lib/api-client.js';
import { applyApiFieldErrors } from '../lib/form-errors.js';
import { installZodMessages } from '../lib/zod-i18n.js';
import { a11yViolations } from '../test/a11y.js';
import { renderWithApp } from '../test/render.js';

import { Button } from './button.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from './form.js';
import { Input } from './input.js';

installZodMessages();

const schema = z.object({
  email: z.email(),
  name: z.string().min(1),
});
type Values = z.infer<typeof schema>;

function SampleForm({
  onSubmit,
  serverError,
}: {
  onSubmit: (values: Values) => void;
  serverError?: ApiError;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', name: '' },
  });
  return (
    <Form {...form}>
      <form
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            onSubmit(values);
            if (serverError) applyApiFieldErrors(form, serverError);
          })(event);
        }}
        noValidate
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Correo</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" {...field} />
              </FormControl>
              <FormDescription>Usaremos este correo para el acceso.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Guardar</Button>
      </form>
    </Form>
  );
}

describe('Form wrappers', () => {
  it('labels and describes each control, and shows translated errors next to the field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { missingKeys } = renderWithApp(<SampleForm onSubmit={onSubmit} />);

    const email = screen.getByLabelText('Correo');
    expect(email).toHaveAccessibleDescription('Usaremos este correo para el acceso.');
    expect(email).not.toBeInvalid();

    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(email).toBeInvalid();
    expect(email).toHaveAccessibleDescription(/Ingrese un correo electrónico válido\./);
    expect(screen.getByLabelText('Nombre')).toHaveAccessibleDescription(
      'Este dato es obligatorio.',
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(missingKeys).toEqual([]);
  });

  it('submits the values once they are valid and clears the errors', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithApp(<SampleForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Correo'), 'ana@example.test');
    await user.type(screen.getByLabelText('Nombre'), 'Ana');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ email: 'ana@example.test', name: 'Ana' });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('places an error the server returned next to the field it names', async () => {
    const user = userEvent.setup();
    const serverError = new ApiError({
      status: 400,
      kind: 'problem',
      code: 'validation_failed',
      i18nKey: 'errors.validation_failed',
      fieldErrors: [{ path: 'email', i18nKey: 'errors.conflict' }],
    });
    renderWithApp(<SampleForm onSubmit={vi.fn()} serverError={serverError} />);

    await user.type(screen.getByLabelText('Correo'), 'ana@example.test');
    await user.type(screen.getByLabelText('Nombre'), 'Ana');
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByLabelText('Correo')).toBeInvalid();
    expect(screen.getByLabelText('Correo')).toHaveAccessibleDescription(/entra en conflicto/);
  });

  it('has no accessibility violations, with and without errors', async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<SampleForm onSubmit={vi.fn()} />);
    expect(await a11yViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findAllByRole('alert');
    expect(await a11yViolations(container)).toEqual([]);
  });
});
