import type { ClinicalSearchQuery } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';

import { authorName } from './NoteView.js';

/**
 * Search inside ONE patient's record (design 4.3). It is the only clinical search there is: it
 * asks for at least two letters, an optional date range, and shows the words around each match.
 * A very long record asks for a range, which the server enforces.
 */
export function ClinicalSearch({ patientId }: { patientId: string }) {
  const { t } = useTranslation(['clinical', 'common']);
  const api = useApi();
  const termId = useId();
  const fromId = useId();
  const toId = useId();
  const [term, setTerm] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [submitted, setSubmitted] = useState<ClinicalSearchQuery | null>(null);
  const [tooShort, setTooShort] = useState(false);

  const results = useQuery({
    queryKey: submitted
      ? clinicalKeys.search(patientId, submitted)
      : ['clinical', 'search', 'idle'],
    queryFn: () => clinicalApi(api).search(patientId, submitted as ClinicalSearchQuery),
    enabled: submitted !== null,
    retry: false,
    // A search is an audited read of clinical text: never answer it from the cache.
    gcTime: 0,
    staleTime: 0,
  });

  const rangeError =
    isApiError(results.error) && results.error.fieldErrors.some((item) => item.path === 'from');

  return (
    <section
      aria-labelledby={`${termId}-title`}
      className="grid gap-3 rounded-lg border bg-card p-4"
    >
      <h3 id={`${termId}-title`} className="font-display text-base font-semibold">
        {t('clinical:search.title')}
      </h3>
      <form
        noValidate
        role="search"
        className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-end md:grid-cols-2 lg:grid-cols-[1fr_9rem_9rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const q = term.trim();
          if (q.length < 2) {
            setTooShort(true);
            return;
          }
          setTooShort(false);
          setSubmitted({ q, ...(from ? { from } : {}), ...(to ? { to } : {}) });
        }}
      >
        <div className="grid gap-1.5 md:col-span-2 lg:col-span-1">
          <Label htmlFor={termId}>{t('clinical:search.label')}</Label>
          <Input
            id={termId}
            type="search"
            autoComplete="off"
            value={term}
            aria-invalid={tooShort || undefined}
            onChange={(event) => {
              setTerm(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={fromId}>{t('clinical:search.from')}</Label>
          <Input
            id={fromId}
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={toId}>{t('clinical:search.to')}</Label>
          <Input
            id={toId}
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          loading={results.isFetching}
          className="md:justify-self-start lg:justify-self-auto"
        >
          <Search aria-hidden="true" />
          {t('clinical:search.submit')}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">{t('clinical:search.help')}</p>
      {tooShort ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('clinical:search.tooShort')}
        </p>
      ) : null}

      {results.isFetching && results.data === undefined ? <ListSkeleton rows={2} /> : null}
      {results.isError ? (
        <Alert tone={rangeError ? 'warning' : 'danger'}>
          <AlertDescription>
            {rangeError
              ? t('clinical:search.range_required')
              : isApiError(results.error) && results.error.status === 403
                ? t('clinical:search.noAccess')
                : describeError(t, results.error).message}
          </AlertDescription>
        </Alert>
      ) : null}
      {results.data ? (
        <div aria-label={t('clinical:search.results')} className="grid gap-2" role="region">
          <p className="text-sm font-medium" role="status">
            {results.data.hits.length === 0
              ? t('clinical:search.none', { scanned: results.data.scanned })
              : t('clinical:search.summary', {
                  count: results.data.hits.length,
                  scanned: results.data.scanned,
                })}
          </p>
          <ul className="grid gap-2">
            {results.data.hits.map((hit) => (
              <li key={hit.noteId} className="grid gap-1 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link
                    to="/notes/$noteId"
                    params={{ noteId: hit.noteId }}
                    className="font-medium text-primary-ink underline-offset-4 hover:underline"
                  >
                    {t(`clinical:template.${hit.templateKind}`)}
                    {hit.signedAt ? `, ${formatDate(hit.signedAt)}` : ''}
                  </Link>
                  <span className="text-muted-foreground">{authorName(t, hit.author)}</span>
                  {hit.inAddendum ? (
                    <Badge tone="info">{t('clinical:search.inAddendum')}</Badge>
                  ) : null}
                </div>
                <p className="text-sm">{hit.snippet}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
