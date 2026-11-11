import { Check, Copy, Download, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';

/** The recovery codes, shown once: copy, download and an explicit "I saved them". */
export function RecoveryCodes({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
  const { t } = useTranslation('auth');
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(codes.join('\n'));
    setCopied(true);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('security.recovery.fileName');
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-4">
      <Alert tone="warning">
        <AlertTitle>{t('security.recovery.title')}</AlertTitle>
        <AlertDescription>
          {t('security.recovery.description')} {t('security.recovery.once')}
        </AlertDescription>
      </Alert>
      <ul
        aria-label={t('security.recovery.list')}
        className="grid gap-2 rounded-lg border bg-muted/50 p-4 font-mono text-sm sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code} className="flex items-center gap-2">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="tabular select-all">{code}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {t('security.recovery.copy')}
        </Button>
        <Button variant="outline" onClick={download}>
          <Download aria-hidden="true" />
          {t('security.recovery.download')}
        </Button>
        <span role="status" className="text-sm text-success">
          {copied ? t('security.recovery.copied') : ''}
        </span>
      </div>
      <Button onClick={onDone} className="justify-self-start">
        {t('security.recovery.saved')}
      </Button>
    </div>
  );
}
