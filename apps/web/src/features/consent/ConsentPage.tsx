import type { ConsentTemplateDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSignature, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi, useAppStatus } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { formatDateTime } from '../../shared/lib/format.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../shared/ui/badge.js';
import { Button } from '../../shared/ui/button.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { consentApi, consentKeys } from './api/consent-api.js';
import { ErrorAlert } from './components/ErrorAlert.js';
import { RequirementsSection } from './components/RequirementsSection.js';
import { TemplateEditorDialog } from './components/TemplateEditorDialog.js';
import { VersionsDialog } from './components/VersionsDialog.js';
import { isSpecialty } from './domain/specialties.js';

const STATUS_TONE: Record<ConsentTemplateDto['status'], BadgeTone> = {
  draft: 'warning',
  published: 'success',
  retired: 'neutral',
};

type Dialogue =
  | { kind: 'editor'; template?: ConsentTemplateDto }
  | { kind: 'versions'; template: ConsentTemplateDto }
  | { kind: 'retire'; template: ConsentTemplateDto };

/**
 * The template manager (informed-consent, "Consent template authoring" and "Template versioning"):
 * drafts, published templates with their versions, and retired ones, plus the consent each type of
 * appointment requires. For who holds `consent.template.manage` (owner, admin, professional);
 * reception gets the "no access" screen from the route guard. These screens are not linked to a
 * patient, so the titles are shown.
 */
export function ConsentPage() {
  const { t } = useTranslation(['consent', 'common']);
  usePageTitle(t('consent:title'));
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const queryClient = useQueryClient();
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const [open, setOpen] = useState<Dialogue | null>(null);

  const list = useQuery({
    queryKey: consentKeys.templates,
    queryFn: () => consentApi(api).templates(),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: consentKeys.templates });
    await queryClient.invalidateQueries({ queryKey: consentKeys.offered });
  };

  const publish = useMutation({
    mutationFn: (id: string) => consentApi(api).publishTemplate(id),
    onSuccess: async (detail) => {
      toast.success(
        t('consent:publish.done', { number: detail.template.latestVersionNumber ?? 1 }),
      );
      await refresh();
    },
  });

  const retire = useMutation({
    mutationFn: (id: string) => consentApi(api).retireTemplate(id),
    onSuccess: async () => {
      toast.success(t('consent:retire.done'));
      setOpen(null);
      await refresh();
    },
  });

  const newButton = (
    <Button
      type="button"
      disabled={readOnly}
      onClick={() => {
        setOpen({ kind: 'editor' });
      }}
    >
      <Plus aria-hidden="true" />
      {t('consent:templates.new')}
    </Button>
  );

  return (
    <div className="grid gap-8">
      <PageHeader
        title={t('consent:title')}
        description={t('consent:description')}
        actions={newButton}
      />
      {readOnly ? (
        <Alert tone="info">
          <AlertDescription>{t('common:state.readOnly.disabledReason')}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="consent-templates" className="grid gap-3">
        <h2 id="consent-templates" className="font-display text-lg font-semibold">
          {t('consent:templates.heading')}
        </h2>
        {list.isPending ? <ListSkeleton rows={3} /> : null}
        {list.isError ? (
          <ErrorState
            error={list.error}
            onRetry={() => {
              void list.refetch();
            }}
          />
        ) : null}
        {list.isSuccess && list.data.templates.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title={t('consent:templates.empty.title')}
            description={t('consent:templates.empty.description')}
            action={newButton}
          />
        ) : null}
        {list.isSuccess && list.data.templates.length > 0 ? (
          <ul aria-label={t('consent:templates.listLabel')} className="grid gap-2">
            {list.data.templates.map((template) => (
              <li
                key={template.id}
                className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-[1fr_auto]"
              >
                <div className="min-w-0 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span>{template.title}</span>
                    <Badge tone={STATUS_TONE[template.status]}>
                      {t(`consent:templateStatus.${template.status}`)}
                    </Badge>
                  </p>
                  <p className="text-muted-foreground">
                    {template.latestVersionNumber === null
                      ? t('consent:templates.neverPublished')
                      : t('consent:templates.version', { number: template.latestVersionNumber })}
                    {isSpecialty(template.specialty)
                      ? ` · ${t(`consent:specialty.${template.specialty}`)}`
                      : ''}
                    {' · '}
                    {template.retiredAt
                      ? t('consent:templates.retiredAt', {
                          date: formatDateTime(template.retiredAt),
                        })
                      : t('consent:templates.updatedAt', {
                          date: formatDateTime(template.updatedAt),
                        })}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                  {template.status !== 'retired' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={readOnly}
                      onClick={() => {
                        setOpen({ kind: 'editor', template });
                      }}
                    >
                      {t('consent:action.edit')}
                    </Button>
                  ) : null}
                  {template.status === 'draft' ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={readOnly}
                      loading={publish.isPending && publish.variables === template.id}
                      onClick={() => {
                        publish.mutate(template.id);
                      }}
                    >
                      {t('consent:action.publish')}
                    </Button>
                  ) : null}
                  {template.versionCount > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpen({ kind: 'versions', template });
                      }}
                    >
                      {t('consent:action.versions')}
                    </Button>
                  ) : null}
                  {template.status !== 'retired' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={readOnly}
                      onClick={() => {
                        setOpen({ kind: 'retire', template });
                      }}
                    >
                      {t('consent:action.retire')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <ErrorAlert error={publish.error} />
      </section>

      <RequirementsSection />

      {open?.kind === 'editor' ? (
        <TemplateEditorDialog
          {...(open.template ? { template: open.template } : {})}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open?.kind === 'versions' ? (
        <VersionsDialog
          templateId={open.template.id}
          title={open.template.title}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open?.kind === 'retire' ? (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('consent:retire.title', { title: open.template.title })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('consent:retire.description')}</AlertDialogDescription>
            </AlertDialogHeader>
            <ErrorAlert error={retire.error} />
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  // The dialog stays open while the request runs, and shows what went wrong.
                  event.preventDefault();
                  if (!retire.isPending) retire.mutate(open.template.id);
                }}
              >
                {t('consent:retire.submit')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
