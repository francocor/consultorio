import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../../shared/ui/dialog.js';
import { QrCode } from '../../../../shared/ui/qr-code.js';

/** The QR code of a link, drawn in the browser, with the address in words under it. */
export function QrDialog({
  name,
  address,
  onClose,
}: {
  name: string;
  address: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('bookingAdmin');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('qr.title', { name })}</DialogTitle>
          <DialogDescription>{t('qr.help')}</DialogDescription>
        </DialogHeader>
        <div className="grid justify-items-center gap-3">
          <QrCode value={address} alt={t('qr.alt', { name })} />
          <p className="break-all text-center text-sm text-muted-foreground">{address}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
