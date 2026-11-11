import { Clock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useNow } from '../../../shared/lib/use-now.js';

const LOW_MS = 2 * 60_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/**
 * How long the held time lasts. The numbers tick on screen for sighted visitors; assistive
 * technology hears nothing every second, only one message when less than two minutes are left. When
 * the time is up it tells the page once.
 */
export function HoldCountdown({
  expiresAt,
  onExpire,
}: {
  expiresAt: string;
  onExpire: () => void;
}) {
  const { t } = useTranslation('booking');
  const now = useNow(1000);
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  const expired = remaining <= 0;
  const told = useRef(false);

  useEffect(() => {
    if (expired && !told.current) {
      told.current = true;
      onExpire();
    }
  }, [expired, onExpire]);

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
      <Clock className="size-4 shrink-0" aria-hidden="true" />
      <span aria-hidden="true" className="tabular">
        {t('hold.countdown', { time: clock(remaining) })}
      </span>
      <span role="status" className="sr-only">
        {remaining > 0 && remaining <= LOW_MS ? t('hold.low') : ''}
      </span>
    </div>
  );
}
