import type { DocumentDto } from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileText, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import { Label } from '../../../shared/ui/label.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { Section } from '../../patients/components/Section.js';
import { documentKeys, documentsApi } from '../api/documents-api.js';

import { DocumentRow } from './DocumentRow.js';
import { HideDialog } from './HideDialog.js';
import { UploadDialog } from './UploadDialog.js';
import { VersionsDialog } from './VersionsDialog.js';

/** How often the list refreshes while a file is still being scanned. */
const SCAN_REFRESH_MS = 4000;

export interface DocumentsTabProps {
  patientId: string;
  /** Holds `patients.write`: may upload administrative documents, and hide or replace them. */
  canWrite: boolean;
  /** Holds `clinical.document.write`: may also handle clinical ones. */
  canWriteClinical: boolean;
  /** Holds `clinical.document.read`: may download clinical documents. */
  canReadClinical: boolean;
}

/**
 * The documents of a patient. The server decides which ones this person sees: a clinical document
 * is simply not in the list for someone who may not read it, and reception sees only its name and
 * category when the organization allows it. This screen shows what it is given and offers only the
 * actions the person is allowed to try.
 */
export function DocumentsTab({
  patientId,
  canWrite,
  canWriteClinical,
  canReadClinical,
}: DocumentsTabProps) {
  const { t } = useTranslation(['documents', 'common']);
  const api = useApi();
  const [showHidden, setShowHidden] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replacing, setReplacing] = useState<DocumentDto | undefined>();
  const [hiding, setHiding] = useState<DocumentDto | null>(null);
  const [versionsOf, setVersionsOf] = useState<DocumentDto | null>(null);

  const documents = useQuery({
    queryKey: documentKeys.list(patientId, showHidden),
    queryFn: () => documentsApi(api).list(patientId, showHidden),
    // A file being scanned turns "Analizando" into "Disponible" by itself, within a few seconds.
    refetchInterval: (query) =>
      query.state.data?.documents.some((entry) => entry.status === 'quarantined')
        ? SCAN_REFRESH_MS
        : false,
  });

  const download = useMutation({
    mutationFn: async (target: DocumentDto) => {
      const file = await documentsApi(api).download(target.id);
      downloadBlob(file.blob, target.name);
    },
    onSuccess: () => {
      toast.success(t('documents:download.started'));
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  const mayDownload = (entry: DocumentDto) =>
    entry.classification === 'clinical' ? canReadClinical : true;
  const mayManage = (entry: DocumentDto) =>
    entry.classification === 'clinical' ? canWriteClinical : canWrite;

  const uploadButton = canWrite ? (
    <Button
      onClick={() => {
        setReplacing(undefined);
        setUploading(true);
      }}
    >
      <Upload aria-hidden="true" />
      {t('documents:upload')}
    </Button>
  ) : null;

  // The dialogs always come after the body, as the second child of one fragment: whichever body is
  // shown (empty state or list), React keeps them mounted, so an upload in progress, and the summary
  // of the one that just finished, survive the list changing under them.
  const dialogs = (
    <>
      <UploadDialog
        key={replacing?.id ?? 'new'}
        patientId={patientId}
        open={uploading}
        onOpenChange={setUploading}
        canUploadClinical={canWriteClinical}
        replacing={replacing}
      />
      <HideDialog
        document={hiding}
        onOpenChange={(open) => {
          if (!open) setHiding(null);
        }}
      />
      <VersionsDialog
        document={versionsOf}
        canDownload={true}
        onOpenChange={(open) => {
          if (!open) setVersionsOf(null);
        }}
      />
    </>
  );

  function listOf(entries: readonly DocumentDto[]): ReactNode {
    const hiddenToggle = (
      <div className="flex items-center gap-2">
        <Checkbox
          id="documents-show-hidden"
          checked={showHidden}
          onCheckedChange={(checked) => {
            setShowHidden(checked === true);
          }}
        />
        <Label htmlFor="documents-show-hidden">{t('documents:showHidden')}</Label>
      </div>
    );

    if (entries.length === 0 && !showHidden) {
      return (
        <>
          <EmptyState
            icon={FileText}
            title={t('documents:empty.title')}
            description={t('documents:empty.description')}
            action={uploadButton}
          />
          <div className="mt-4">{hiddenToggle}</div>
        </>
      );
    }

    return (
      <Section
        title={t('documents:title')}
        description={t('documents:description')}
        action={uploadButton}
      >
        <div className="grid gap-4">
          {hiddenToggle}
          {showHidden ? (
            <p className="text-sm text-muted-foreground">{t('documents:hiddenListHint')}</p>
          ) : null}
          <ul className="grid gap-3" aria-label={t('documents:list.label')}>
            {entries.map((entry) => (
              <DocumentRow
                key={entry.id}
                document={entry}
                canDownload={mayDownload(entry)}
                canManage={mayManage(entry)}
                downloading={download.isPending && download.variables.id === entry.id}
                onDownload={(target) => {
                  download.mutate(target);
                }}
                onHide={setHiding}
                onReplace={(target) => {
                  setReplacing(target);
                  setUploading(true);
                }}
                onVersions={setVersionsOf}
              />
            ))}
          </ul>
        </div>
      </Section>
    );
  }

  let body: ReactNode;
  if (documents.isPending) {
    body = <ListSkeleton rows={3} />;
  } else if (documents.isError) {
    body = (
      <ErrorState
        error={documents.error}
        onRetry={() => {
          void documents.refetch();
        }}
      />
    );
  } else {
    body = listOf(documents.data.documents);
  }
  return (
    <>
      {body}
      {dialogs}
    </>
  );
}
