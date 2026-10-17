import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Label } from '../../../shared/ui/label.js';

import { PasswordInput } from './PasswordInput.js';

/**
 * Asks the person to type their password again before a sensitive change. A wrong password is an
 * answer to show here: it never signs anybody out.
 */
export function PasswordConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Resolves when done; a rejection is shown inside the dialog. */
  onConfirm: (password: string) => Promise<void>;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function close(next: boolean) {
    if (!next) {
      setPassword('');
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await onConfirm(password);
      close(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  const wrongPassword = isApiError(error) && error.status === 401;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert tone="danger">
              <AlertDescription>
                {wrongPassword
                  ? t('auth:security.twoFactor.passwordError')
                  : describeError(t, error).message}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-password">{t('auth:field.password')}</Label>
            <PasswordInput
              id="confirm-password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                close(false);
              }}
            >
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              loading={pending}
              disabled={password === ''}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
