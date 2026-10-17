import type { TimelineEntryDto } from '@consultorio/contracts';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FilePen, History, Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { cn } from '../../../shared/lib/cn.js';
import { formatDate, formatTime } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button, buttonVariants } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';

import { ClinicalSearch } from './ClinicalSearch.js';
import { NewEncounterForm } from './NewEncounterForm.js';
import { AddendumItem, authorName } from './NoteView.js';
import { VersionsSheet } from './VersionsSheet.js';

interface ChartTabProps {
  patientId: string;
  /** Holds `clinical.note.write`: can start a consultation and has drafts. */
  canWrite: boolean;
  /** Switches the record to the anamnesis tab. */
  onOpenAnamnesis: () => void;
}

/** One entry of the timeline. An entry marked in error stays, struck through and labelled. */
function Entry({
  entry,
  onVersions,
}: {
  entry: TimelineEntryDto;
  onVersions: (noteId: string) => void;
}) {
  const { t } = useTranslation('clinical');
  const wrong = entry.status === 'entered_in_error';
  const moment = entry.signedAt ?? entry.createdAt;
  return (
    <li
      className={cn(
        'grid gap-2 rounded-lg border bg-card p-4',
        wrong && 'border-dashed bg-muted/40',
      )}
      data-status={entry.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{t(`template.${entry.templateKind}`)}</Badge>
        {wrong ? <Badge tone="danger">{t('status.entered_in_error')}</Badge> : null}
        {entry.visibility === 'author_only' ? (
          <Badge tone="warning">
            <Lock aria-hidden="true" />
            {t('visibility.author_only')}
          </Badge>
        ) : null}
        {entry.basis === 'shared' ? <Badge tone="info">{t('basis.shared')}</Badge> : null}
        <span className="text-sm text-muted-foreground">
          {t('entry.by', {
            name: authorName(t, entry.author),
            date: formatDate(moment),
            time: formatTime(moment),
          })}
        </span>
      </div>
      <p className={cn('font-medium', wrong && 'text-muted-foreground line-through')}>
        {entry.headline ?? t('entry.untitled')}
      </p>
      {wrong && entry.errorReason ? (
        <p className="text-sm text-muted-foreground">
          {t('entry.errorReason', { reason: entry.errorReason })}
        </p>
      ) : null}
      {entry.addenda.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium">
            {t('entry.addenda', { count: entry.addenda.length })}
          </p>
          <ul className="grid gap-2">
            {entry.addenda.map((addendum) => (
              <AddendumItem key={addendum.id} addendum={addendum} />
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Link
          to="/notes/$noteId"
          params={{ noteId: entry.noteId }}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          {t('entry.open')}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onVersions(entry.noteId);
          }}
        >
          <History aria-hidden="true" />
          {t('entry.versions')}
        </Button>
      </div>
    </li>
  );
}

/**
 * The clinical chart of a patient: the signed consultations, newest first, with their addenda, the
 * link to the anamnesis and the search of this record. Entries marked in error are hidden until
 * asked for. Every entry shown is an audited read; a professional who does not treat the patient
 * is told they have no access.
 */
export function ChartTab({ patientId, canWrite, onOpenAnamnesis }: ChartTabProps) {
  const { t } = useTranslation(['clinical', 'common']);
  const api = useApi();
  const [showErrors, setShowErrors] = useState(false);
  const [starting, setStarting] = useState(false);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);

  const timeline = useInfiniteQuery({
    queryKey: clinicalKeys.timeline(patientId, showErrors),
    queryFn: ({ pageParam }) =>
      clinicalApi(api).timeline(patientId, { includeErrors: showErrors, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    // Reading the chart is an audited access to clinical content: never from the cache.
    gcTime: 0,
    staleTime: 0,
  });

  if (timeline.isPending) return <ListSkeleton rows={3} />;
  if (timeline.isError) {
    if (isApiError(timeline.error) && timeline.error.status === 403) {
      return (
        <EmptyState
          title={t('clinical:chart.noAccess.title')}
          description={t('clinical:chart.noAccess.description')}
        />
      );
    }
    return (
      <ErrorState
        error={timeline.error}
        onRetry={() => {
          void timeline.refetch();
        }}
      />
    );
  }

  const entries = timeline.data.pages.flatMap((page) => page.entries);
  const anamnesis = timeline.data.pages[0]?.anamnesis ?? null;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-display text-lg font-semibold">{t('clinical:chart.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('clinical:chart.description')}
          </p>
          <p className="text-sm">
            {anamnesis ? (
              <Button variant="link" onClick={onOpenAnamnesis}>
                {t('clinical:chart.anamnesis.link', { version: anamnesis.version })}
              </Button>
            ) : (
              <span className="text-muted-foreground">{t('clinical:chart.anamnesis.none')}</span>
            )}
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <Link to="/drafts" className={cn(buttonVariants({ variant: 'outline' }))}>
              <FilePen aria-hidden="true" />
              {t('clinical:chart.drafts')}
            </Link>
            <Button
              onClick={() => {
                setStarting(true);
              }}
            >
              <Plus aria-hidden="true" />
              {t('clinical:chart.new')}
            </Button>
          </div>
        ) : null}
      </div>

      <ClinicalSearch patientId={patientId} />

      <CheckboxCard
        checked={showErrors}
        onCheckedChange={setShowErrors}
        title={t('clinical:chart.showErrors')}
      />

      {entries.length === 0 ? (
        <EmptyState
          title={t('clinical:chart.empty.title')}
          description={t('clinical:chart.empty.description')}
        />
      ) : (
        <ol aria-label={t('clinical:chart.list')} className="grid gap-3">
          {entries.map((entry) => (
            <Entry key={entry.noteId} entry={entry} onVersions={setVersionsFor} />
          ))}
        </ol>
      )}
      {timeline.hasNextPage ? (
        <Button
          variant="outline"
          className="w-fit"
          loading={timeline.isFetchingNextPage}
          onClick={() => {
            void timeline.fetchNextPage();
          }}
        >
          {t('clinical:chart.loadMore')}
        </Button>
      ) : null}

      <VersionsSheet
        noteId={versionsFor ?? ''}
        open={versionsFor !== null}
        onOpenChange={(open) => {
          if (!open) setVersionsFor(null);
        }}
      />
      <StartConsultation patientId={patientId} open={starting} onOpenChange={setStarting} />
    </div>
  );
}

function StartConsultation({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('clinical');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('new.title')}</DialogTitle>
          <DialogDescription>{t('new.description')}</DialogDescription>
        </DialogHeader>
        <StartConsultationForm
          patientId={patientId}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function StartConsultationForm({
  patientId,
  onCancel,
}: {
  patientId: string;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <NewEncounterForm
      patientId={patientId}
      onCancel={onCancel}
      onOpened={(note) => {
        queryClient.setQueryData(clinicalKeys.note(note.id), note);
        void navigate({ to: '/notes/$noteId', params: { noteId: note.id } });
      }}
    />
  );
}
