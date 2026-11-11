import {
  templateFor,
  validateSignContent,
  type FieldIssue,
  type NoteDto,
  type NoteVisibility,
} from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Check, CloudOff, Lock, PenLine, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FormProvider, useForm, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { cn } from '../../../shared/lib/cn.js';
import { translateApiKey } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import { toast } from '../../../shared/ui/toaster.js';
import { clinicalApi } from '../api/clinical-api.js';
import { cleanContent } from '../domain/content.js';
import { applyIssues, useAutosave, type SaveStatus } from '../domain/use-autosave.js';
import { TemplateFields } from '../templates/TemplateFields.js';

/** How long after the last keystroke the draft is saved. Only a test changes it. */
export const autosaveConfig = { delayMs: 1500 };

interface ClinicalEditorProps {
  note: NoteDto;
  /** The note changed on the server (saved, signed); the page keeps its copy in step. */
  onNote: (note: NoteDto) => void;
  autosaveDelayMs?: number;
}

const INDICATOR_ICON: Record<SaveStatus, typeof Check> = {
  saved: Check,
  dirty: PenLine,
  saving: PenLine,
  invalid: TriangleAlert,
  failed: CloudOff,
  stale: TriangleAlert,
  locked: Lock,
};

const INDICATOR_KEY: Record<SaveStatus, string> = {
  saved: 'editor.saved',
  dirty: 'editor.unsaved',
  saving: 'editor.saving',
  invalid: 'editor.invalid',
  failed: 'editor.saveFailed',
  stale: 'editor.unsaved',
  locked: 'editor.notDraft.short',
};

/**
 * The editor of a draft (clinical-records, "Draft, signing and immutability"). It is driven by the
 * template of the note: the fields, what is required to sign and the rules of each value come from
 * the contract schemas, the same ones the server applies. The draft is saved by itself a moment
 * after the last change, with the revision it was based on; a newer revision from another screen
 * stops the saves and asks the author what to do. Signing asks for confirmation, because a signed
 * note cannot be changed again.
 */
export function ClinicalEditor({
  note,
  onNote,
  autosaveDelayMs = autosaveConfig.delayMs,
}: ClinicalEditorProps) {
  // `common` first: it is the default catalog, where the generic `validation.*` messages live.
  const { t } = useTranslation(['common', 'clinical']);
  const api = useApi();
  const template = templateFor(note.templateKind, note.templateVersion);
  const [visibility, setVisibility] = useState<NoteVisibility>(note.visibility);
  const [missing, setMissing] = useState<FieldIssue[]>([]);
  const [confirming, setConfirming] = useState(false);

  const resolver = useMemo(
    () => (template ? zodResolver(template.draft as never) : undefined) as Resolver | undefined,
    [template],
  );
  const form = useForm({
    defaultValues: note.content,
    ...(resolver ? { resolver } : {}),
    mode: 'onChange',
  });

  const autosave = useAutosave({
    note,
    form,
    visibility,
    delayMs: autosaveDelayMs,
    onSaved: onNote,
  });

  const sign = useMutation({
    mutationFn: () => clinicalApi(api).sign(note.id, autosave.revision()),
    onSuccess: (signed) => {
      setConfirming(false);
      toast.success(t('clinical:editor.signed'));
      onNote(signed);
    },
    onError: (error) => {
      setConfirming(false);
      if (!isApiError(error)) return;
      if (error.code === 'stale_revision') autosave.markStale();
      else if (error.code === 'conflict') autosave.markLocked();
      else if (error.code === 'validation_failed') {
        const issues = error.fieldErrors.map((item) => ({
          path: item.path,
          i18nKey: item.i18nKey,
        }));
        applyIssues(form, issues);
        setMissing(issues);
      }
    },
  });

  const requestSignature = async () => {
    setMissing([]);
    const result = await autosave.flush();
    if (result !== 'saved') return;
    if (!template) return;
    const checked = validateSignContent(
      note.templateKind,
      note.templateVersion,
      cleanContent(form.getValues()),
    );
    if (!checked.ok) {
      applyIssues(form, checked.errors);
      setMissing(checked.errors);
      return;
    }
    setConfirming(true);
  };

  const Icon = INDICATOR_ICON[autosave.status];
  const blocked = autosave.status === 'stale' || autosave.status === 'locked';

  return (
    <FormProvider {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{t('clinical:status.draft')}</Badge>
          <Badge tone="brand">{t(`clinical:template.${note.templateKind}`)}</Badge>
          {visibility === 'author_only' ? (
            <Badge tone="warning">{t('clinical:visibility.author_only')}</Badge>
          ) : null}
        </div>

        <CheckboxCard
          checked={visibility === 'author_only'}
          disabled={blocked}
          onCheckedChange={(checked) => {
            setVisibility(checked ? 'author_only' : 'default');
          }}
          title={t('clinical:editor.restrict')}
          description={t('clinical:editor.restrict.help')}
        />

        {autosave.status === 'stale' ? (
          <Alert tone="warning">
            <AlertDescription className="grid gap-3">
              <p className="font-medium">{t('clinical:editor.stale.title')}</p>
              <p>{t('clinical:editor.stale.description')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void autosave.takeServerVersion();
                  }}
                >
                  {t('clinical:editor.stale.reload')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    void autosave.keepMine();
                  }}
                >
                  {t('clinical:editor.stale.keep')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        {autosave.status === 'locked' ? (
          <Alert tone="danger">
            <AlertDescription className="grid gap-3">
              <p className="font-medium">{t('clinical:editor.notDraft.title')}</p>
              <p>{t('clinical:editor.notDraft.description')}</p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  void autosave.takeServerVersion();
                }}
              >
                {t('clinical:editor.notDraft.reload')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {missing.length > 0 ? (
          <Alert tone="danger">
            <AlertDescription className="grid gap-2">
              <p className="font-medium">{t('clinical:editor.sign.missing')}</p>
              <p>{t('clinical:editor.sign.missing.description')}</p>
              <ul className="list-disc pl-5">
                {missing.map((issue) => (
                  <li key={issue.path}>
                    {issue.path.startsWith('(')
                      ? translateApiKey(t, issue.i18nKey)
                      : `${t(`clinical:field.${issue.path.split('.')[0] ?? issue.path}`)}: ${translateApiKey(t, issue.i18nKey)}`}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <TemplateFields kind={note.templateKind} patientId={note.patientId} disabled={blocked} />

        <div
          className={cn(
            'sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3',
            'backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:rounded-lg sm:border',
          )}
        >
          <p
            role="status"
            aria-live="polite"
            className={cn(
              'flex items-center gap-2 text-sm',
              autosave.status === 'saved' ? 'text-muted-foreground' : 'font-medium',
              (autosave.status === 'invalid' || autosave.status === 'failed') && 'text-destructive',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {t(`clinical:${INDICATOR_KEY[autosave.status]}`)}
          </p>
          <Button
            disabled={blocked}
            loading={sign.isPending}
            onClick={() => {
              void requestSignature();
            }}
          >
            {t('clinical:editor.sign')}
          </Button>
        </div>
      </form>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clinical:editor.sign.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('clinical:editor.sign.warning')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('clinical:editor.sign.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                sign.mutate();
              }}
            >
              {t('clinical:editor.sign.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormProvider>
  );
}
