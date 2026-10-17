import {
  CLINICAL_TEMPLATE_KINDS,
  type ClinicalTemplateKind,
  type NoteDto,
} from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';

interface NewEncounterFormProps {
  patientId: string;
  /** Set when the encounter is opened from an appointment (scheduling links here). */
  appointmentId?: string | undefined;
  /** What the appointment says the visit is about; starts the reason of the note (D20). */
  prefillReason?: string | undefined;
  onOpened: (note: NoteDto) => void;
  onCancel?: () => void;
}

/** The templates whose first field is the reason for the consultation. */
const TEMPLATES_WITH_REASON: ReadonlySet<ClinicalTemplateKind> = new Set(['general', 'odontology']);

function asKind(value: string): ClinicalTemplateKind | undefined {
  return CLINICAL_TEMPLATE_KINDS.find((kind) => kind === value);
}

/**
 * Starts an encounter: the template (the ones the professional is offered, the generic one
 * first) and, if they want, the restriction of the note to themselves. It opens a draft and hands
 * it to the caller, which takes the professional to the editor.
 */
export function NewEncounterForm({
  patientId,
  appointmentId,
  prefillReason,
  onOpened,
  onCancel,
}: NewEncounterFormProps) {
  const { t } = useTranslation('clinical');
  const api = useApi();
  const [template, setTemplate] = useState<ClinicalTemplateKind>('general');
  const [restricted, setRestricted] = useState(false);

  const templates = useQuery({
    queryKey: clinicalKeys.templates,
    queryFn: () => clinicalApi(api).templates(),
    staleTime: 5 * 60_000,
  });

  const open = useMutation({
    mutationFn: async () => {
      const opened = await clinicalApi(api).open({
        patientId,
        templateKind: template,
        ...(appointmentId ? { appointmentId } : {}),
        ...(restricted ? { visibility: 'author_only' as const } : {}),
      });
      if (!prefillReason || !TEMPLATES_WITH_REASON.has(template)) return opened;
      try {
        // The first draft already carries the reason; the professional keeps editing from there.
        return await clinicalApi(api).saveDraft(opened.encounterId, {
          content: { reasonForConsultation: prefillReason },
          baseRevision: opened.draftRevision,
        });
      } catch {
        // The encounter is open either way: a prefill that could not be saved is only a convenience.
        return opened;
      }
    },
    onSuccess: onOpened,
  });

  if (templates.isPending) return <FormSkeleton fields={2} />;
  const offered = templates.data?.templates ?? [];

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        open.mutate();
      }}
    >
      {open.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, open.error).message}</AlertDescription>
        </Alert>
      ) : null}
      <RadioGroup
        value={template}
        onValueChange={(value) => {
          setTemplate(asKind(value) ?? 'general');
        }}
        aria-label={t('new.template')}
      >
        {(offered.length > 0 ? offered : [{ kind: 'general' as const, labelKey: '' }]).map(
          (option) => (
            <RadioCard key={option.kind} value={option.kind} title={t(`template.${option.kind}`)} />
          ),
        )}
      </RadioGroup>
      <CheckboxCard
        checked={restricted}
        onCheckedChange={setRestricted}
        title={t('new.restrict')}
        description={t('new.restrict.help')}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={open.isPending}>
          {t('new.start')}
        </Button>
        {onCancel ? (
          <Button variant="outline" onClick={onCancel}>
            {t('new.cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
