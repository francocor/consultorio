import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi, useAppStatus } from '../../../app/providers.js';
import { useMe } from '../../../app/session.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { consentApi, consentKeys } from '../api/consent-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * The consent each type of appointment requires. When a type requires one, an appointment of that
 * type shows a warning until the patient holds a valid, not revoked consent of that template
 * (informed-consent, "Revocation": a revoked consent is not valid for a later procedure).
 */
export function RequirementsSection() {
  const { t } = useTranslation('consent');
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const queryClient = useQueryClient();
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';

  const requirements = useQuery({
    queryKey: consentKeys.requirements,
    queryFn: () => consentApi(api).requirements(),
  });
  const templates = useQuery({
    queryKey: consentKeys.templates,
    queryFn: () => consentApi(api).templates(),
  });

  const set = useMutation({
    mutationFn: (input: { appointmentTypeId: string; templateId: string | null }) =>
      consentApi(api).setRequirement(input.appointmentTypeId, { templateId: input.templateId }),
    onSuccess: async () => {
      toast.success(t('requirements.saved'));
      await queryClient.invalidateQueries({ queryKey: consentKeys.requirements });
    },
  });

  const live = (templates.data?.templates ?? []).filter(
    (template) => template.status === 'published',
  );

  return (
    <section aria-labelledby="consent-requirements" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="consent-requirements" className="font-display text-lg font-semibold">
          {t('requirements.title')}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('requirements.description')}</p>
      </div>
      {requirements.isPending || templates.isPending ? <ListSkeleton rows={2} /> : null}
      {requirements.isError ? (
        <ErrorState
          error={requirements.error}
          onRetry={() => {
            void requirements.refetch();
          }}
        />
      ) : null}
      {requirements.isSuccess && requirements.data.requirements.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('requirements.empty')}</p>
      ) : null}
      {requirements.isSuccess && requirements.data.requirements.length > 0 ? (
        <ul aria-label={t('requirements.listLabel')} className="grid gap-2">
          {requirements.data.requirements.map((entry) => {
            const id = `requirement-${entry.appointmentTypeId}`;
            return (
              <li
                key={entry.appointmentTypeId}
                className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-[1fr_minmax(0,18rem)] sm:items-center"
              >
                <Label htmlFor={id}>{entry.appointmentTypeName}</Label>
                <Select
                  id={id}
                  value={entry.templateId ?? ''}
                  disabled={readOnly || set.isPending}
                  onChange={(event) => {
                    set.mutate({
                      appointmentTypeId: entry.appointmentTypeId,
                      templateId: event.target.value === '' ? null : event.target.value,
                    });
                  }}
                >
                  <option value="">{t('requirements.none')}</option>
                  {live.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.title}
                    </option>
                  ))}
                </Select>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ErrorAlert error={set.error} />
    </section>
  );
}
