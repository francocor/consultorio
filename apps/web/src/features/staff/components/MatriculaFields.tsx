import { AR_JURISDICTIONS } from '@consultorio/contracts';
import { useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';

const NATIONAL = AR_JURISDICTIONS.national;

/** The two inputs every form that completes a professional profile shares. */
export interface MatriculaFieldValues {
  jurisdiction: string;
  matriculaNumber: string;
}

/**
 * Adds the inline errors when the registration is incomplete. An owner who acts as a professional
 * needs the jurisdiction and the number before the role is active (decision D21, revised).
 */
export function requireMatricula(values: MatriculaFieldValues, ctx: z.RefinementCtx): void {
  if (values.jurisdiction === '') {
    ctx.addIssue({ code: 'custom', path: ['jurisdiction'], message: 'validation.required' });
  }
  if (values.matriculaNumber === '') {
    ctx.addIssue({ code: 'custom', path: ['matriculaNumber'], message: 'validation.required' });
  }
}

/**
 * Jurisdiction and number of the matricula. Both are required: the registration stays unverified
 * (it is enough for clinical work, decision D1) until the platform checks it.
 */
export function MatriculaFields() {
  const { t } = useTranslation('staff');
  const { control } = useFormContext<MatriculaFieldValues>();

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={control}
          name="jurisdiction"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('matricula.jurisdiction')}</FormLabel>
              <FormControl>
                <Select {...field}>
                  <option value="">{t('matricula.jurisdiction.choose')}</option>
                  <option value={NATIONAL}>{t('matricula.jurisdiction.national')}</option>
                  {AR_JURISDICTIONS.provincial.map((place) => (
                    <option key={place.code} value={place.code}>
                      {place.name}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name="matriculaNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('matricula.number')}</FormLabel>
              <FormControl>
                <Input inputMode="numeric" autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <p className="text-sm text-muted-foreground">{t('matricula.hint')}</p>
    </div>
  );
}
