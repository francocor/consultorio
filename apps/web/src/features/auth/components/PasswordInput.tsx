import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '../../../shared/ui/input.js';

/**
 * A password field with a show/hide button. All the props (id, aria-describedby, aria-invalid...)
 * reach the real input, so the form wrappers can label and describe it.
 */
export function PasswordInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  const { t } = useTranslation('auth');
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
