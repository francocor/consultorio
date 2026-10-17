import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../shared/ui/button.js';

/**
 * Registers the service worker and, when a new version of the app is waiting, asks before
 * switching to it: reloading in the middle of a form would lose what the person typed.
 */
export function UpdatePrompt({ enabled = import.meta.env.PROD }: { enabled?: boolean }) {
  const { t } = useTranslation('common');
  const [waiting, setWaiting] = useState(false);
  const [update, setUpdate] = useState<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void import('virtual:pwa-register').then(({ registerSW }) => {
      const updateServiceWorker = registerSW({
        onNeedRefresh() {
          if (current) setWaiting(true);
        },
      });
      if (current) setUpdate(() => updateServiceWorker);
    });
    return () => {
      current = false;
    };
  }, [enabled]);

  if (!waiting) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-24 z-50 mx-auto flex max-w-md flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg md:bottom-6 md:left-auto md:right-6 md:mx-0"
    >
      <div className="grid gap-1">
        <p className="font-medium">{t('pwa.update.title')}</p>
        <p className="text-sm text-muted-foreground">{t('pwa.update.description')}</p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            void update?.(true);
          }}
        >
          {t('pwa.update.action')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setWaiting(false);
          }}
        >
          {t('pwa.update.later')}
        </Button>
      </div>
    </div>
  );
}
