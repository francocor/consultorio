import {
  RECIPIENT_TAX_CONDITIONS,
  type InvoiceType,
  type RecipientDocumentType,
  type RecipientTaxCondition,
} from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { needsCuit } from '../domain/invoice-display.js';

export interface RecipientState {
  taxCondition: RecipientTaxCondition;
  name: string;
  docType: RecipientDocumentType;
  docNumber: string;
}

export const EMPTY_RECIPIENT: RecipientState = {
  taxCondition: 'consumidor_final',
  name: '',
  docType: 'dni',
  docNumber: '',
};

/**
 * The part of the recipient that a person enters (e-invoicing-afip, "Recipient identification"):
 * the tax condition, a name to print, and the document. A Factura A needs the CUIT of the recipient;
 * for the other letters the document is optional below the threshold of the country (the server
 * decides and says what is missing). The payer of a charge is addressed with the CUIT the
 * organization already entered for it, so for a payer only the condition is asked.
 */
export function RecipientFields({
  idPrefix,
  kind,
  value,
  onChange,
  type,
}: {
  idPrefix: string;
  kind: 'patient' | 'payer';
  value: RecipientState;
  onChange: (next: RecipientState) => void;
  /** The voucher type the rules give for the condition chosen. */
  type: InvoiceType | undefined;
}) {
  const { t } = useTranslation('invoicing');
  const cuitRequired = needsCuit(type);
  const docType: RecipientDocumentType = cuitRequired ? 'cuit' : value.docType;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-condition`}>{t('recipient.condition')}</Label>
        <Select
          id={`${idPrefix}-condition`}
          value={value.taxCondition}
          onChange={(event) => {
            onChange({ ...value, taxCondition: event.target.value as RecipientTaxCondition });
          }}
        >
          {RECIPIENT_TAX_CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>
              {t(`recipient.conditions.${condition}`)}
            </option>
          ))}
        </Select>
      </div>

      {kind === 'patient' ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>{t('recipient.name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              value={value.name}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => {
                onChange({ ...value, name: event.target.value });
              }}
            />
            <p className="text-sm text-muted-foreground">{t('recipient.nameHelp')}</p>
          </div>

          <div className="grid grid-cols-[8rem_1fr] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-doc-type`}>{t('recipient.docType')}</Label>
              <Select
                id={`${idPrefix}-doc-type`}
                value={docType}
                disabled={cuitRequired}
                onChange={(event) => {
                  onChange({ ...value, docType: event.target.value as RecipientDocumentType });
                }}
              >
                <option value="dni">{t('recipient.dni')}</option>
                <option value="cuit">{t('recipient.cuit')}</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-doc-number`}>
                {cuitRequired ? t('recipient.cuitRequired') : t('recipient.docNumber')}
              </Label>
              <Input
                id={`${idPrefix}-doc-number`}
                value={value.docNumber}
                inputMode="numeric"
                maxLength={20}
                autoComplete="off"
                aria-required={cuitRequired}
                onChange={(event) => {
                  onChange({ ...value, docNumber: event.target.value });
                }}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
