import { MailCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { describeError } from '../../../shared/lib/translate.js';
import { useNow } from '../../../shared/lib/use-now.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';

/** Seconds before another code can be asked for. */
const RESEND_COOLDOWN_S = 30;

export interface CodeEntryProps {
  /** `signIn` or `register`: what the code is for, in the words of the screen. */
  purpose: 'signIn' | 'register';
  onConfirm: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  onChangeData: () => void;
  confirming: boolean;
  resending: boolean;
  /** What the last confirmation or resend failed with, if it did. */
  error: unknown;
  /** Another code was just asked for. */
  resent: boolean;
}

/**
 * The step where the person types the six digits that arrived by email. The page never says where
 * the code went or whether there is an account: it says what to do in either case. A wrong,
 * expired or missing code gets one answer, whatever the reason.
 */
export function CodeEntry({
  purpose,
  onConfirm,
  onResend,
  onChangeData,
  confirming,
  resending,
  error,
  resent,
}: CodeEntryProps) {
  const { t } = useTranslation(['portal', 'common']);
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [askedAt, setAskedAt] = useState(() => Date.now());
  const now = useNow(1000);
  const waitS = Math.max(0, RESEND_COOLDOWN_S - Math.floor((now.getTime() - askedAt) / 1000));
  const failure = error ? describeError(t, error) : null;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void onConfirm(code);
  }

  return (
    <section aria-labelledby="portal-code-title" className="grid gap-4">
      <div className="grid justify-items-start gap-2">
        <span className="grid size-10 place-content-center rounded-full bg-primary-soft text-primary-ink">
          <MailCheck className="size-5" aria-hidden="true" />
        </span>
        <h2 id="portal-code-title" className="font-display text-lg font-semibold">
          {t('portal:code.title')}
        </h2>
        <p id={hintId} className="text-sm text-muted-foreground">
          {t(
            purpose === 'register' ? 'portal:code.descriptionRegister' : 'portal:code.description',
          )}
        </p>
      </div>

      {resent ? (
        <Alert tone="success">
          <AlertDescription>{t('portal:code.resent')}</AlertDescription>
        </Alert>
      ) : null}
      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}

      <form noValidate className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>{t('portal:code.label')}</Label>
          <Input
            id={inputId}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            ref={input}
            aria-describedby={hintId}
            aria-invalid={invalid}
            className="tabular text-center text-2xl tracking-[0.5em]"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
              setInvalid(false);
            }}
          />
          {invalid ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t('portal:code.invalid')}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" loading={confirming}>
          {t(purpose === 'register' ? 'portal:code.submitRegister' : 'portal:code.submit')}
        </Button>
      </form>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid gap-1">
          <Button
            variant="outline"
            disabled={waitS > 0 || resending}
            loading={resending}
            onClick={() => {
              setAskedAt(Date.now());
              void onResend();
            }}
          >
            {t('portal:code.resend')}
          </Button>
          {waitS > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('portal:code.resendWait', { seconds: waitS })}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" onClick={onChangeData}>
          {t('portal:code.change')}
        </Button>
      </div>
    </section>
  );
}
