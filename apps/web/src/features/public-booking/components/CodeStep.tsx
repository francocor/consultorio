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

export interface CodeStepProps {
  maskedEmail: string;
  onConfirm: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  onChangeEmail: () => void;
  confirming: boolean;
  resending: boolean;
  /** What the last confirmation failed with, if it did. */
  error: unknown;
  /** A new code was just sent. */
  resent: boolean;
}

/**
 * The step where the visitor proves they control the address: six digits, no more. The page says
 * where the code went (hidden in part) and lets them ask for another or fix the address. A wrong or
 * expired code gets one answer, whatever the reason.
 */
export function CodeStep({
  maskedEmail,
  onConfirm,
  onResend,
  onChangeEmail,
  confirming,
  resending,
  error,
  resent,
}: CodeStepProps) {
  const { t } = useTranslation(['booking', 'common']);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  // The step just opened: the cursor goes where the code is typed.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const hintId = useId();
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
    <section aria-labelledby="code-title" className="grid gap-4">
      <div className="grid justify-items-start gap-2">
        <span className="grid size-10 place-content-center rounded-full bg-primary-soft text-primary-ink">
          <MailCheck className="size-5" aria-hidden="true" />
        </span>
        <h2 id="code-title" className="font-display text-lg font-semibold">
          {t('booking:code.title')}
        </h2>
        <p id={hintId} className="text-sm text-muted-foreground">
          {t('booking:code.description', { email: maskedEmail })}
        </p>
      </div>

      {resent ? (
        <Alert tone="success">
          <AlertDescription>{t('booking:code.resent', { email: maskedEmail })}</AlertDescription>
        </Alert>
      ) : null}
      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}

      <form noValidate className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>{t('booking:code.label')}</Label>
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
              {t('booking:code.invalid')}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" loading={confirming}>
          {confirming ? t('booking:code.confirming') : t('booking:code.submit')}
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
            {t('booking:code.resend')}
          </Button>
          {waitS > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('booking:code.resendWait', { seconds: waitS })}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" onClick={onChangeEmail}>
          {t('booking:code.change')}
        </Button>
      </div>
    </section>
  );
}
