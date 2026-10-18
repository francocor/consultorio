import { TAX_CONDITIONS, type FiscalProfileDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import {
  EMPTY_PROFILE,
  missingProfileFields,
  profileRequest,
  sameProfile,
  type ProfileDraft,
  type ProfileField,
} from '../domain/forms.js';

import { isFieldFailure, serverFieldMessage } from './field-errors.js';

function draftOf(profile: FiscalProfileDto | null): ProfileDraft {
  return profile
    ? {
        cuit: profile.cuit,
        taxCondition: profile.taxCondition,
        businessName: profile.businessName,
        address: profile.address,
        activityStartedOn: profile.activityStartedOn,
      }
    : EMPTY_PROFILE;
}

/** The fiscal identity of the organization (CUIT, tax condition, name, address, start of activities). */
export function ProfileSection({ profile }: { profile: FiscalProfileDto | null }) {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const queryClient = useQueryClient();
  const saved = draftOf(profile);
  const [draft, setDraft] = useState<ProfileDraft>(saved);
  const [attempted, setAttempted] = useState(false);

  const save = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof profileRequest>>) =>
      invoicingApi(api).saveProfile(body),
    onSuccess: async () => {
      toast.success(t('profile.saved'));
      setAttempted(false);
      await queryClient.invalidateQueries({ queryKey: invoicingKeys.config });
    },
  });

  const missing = attempted ? missingProfileFields(draft) : [];
  const dirty = !sameProfile(draft, saved);

  const change = (field: ProfileField, value: string) => {
    setDraft({ ...draft, [field]: value });
  };

  const submit = () => {
    setAttempted(true);
    const body = profileRequest(draft);
    if (body) save.mutate(body);
  };

  /** The message under a field: the one the server gave, or "required". */
  const errorOf = (field: ProfileField): string | null =>
    serverFieldMessage(save.error, field, t) ??
    (missing.includes(field) ? t('profile.error.required') : null);

  const field = (
    name: ProfileField,
    label: string,
    control: (props: ControlProps) => ReactNode,
    help?: string,
  ) => {
    const id = `profile-${name}`;
    const error = errorOf(name);
    const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ');
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {control({
          id,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': describedBy || undefined,
        })}
        {help ? (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <section aria-labelledby="profile-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="grid gap-0.5">
        <h3 id="profile-title" className="font-medium">
          {t('profile.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('profile.description')}</p>
      </div>

      {save.isError && !isFieldFailure(save.error) ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <form
        className="grid gap-3 sm:max-w-xl"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {field(
          'cuit',
          t('profile.cuit'),
          (props) => (
            <Input
              {...props}
              inputMode="numeric"
              autoComplete="off"
              value={draft.cuit}
              onChange={(event) => {
                change('cuit', event.target.value);
              }}
            />
          ),
          t('profile.cuitHelp'),
        )}
        {field('taxCondition', t('profile.taxCondition'), (props) => (
          <Select
            {...props}
            value={draft.taxCondition}
            onChange={(event) => {
              change('taxCondition', event.target.value);
            }}
          >
            <option value="" disabled>
              {t('profile.taxConditionPlaceholder')}
            </option>
            {TAX_CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {t(`profile.taxCondition.${condition}`)}
              </option>
            ))}
          </Select>
        ))}
        {field('businessName', t('profile.businessName'), (props) => (
          <Input
            {...props}
            autoComplete="organization"
            value={draft.businessName}
            onChange={(event) => {
              change('businessName', event.target.value);
            }}
          />
        ))}
        {field('address', t('profile.address'), (props) => (
          <Input
            {...props}
            autoComplete="street-address"
            value={draft.address}
            onChange={(event) => {
              change('address', event.target.value);
            }}
          />
        ))}
        {field('activityStartedOn', t('profile.activityStartedOn'), (props) => (
          <Input
            {...props}
            type="date"
            value={draft.activityStartedOn}
            onChange={(event) => {
              change('activityStartedOn', event.target.value);
            }}
          />
        ))}
        <div>
          <Button type="submit" disabled={!dirty} loading={save.isPending}>
            {save.isPending ? t('profile.saving') : t('profile.save')}
          </Button>
        </div>
      </form>
    </section>
  );
}

interface ControlProps {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
}
