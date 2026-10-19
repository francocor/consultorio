import { MATRICULA_NOTE_MAX } from '@consultorio/contracts';
import type { OperatorMatriculaDto, OperatorMatriculaStatus } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, NotebookPen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
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
import { Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';
import { toast } from '../../../shared/ui/toaster.js';

import { matriculaApi, matriculaKeys } from './matricula-api.js';

const FILTERS = ['unverified', 'verified'] as const;

type Pending =
  | { kind: 'verify'; item: OperatorMatriculaDto }
  | { kind: 'unverify'; item: OperatorMatriculaDto }
  | { kind: 'note'; item: OperatorMatriculaDto };

type Translate = ReturnType<typeof useTranslation>['t'];

/** What the server said, with the one refusal that has a story of its own told in full. */
function refusalOf(t: Translate, error: unknown): string {
  if (isApiError(error) && error.status === 409) return t('operator:matricula.error.changed');
  return describeError(t, error).message;
}

/** A professional with no name loaded still has to be addressable by assistive technology. */
function nameOf(t: Translate, item: OperatorMatriculaDto): string {
  return item.fullName !== null && item.fullName.trim() !== ''
    ? item.fullName
    : t('operator:matricula.noName');
}

/**
 * The matricula queue of the platform operator (STF-04). The operator checks a registration with
 * the issuing authority and vouches for it here; only e-prescription reads the result. The screen
 * shows the name, the registration and the organization and nothing of the care.
 */
export function MatriculaQueue() {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const [status, setStatus] = useState<OperatorMatriculaStatus>('unverified');
  const [pending, setPending] = useState<Pending | null>(null);

  const queue = useQuery({
    queryKey: matriculaKeys.queue(status),
    queryFn: () => matriculaApi(api).queue(status),
  });
  const items = queue.data ?? [];
  const close = () => {
    setPending(null);
  };

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t('operator:matricula.title')}
        description={t('operator:matricula.description')}
        className="mb-0"
      />

      <div role="group" aria-label={t('operator:matricula.filter.label')} className="flex gap-2">
        {FILTERS.map((option) => (
          <Button
            key={option}
            variant={status === option ? 'default' : 'outline'}
            size="sm"
            aria-pressed={status === option}
            onClick={() => {
              setStatus(option);
            }}
          >
            {t(`operator:matricula.filter.${option}`)}
          </Button>
        ))}
      </div>

      {queue.isPending ? (
        <ListSkeleton rows={4} />
      ) : queue.isError ? (
        <ErrorState
          error={queue.error}
          onRetry={() => {
            void queue.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={BadgeCheck}
          title={t(`operator:matricula.empty.${status}.title`)}
          description={t(`operator:matricula.empty.${status}.description`)}
        />
      ) : (
        <TableContainer aria-label={t(`operator:matricula.table.${status}`)}>
          <Table>
            <TableCaption>{t(`operator:matricula.table.${status}`)}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('operator:matricula.col.professional')}</TableHead>
                <TableHead>{t('operator:matricula.col.tenant')}</TableHead>
                <TableHead>{t('operator:matricula.col.jurisdiction')}</TableHead>
                <TableHead>{t('operator:matricula.col.number')}</TableHead>
                <TableHead>{t('operator:matricula.col.status')}</TableHead>
                <TableHead>{t('operator:matricula.col.note')}</TableHead>
                <TableHead>{t('operator:matricula.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const name = nameOf(t, item);
                return (
                  <TableRow key={item.professionalId}>
                    <TableCell className="font-medium">{name}</TableCell>
                    <TableCell>{item.tenant.name}</TableCell>
                    <TableCell className="whitespace-nowrap">{item.jurisdiction}</TableCell>
                    <TableCell className="tabular whitespace-nowrap">{item.number}</TableCell>
                    <TableCell>
                      {item.status === 'verified' ? (
                        <div className="grid gap-1">
                          <StatusBadge status="verified">
                            {t('operator:matricula.status.verified')}
                          </StatusBadge>
                          <span className="text-xs text-muted-foreground">
                            {t('operator:matricula.verifiedOn', {
                              date: formatDate(item.verifiedAt),
                            })}
                          </span>
                        </div>
                      ) : (
                        <StatusBadge status="unverified">
                          {t('operator:matricula.status.unverified')}
                        </StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 break-words whitespace-normal">
                      {item.note ?? (
                        <span className="text-muted-foreground">
                          {t('operator:matricula.noNote')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {item.status === 'verified' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('operator:matricula.unverifyNamed', { name })}
                            onClick={() => {
                              setPending({ kind: 'unverify', item });
                            }}
                          >
                            {t('operator:matricula.unverify')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            aria-label={t('operator:matricula.verifyNamed', { name })}
                            onClick={() => {
                              setPending({ kind: 'verify', item });
                            }}
                          >
                            <BadgeCheck aria-hidden="true" />
                            {t('operator:matricula.verify')}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('operator:matricula.noteNamed', { name })}
                          onClick={() => {
                            setPending({ kind: 'note', item });
                          }}
                        >
                          <NotebookPen aria-hidden="true" />
                          {t('operator:matricula.noteAction')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {pending?.kind === 'verify' ? <VerifyDialog item={pending.item} onClose={close} /> : null}
      {pending?.kind === 'unverify' ? <UnverifyDialog item={pending.item} onClose={close} /> : null}
      {pending?.kind === 'note' ? <NoteDialog item={pending.item} onClose={close} /> : null}
    </div>
  );
}

/** The registration under review, in words, so the operator confirms exactly what they checked. */
function Registration({ item }: { item: OperatorMatriculaDto }) {
  const { t } = useTranslation('operator');
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <dt className="text-muted-foreground">{t('matricula.col.professional')}</dt>
      <dd className="font-medium">{nameOf(t, item)}</dd>
      <dt className="text-muted-foreground">{t('matricula.col.tenant')}</dt>
      <dd>{item.tenant.name}</dd>
      <dt className="text-muted-foreground">{t('matricula.col.jurisdiction')}</dt>
      <dd>{item.jurisdiction}</dd>
      <dt className="text-muted-foreground">{t('matricula.col.number')}</dt>
      <dd className="tabular">{item.number}</dd>
    </dl>
  );
}

function NoteField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('operator');
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={MATRICULA_NOTE_MAX}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t('matricula.noteHelp', { max: MATRICULA_NOTE_MAX })}
      </p>
    </div>
  );
}

function VerifyDialog({ item, onClose }: { item: OperatorMatriculaDto; onClose: () => void }) {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const verify = useMutation({
    mutationFn: () =>
      matriculaApi(api).verify(item.tenant.id, item.professionalId, {
        jurisdiction: item.jurisdiction,
        number: item.number,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: async () => {
      toast.success(t('operator:matricula.verified'));
      await queryClient.invalidateQueries({ queryKey: matriculaKeys.all });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('operator:matricula.verifyDialog.title')}</DialogTitle>
          <DialogDescription>{t('operator:matricula.verifyDialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            verify.mutate();
          }}
        >
          {verify.isError ? (
            <Alert tone="danger">
              <AlertDescription>{refusalOf(t, verify.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Registration item={item} />
          <NoteField
            id="matricula-verify-note"
            label={t('operator:matricula.noteOptional')}
            value={note}
            onChange={setNote}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={verify.isPending}>
              {t('operator:matricula.verifyDialog.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UnverifyDialog({ item, onClose }: { item: OperatorMatriculaDto; onClose: () => void }) {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const unverify = useMutation({
    mutationFn: () =>
      matriculaApi(api).unverify(
        item.tenant.id,
        item.professionalId,
        note.trim() === '' ? {} : { note: note.trim() },
      ),
    onSuccess: async () => {
      toast.success(t('operator:matricula.unverified'));
      await queryClient.invalidateQueries({ queryKey: matriculaKeys.all });
      onClose();
    },
  });

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('operator:matricula.unverifyDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('operator:matricula.unverifyDialog.description', { name: nameOf(t, item) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {unverify.isError ? (
          <Alert tone="danger">
            <AlertDescription>{refusalOf(t, unverify.error)}</AlertDescription>
          </Alert>
        ) : null}
        <Registration item={item} />
        <NoteField
          id="matricula-unverify-note"
          label={t('operator:matricula.noteOptional')}
          value={note}
          onChange={setNote}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
          <AlertDialogDestructiveAction
            onClick={(event) => {
              // The dialog stays open until the server answers, so a refusal can be read.
              event.preventDefault();
              unverify.mutate();
            }}
          >
            {t('operator:matricula.unverifyDialog.confirm')}
          </AlertDialogDestructiveAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NoteDialog({ item, onClose }: { item: OperatorMatriculaDto; onClose: () => void }) {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [note, setNote] = useState(item.note ?? '');

  const save = useMutation({
    mutationFn: () => matriculaApi(api).saveNote(item.tenant.id, item.professionalId, { note }),
    onSuccess: async () => {
      toast.success(t('operator:matricula.noteSaved'));
      await queryClient.invalidateQueries({ queryKey: matriculaKeys.all });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('operator:matricula.noteDialog.title')}</DialogTitle>
          <DialogDescription>{t('operator:matricula.noteDialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {save.isError ? (
            <Alert tone="danger">
              <AlertDescription>{refusalOf(t, save.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Registration item={item} />
          <NoteField
            id="matricula-note"
            label={t('operator:matricula.noteLabel')}
            value={note}
            onChange={setNote}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t('operator:matricula.noteDialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
