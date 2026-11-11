import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CONTENT_TYPES,
  type DocumentCategory,
  type DocumentDto,
} from '@consultorio/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, Trash2 } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { translateApiKey } from '../../../shared/lib/translate.js';
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
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { documentKeys, documentsApi } from '../api/documents-api.js';
import { postToStorage, StorageUploadError } from '../api/storage-upload.js';
import { formatFileSize } from '../domain/file-size.js';
import { registerFiles, type RegisteredFile } from '../domain/upload-flow.js';
import {
  addItems,
  canStart,
  isFinished,
  patchItem,
  removeItem,
  summarize,
  type UploadFailure,
  type UploadItem,
} from '../domain/upload-queue.js';
import { planSelection, type FileRefusal } from '../domain/upload-rules.js';

/** How many files travel to storage at the same time. */
const PARALLEL_UPLOADS = 3;

const ACCEPT = DOCUMENT_CONTENT_TYPES.join(',') + ',.pdf,.jpg,.jpeg,.png,.webp,.txt,.docx';

async function runPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
}

export interface UploadDialogProps {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether this user may pick a clinical category (a health professional). */
  canUploadClinical: boolean;
  /** Set to upload a new version of this document. */
  replacing?: DocumentDto | undefined;
}

/**
 * Upload of one or several files for a patient: the category decides who can see them, the files go
 * straight to storage with progress, and each one is confirmed so the server scans it. A file the
 * patient already has is held for a decision instead of being uploaded twice by accident.
 */
export function UploadDialog({
  patientId,
  open,
  onOpenChange,
  canUploadClinical,
  replacing,
}: UploadDialogProps) {
  const { t } = useTranslation(['documents', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const registered = useRef(new Map<string, RegisteredFile>());
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [refusals, setRefusals] = useState<{ name: string; reason: FileRefusal }[]>([]);
  const [category, setCategory] = useState<DocumentCategory>(
    replacing?.category ?? (canUploadClinical ? 'lab_result' : 'id_copy'),
  );
  const [dragging, setDragging] = useState(false);

  const busy = queue.some((item) =>
    ['registering', 'uploading', 'confirming', 'duplicate'].includes(item.status),
  );
  const outcome = summarize(queue);
  const groups = [
    ...(canUploadClinical || replacing?.classification === 'clinical'
      ? ([['clinical', DOCUMENT_CATEGORIES.clinical]] as const)
      : []),
    ['administrative', DOCUMENT_CATEGORIES.administrative] as const,
  ].filter(([group]) => replacing === undefined || replacing.classification === group);

  function reset() {
    setQueue([]);
    setRefusals([]);
    registered.current.clear();
  }

  function close(next: boolean) {
    if (!next && busy) return;
    if (!next) {
      const anyDone = queue.some((item) => item.status === 'done');
      reset();
      if (anyDone)
        void queryClient.invalidateQueries({ queryKey: documentKeys.patient(patientId) });
    }
    onOpenChange(next);
  }

  function pick(files: Iterable<File>) {
    const plan = planSelection(Array.from(files), queue.length);
    setRefusals(plan.refused);
    if (plan.accepted.length > 0) setQueue((current) => addItems(current, plan.accepted));
  }

  function failure(key: string, error: unknown) {
    let kind: UploadFailure = 'network';
    let errorKey: string | undefined;
    if (isApiError(error)) {
      kind = error.kind === 'network' ? 'network' : 'api';
      errorKey = error.i18nKey;
    } else if (error instanceof StorageUploadError) {
      kind = error.kind === 'refused' ? 'refused' : 'network';
    }
    setQueue((current) =>
      patchItem(current, key, {
        status: 'failed',
        error: kind,
        ...(errorKey === undefined ? {} : { errorKey }),
      }),
    );
  }

  async function send(item: UploadItem) {
    const prepared = registered.current.get(item.key);
    if (!prepared) return;
    setQueue((current) => patchItem(current, item.key, { status: 'uploading', progress: 0 }));
    try {
      await postToStorage(prepared.post, item.file, (progress) => {
        setQueue((current) => patchItem(current, item.key, { progress }));
      });
      setQueue((current) => patchItem(current, item.key, { status: 'confirming', progress: 1 }));
      await documentsApi(api).confirmUpload(prepared.documentId);
      setQueue((current) => patchItem(current, item.key, { status: 'done' }));
      // The list behind the dialog shows the new file (as "Analizando") without waiting for the close.
      void queryClient.invalidateQueries({ queryKey: documentKeys.patient(patientId) });
    } catch (error) {
      failure(item.key, error);
    }
  }

  async function start() {
    const todo = queue.filter((item) => item.status === 'ready' || item.status === 'failed');
    if (todo.length === 0) return;
    setQueue((current) =>
      todo.reduce(
        (next, item) => patchItem(next, item.key, { status: 'registering', error: undefined }),
        current,
      ),
    );
    let prepared: Map<string, RegisteredFile>;
    try {
      prepared = await registerFiles(documentsApi(api), {
        patientId,
        category,
        replacesDocumentId: replacing?.id,
        entries: todo.map((item) => ({
          key: item.key,
          file: item.file,
          contentType: item.contentType,
        })),
      });
    } catch (error) {
      for (const item of todo) failure(item.key, error);
      return;
    }
    const proceed: UploadItem[] = [];
    for (const item of todo) {
      const found = prepared.get(item.key);
      if (!found) continue;
      registered.current.set(item.key, found);
      if (found.duplicateOf) {
        setQueue((current) =>
          patchItem(current, item.key, {
            status: 'duplicate',
            documentId: found.documentId,
            duplicateOf: found.duplicateOf ?? undefined,
          }),
        );
      } else {
        proceed.push(item);
      }
    }
    await runPool(proceed, PARALLEL_UPLOADS, send);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    pick(event.dataTransfer.files);
  }

  const title = replacing ? t('documents:upload.titleReplace') : t('documents:upload.title');

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="max-w-xl"
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {replacing
              ? t('documents:upload.descriptionReplace')
              : t('documents:upload.description')}
          </DialogDescription>
        </DialogHeader>

        {replacing ? (
          <p className="text-sm font-medium">
            {t('documents:upload.replacing', { name: replacing.name })}
          </p>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="document-category">{t('documents:upload.category')}</Label>
          <Select
            id="document-category"
            value={category}
            disabled={busy || replacing !== undefined}
            onChange={(event) => {
              setCategory(event.target.value as DocumentCategory);
            }}
            aria-describedby="document-category-help"
          >
            {groups.map(([group, categories]) => (
              <optgroup key={group} label={t(`documents:category.group.${group}`)}>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {t(`documents:category.${value}`)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <p id="document-category-help" className="text-sm text-muted-foreground">
            {t('documents:upload.categoryHelp')}
          </p>
        </div>

        <div
          role="group"
          aria-label={t('documents:upload.fileList')}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={onDrop}
          className={
            'grid gap-3 rounded-lg border border-dashed p-4 ' +
            (dragging ? 'border-primary bg-primary-soft' : 'bg-card')
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={busy || (replacing !== undefined && queue.length >= 1)}
              onClick={() => input.current?.click()}
            >
              <FileUp aria-hidden="true" />
              {queue.length === 0 ? t('documents:upload.choose') : t('documents:upload.chooseMore')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('documents:upload.dropHint')}</p>
          </div>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            multiple={replacing === undefined}
            accept={ACCEPT}
            aria-label={t('documents:upload.choose')}
            onChange={(event) => {
              if (event.target.files) pick(event.target.files);
              event.target.value = '';
            }}
          />

          {queue.length > 0 ? (
            <ul className="grid gap-2" aria-label={t('documents:upload.fileList')}>
              {queue.map((item) => (
                <QueueRow
                  key={item.key}
                  item={item}
                  onRemove={() => {
                    registered.current.delete(item.key);
                    setQueue((current) => removeItem(current, item.key));
                  }}
                  onKeep={() => {
                    void send(item);
                  }}
                />
              ))}
            </ul>
          ) : null}
        </div>

        {refusals.length > 0 ? (
          <Alert tone="warning">
            <AlertDescription>
              <ul className="grid gap-1">
                {refusals.map((refusal, index) => (
                  <li key={`${refusal.name}-${String(index)}`}>
                    {t(`documents:upload.refused.${refusal.reason}`, { name: refusal.name })}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {isFinished(queue) ? (
          <p role="status" className="text-sm font-medium">
            {outcome.done > 0 ? t('documents:upload.summary.done', { count: outcome.done }) : null}{' '}
            {outcome.failed > 0
              ? t('documents:upload.summary.failed', { count: outcome.failed })
              : null}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              close(false);
            }}
          >
            {isFinished(queue) ? t('documents:upload.close') : t('documents:upload.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canStart(queue)}
            loading={busy}
            onClick={() => {
              void start();
            }}
          >
            {queue.some((item) => item.status === 'failed')
              ? t('documents:upload.retry')
              : t('documents:upload.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QueueRow({
  item,
  onRemove,
  onKeep,
}: {
  item: UploadItem;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation(['documents', 'common']);
  const percent = Math.round(item.progress * 100);
  const removable =
    item.status === 'ready' || item.status === 'failed' || item.status === 'duplicate';
  const statusText =
    item.status === 'failed'
      ? item.error === 'api' && item.errorKey
        ? translateApiKey(t, item.errorKey)
        : t(`documents:upload.item.failed.${item.error ?? 'network'}`)
      : t(`documents:upload.item.${item.status === 'duplicate' ? 'ready' : item.status}`);

  return (
    <li className="grid gap-2 rounded-md border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="break-words font-medium">{item.name}</span>
          <span className="text-sm text-muted-foreground">{formatFileSize(item.size)}</span>
        </div>
        {removable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('documents:upload.remove', { name: item.name })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {item.status === 'uploading' ? (
        <div className="flex items-center gap-3">
          <progress
            className="h-2 flex-1"
            value={percent}
            max={100}
            aria-label={t('documents:upload.progress', { name: item.name })}
          />
          <span className="text-sm tabular-nums">
            {t('documents:upload.progressValue', { percent })}
          </span>
        </div>
      ) : null}

      {item.status === 'duplicate' && item.duplicateOf ? (
        <Alert tone="warning">
          <AlertDescription className="grid gap-2">
            <span className="font-medium">
              {t('documents:upload.duplicate.title', { name: item.name })}
            </span>
            <span>{t('documents:upload.duplicate.body', { existing: item.duplicateOf.name })}</span>
            <span className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={onKeep}>
                {t('documents:upload.duplicate.keep')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onRemove}>
                {t('documents:upload.duplicate.discard')}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : (
        <p
          className={
            item.status === 'failed'
              ? 'text-sm text-danger-soft-foreground'
              : 'text-sm text-muted-foreground'
          }
          aria-live="polite"
        >
          {statusText}
        </p>
      )}
    </li>
  );
}
