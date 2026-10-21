import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@consultorio/contracts';
import { Check, Circle, Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../shared/lib/cn.js';
import { Input } from '../../../../shared/ui/input.js';

/**
 * A password field with a show/hide button. All the props (id, aria-describedby, aria-invalid...)
 * reach the real input, so the form wrappers can label and describe it.
 */
export function PasswordField(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  const { t } = useTranslation('signup');
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className="pr-12" />
      <button
        type="button"
        onClick={() => {
          setVisible((current) => !current);
        }}
        aria-pressed={visible}
        aria-label={visible ? t('password.hide') : t('password.show')}
        className="touch-target absolute inset-y-0 right-0 grid cursor-pointer place-content-center rounded-md text-muted-foreground hover:text-foreground"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/** What a good password looks like, shown before the person types. The length updates live. */
export function PasswordHints({ value }: { value: string }) {
  const { t } = useTranslation('signup');
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
          <span className={cn(lengthOk && 'text-foreground')}>
            {t('password.hints.length', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })}
          </span>
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
