import type { ConsentStarterDto, ConsentTemplateDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
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
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { consentApi, consentKeys } from '../api/consent-api.js';
import { SPECIALTIES } from '../domain/specialties.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Writes a template: a new draft (optionally from one of the starters of the product), or the
 * changes of an existing one. A draft is saved in place; saving a published template publishes its
 * next version, and says so before the person saves: the versions already published stay as they
 * were, and so do the signatures that point at them.
 */
export function TemplateEditorDialog({
  template,
  onClose,
}: {
  /** The template to edit; absent for a new one. */
  template?: ConsentTemplateDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['consent', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const editing = template !== undefined;
  const published = template?.status === 'published';
  const [title, setTitle] = useState(template?.title ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [specialty, setSpecialty] = useState(template?.specialty ?? '');
  const [starterKey, setStarterKey] = useState<string | undefined>(undefined);

  const starters = useQuery({
    queryKey: consentKeys.starters,
    queryFn: () => consentApi(api).starters(),
    enabled: !editing,
    staleTime: Infinity,
  });

  const nextVersion = (template?.latestVersionNumber ?? 0) + 1;
  const valid = title.trim().length > 0 && body.trim().length > 0;

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        title: title.trim(),
        body,
        specialty: specialty === '' ? null : specialty,
      };
      if (template) return consentApi(api).updateTemplate(template.id, fields);
      return consentApi(api).createTemplate({
        ...fields,
        ...(starterKey === undefined ? {} : { starterKey }),
      });
    },
    onSuccess: async () => {
      toast.success(
        published
          ? t('consent:editor.publishedVersion', { number: nextVersion })
          : t('consent:editor.saved'),
      );
      await queryClient.invalidateQueries({ queryKey: consentKeys.templates });
      await queryClient.invalidateQueries({ queryKey: consentKeys.offered });
      onClose();
    },
  });

  const chooseStarter = (key: string) => {
    const starter: ConsentStarterDto | undefined = starters.data?.starters.find(
      (entry) => entry.key === key,
    );
    if (!starter) {
      setStarterKey(undefined);
      return;
    }
    setStarterKey(starter.key);
    setTitle(starter.title);
    setBody(starter.body);
    setSpecialty(starter.specialty);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('consent:editor.editTitle') : t('consent:editor.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('consent:editor.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!save.isPending && valid) save.mutate();
          }}
        >
          {published ? (
            <Alert tone="info">
              <AlertDescription>
                {t('consent:editor.publishedNotice', { number: nextVersion })}
              </AlertDescription>
            </Alert>
          ) : null}
          {!editing && starters.data ? (
            <div className="grid gap-1.5">
              <Label htmlFor="consent-starter">{t('consent:editor.starter')}</Label>
              <Select
                id="consent-starter"
                value={starterKey ?? ''}
                onChange={(event) => {
                  chooseStarter(event.target.value);
                }}
              >
                <option value="">{t('consent:editor.starterNone')}</option>
                {starters.data.starters.map((starter) => (
                  <option key={starter.key} value={starter.key}>
                    {starter.title}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="consent-title">{t('consent:editor.titleLabel')}</Label>
            <Input
              id="consent-title"
              value={title}
              maxLength={160}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="consent-body">{t('consent:editor.bodyLabel')}</Label>
            <Textarea
              id="consent-body"
              value={body}
              rows={12}
              maxLength={20000}
              aria-describedby="consent-body-hint"
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
            <p id="consent-body-hint" className="text-sm text-muted-foreground">
              {t('consent:editor.bodyHint')}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="consent-specialty">{t('consent:editor.specialtyLabel')}</Label>
            <Select
              id="consent-specialty"
              value={specialty}
              onChange={(event) => {
                setSpecialty(event.target.value);
              }}
            >
              <option value="">{t('consent:specialty.none')}</option>
              {SPECIALTIES.map((key) => (
                <option key={key} value={key}>
                  {t(`consent:specialty.${key}`)}
                </option>
              ))}
            </Select>
          </div>
          <ErrorAlert error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              {published
                ? t('consent:editor.savePublish', { number: nextVersion })
                : t('consent:editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
