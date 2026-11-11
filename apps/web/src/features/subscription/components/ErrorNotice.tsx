import { useTranslation } from 'react-i18next';

import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';

/** What went wrong with an action, in words a person can act on. Nothing while there is no error. */
export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error === null || error === undefined) return null;
  return (
    <Alert tone="danger">
      <AlertDescription>{describeError(t, error).message}</AlertDescription>
    </Alert>
  );
}
