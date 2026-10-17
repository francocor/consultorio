import type { AddendumDto, NoteDto } from '@consultorio/contracts';
import { History, Lock, MessageSquarePlus, OctagonAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDate, formatTime } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';

import { AddendumDialog } from './AddendumDialog.js';
import { ContentView } from './ContentView.js';
import { ErrorMarkDialog } from './ErrorMarkDialog.js';
import { VersionsSheet } from './VersionsSheet.js';

export function authorName(t: (key: string) => string, author: { name: string | null }): string {
  return author.name ?? t('author.unknown');
}

/** One addendum, after the original note, with who wrote it, when and why. */
export function AddendumItem({ addendum }: { addendum: AddendumDto }) {
  const { t } = useTranslation('clinical');
  return (
    <li className="grid gap-1 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={addendum.kind === 'rectification' ? 'info' : 'neutral'}>
          {t(`entry.addendum.kind.${addendum.kind}`)}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {t('entry.addendum.by', {
            name: authorName(t, addendum.author),
            date: formatDate(addendum.createdAt),
            time: formatTime(addendum.createdAt),
          })}
        </span>
      </div>
      <p className="text-sm font-medium">
        {t('entry.addendum.reason', { reason: addendum.reason })}
      </p>
      <p className="whitespace-pre-wrap text-sm">{addendum.text}</p>
    </li>
  );
}

/**
 * A note as it is read: the original with its addenda after it, who signed it and when, and the
 * actions the reader may take (each shown only if the server said it is allowed: the API repeats
 * every check). Shared readers get a read-only view with nothing to click.
 */
export function NoteView({ note }: { note: NoteDto }) {
  const { t } = useTranslation('clinical');
  const [addendumOpen, setAddendumOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const { access } = note;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            note.status === 'signed' ? 'success' : note.status === 'draft' ? 'neutral' : 'danger'
          }
        >
          {t(`status.${note.status}`)}
        </Badge>
        <Badge tone="brand">{t(`template.${note.templateKind}`)}</Badge>
        {note.visibility === 'author_only' ? (
          <Badge tone="warning">
            <Lock aria-hidden="true" />
            {t('visibility.author_only')}
          </Badge>
        ) : null}
        {access.basis === 'shared' ? <Badge tone="info">{t('basis.shared')}</Badge> : null}
      </div>

      {note.signedAt ? (
        <p className="text-sm text-muted-foreground">
          {t('note.signedBy', {
            name: authorName(t, note.author),
            date: formatDate(note.signedAt),
            time: formatTime(note.signedAt),
          })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{authorName(t, note.author)}</p>
      )}

      {note.error ? (
        <Alert tone="danger">
          <AlertDescription className="grid gap-1">
            <p className="font-medium">
              {t('note.errorBanner', {
                name: authorName(t, note.error.markedBy),
                date: formatDate(note.error.markedAt),
              })}
            </p>
            <p>{t('entry.errorReason', { reason: note.error.reason })}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {access.basis === 'shared' ? (
        <Alert tone="info">
          <AlertDescription>{t('note.shared')}</AlertDescription>
        </Alert>
      ) : null}
      {access.rectificationOnly && note.status === 'signed' ? (
        <Alert tone="warning">
          <AlertDescription>{t('note.readOnlyOrg')}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby={`${note.id}-original`} className="grid gap-3">
        <h2 id={`${note.id}-original`} className="font-display text-lg font-semibold">
          {t('note.original')}
        </h2>
        <ContentView kind={note.templateKind} content={note.content} derived={note.derived} />
        {note.contentHash ? (
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">{t('note.hash')}</summary>
            <p className="mt-1">{t('note.hash.help')}</p>
            <code className="mt-1 block break-all text-xs">{note.contentHash}</code>
          </details>
        ) : null}
      </section>

      {note.addenda.length > 0 ? (
        <section aria-labelledby={`${note.id}-addenda`} className="grid gap-3">
          <h2 id={`${note.id}-addenda`} className="font-display text-lg font-semibold">
            {t('entry.addendum.heading')}
          </h2>
          <ul className="grid gap-2">
            {note.addenda.map((addendum) => (
              <AddendumItem key={addendum.id} addendum={addendum} />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {note.status !== 'draft' ? (
          <Button
            variant="outline"
            onClick={() => {
              setVersionsOpen(true);
            }}
          >
            <History aria-hidden="true" />
            {t('note.versions')}
          </Button>
        ) : null}
        {access.canAddAddendum ? (
          <Button
            variant="outline"
            onClick={() => {
              setAddendumOpen(true);
            }}
          >
            <MessageSquarePlus aria-hidden="true" />
            {t('note.addendum')}
          </Button>
        ) : null}
        {access.canMarkError ? (
          <Button
            variant="outline"
            onClick={() => {
              setErrorOpen(true);
            }}
          >
            <OctagonAlert aria-hidden="true" />
            {t('note.mark')}
          </Button>
        ) : null}
      </div>

      <AddendumDialog note={note} open={addendumOpen} onOpenChange={setAddendumOpen} />
      <ErrorMarkDialog note={note} open={errorOpen} onOpenChange={setErrorOpen} />
      <VersionsSheet noteId={note.id} open={versionsOpen} onOpenChange={setVersionsOpen} />
    </div>
  );
}
