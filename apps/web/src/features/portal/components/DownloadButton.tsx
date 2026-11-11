import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Button } from '../../../shared/ui/button.js';
import { portalApi, type DownloadKind } from '../api/portal-api.js';

/**
 * Downloads one file. It asks for a link for THIS session (valid for five minutes, one use), follows
 * it at once and hands the file to the browser: the address of the link is never shown or kept, and
 * a failure says so in plain words next to the button. A file the server does not have (a document that
 * was never made, or one that is not the patient's any more) is "not found" and says exactly that,
 * so the button of a document that does not exist is a sentence and not a dead end.
 */
export function DownloadButton({
  kind,
  id,
  fileName,
  label,
}: {
  kind: DownloadKind;
  id: string;
  /** What to call the file when the server does not say. */
  fileName: string;
  /** The accessible name: it says which file, not just "download". */
  label: string;
}) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const download = useMutation({
    mutationFn: async () => {
      const link = await api.downloadLink(kind, id);
      const file = await api.file(link.url);
      downloadBlob(file.blob, file.filename ?? fileName);
    },
  });
  return (
    <div className="grid justify-items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        aria-label={label}
        loading={download.isPending}
        onClick={() => {
          download.mutate();
        }}
      >
        <Download aria-hidden="true" />
        {t('download.action')}
      </Button>
      {download.error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {isApiError(download.error) && download.error.status === 404
            ? t('download.unavailable')
            : describeError(t, download.error).message}
        </p>
      ) : null}
    </div>
  );
}
