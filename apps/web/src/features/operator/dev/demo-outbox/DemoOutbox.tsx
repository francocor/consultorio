import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatDateTime } from '../../../../shared/lib/format.js';
import { Button } from '../../../../shared/ui/button.js';
import { Input } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';

import { demoOutboxApi, demoOutboxKeys } from './outbox-api.js';

/** The list shows by itself what the demo sent in the meantime (a sign-in code just asked for). */
const REFRESH_MS = 3000;

/**
 * The email of the demo organizations in the provider console. A demo never sends a real message:
 * what it would have sent is kept here, so the sign-in code of the patient portal and the other
 * notices can be read without a mailbox. Each message shows its whole text. Fictitious data only.
 */
export function DemoOutbox() {
  const { t } = useTranslation('operator');
  const api = useApi();
  const [draft, setDraft] = useState('');
  const [address, setAddress] = useState('');
  const outbox = useQuery({
    queryKey: demoOutboxKeys.list(address),
    queryFn: () => demoOutboxApi(api).list(address),
    refetchInterval: REFRESH_MS,
  });

  return (
    <div className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('demoOutbox.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('demoOutbox.description')}</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAddress(draft.trim());
        }}
      >
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Label htmlFor="demo-outbox-address">{t('demoOutbox.filter.label')}</Label>
          <Input
            id="demo-outbox-address"
            type="search"
            value={draft}
            autoComplete="off"
            placeholder={t('demoOutbox.filter.placeholder')}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <Button type="submit" variant="outline">
          {t('demoOutbox.filter.apply')}
        </Button>
      </form>

      {outbox.isPending ? <FormSkeleton fields={2} /> : null}
      {outbox.isError ? (
        <ErrorState
          error={outbox.error}
          onRetry={() => {
            void outbox.refetch();
          }}
        />
      ) : null}
      {outbox.isSuccess && outbox.data.messages.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t('demoOutbox.none')}
        </p>
      ) : null}
      {outbox.isSuccess
        ? outbox.data.messages.map((message) => (
            <article
              key={message.id}
              aria-labelledby={`demo-outbox-${message.id}`}
              className="grid gap-2 rounded-lg border bg-card p-4"
            >
              <h3 id={`demo-outbox-${message.id}`} className="break-words font-medium">
                {message.subject}
              </h3>
              <p className="text-sm text-muted-foreground">
                <span className="break-all">{message.to}</span>
                {' · '}
                <time dateTime={message.createdAt} className="tabular">
                  {formatDateTime(message.createdAt)}
                </time>
              </p>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                {message.text}
              </pre>
            </article>
          ))
        : null}
    </div>
  );
}
