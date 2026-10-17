import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@consultorio/contracts';
import { Check, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';

/** What a good password looks like, shown before the person types. The length updates live. */
export function PasswordHints({ value }: { value: string }) {
  const { t } = useTranslation('auth');
  const length = Array.from(value).length;
  const lengthOk = length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
  return (
    <div className="rounded-md bg-muted/60 p-3 text-sm">
      <p className="font-medium">{t('password.hints.title')}</p>
      <ul className="mt-2 grid gap-1.5 text-muted-foreground">
        <li className="flex items-start gap-2">
          {lengthOk ? (
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <Circle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <span className={cn(lengthOk && 'text-foreground')}>{t('password.hints.length')}</span>
        </li>
        <li className="flex items-start gap-2">
          <Circle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('password.hints.phrase')}</span>
        </li>
        <li className="flex items-start gap-2">
          <Circle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('password.hints.unique')}</span>
        </li>
      </ul>
    </div>
  );
}
