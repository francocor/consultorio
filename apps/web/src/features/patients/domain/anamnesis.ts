import {
  SAFETY_FLAG_CODES,
  type AnamnesisContent,
  type SafetyFlagCode,
} from '@consultorio/contracts';

type Severity = 'mild' | 'moderate' | 'severe';

/** What the anamnesis form holds: every field as the person typed it. */
export interface AnamnesisFormValues {
  allergies: { substance: string; reaction: string; severity: Severity | '' }[];
  medications: { name: string; dose: string; anticoagulant: boolean }[];
  conditions: { name: string; since: string }[];
  antecedents: string;
  pregnant: boolean;
  implantedDevice: boolean;
  anticoagulated: boolean;
}

export const EMPTY_ANAMNESIS_FORM: AnamnesisFormValues = {
  allergies: [],
  medications: [],
  conditions: [],
  antecedents: '',
  pregnant: false,
  implantedDevice: false,
  anticoagulated: false,
};

export function valuesFromAnamnesis(content: AnamnesisContent): AnamnesisFormValues {
  return {
    allergies: content.allergies.map((allergy) => ({
      substance: allergy.substance,
      reaction: allergy.reaction ?? '',
      severity: allergy.severity ?? '',
    })),
    medications: content.medications.map((medication) => ({
      name: medication.name,
      dose: medication.dose ?? '',
      anticoagulant: medication.anticoagulant === true,
    })),
    conditions: content.conditions.map((condition) => ({
      name: condition.name,
      since: condition.since ?? '',
    })),
    antecedents: content.antecedents,
    pregnant: content.indicators.pregnant,
    implantedDevice: content.indicators.implantedDevice,
    anticoagulated: content.indicators.anticoagulated,
  };
}

/** A row nobody filled in is not a record: it is dropped, and blank optional text is left out. */
export function toAnamnesisContent(values: AnamnesisFormValues): AnamnesisContent {
  const text = (value: string) => value.trim();
  return {
    allergies: values.allergies.flatMap((allergy) => {
      const substance = text(allergy.substance);
      if (substance === '') return [];
      const reaction = text(allergy.reaction);
      return [
        {
          substance,
          ...(reaction === '' ? {} : { reaction }),
          ...(allergy.severity === '' ? {} : { severity: allergy.severity }),
        },
      ];
    }),
    medications: values.medications.flatMap((medication) => {
      const name = text(medication.name);
      if (name === '') return [];
      const dose = text(medication.dose);
      return [
        {
          name,
          ...(dose === '' ? {} : { dose }),
          ...(medication.anticoagulant ? { anticoagulant: true } : {}),
        },
      ];
    }),
    conditions: values.conditions.flatMap((condition) => {
      const name = text(condition.name);
      if (name === '') return [];
      const since = text(condition.since);
      return [{ name, ...(since === '' ? {} : { since }) }];
    }),
    antecedents: text(values.antecedents),
    indicators: {
      pregnant: values.pregnant,
      implantedDevice: values.implantedDevice,
      anticoagulated: values.anticoagulated,
    },
  };
}

/**
 * The alerts the system will raise for this content. It mirrors the server rule so the professional
 * sees, before saving, what the rest of the team will be warned about; the server stays the one
 * that computes it, and nobody can set it by hand. Only structured fields count, never free text.
 */
export function deriveSafetyFlags(content: AnamnesisContent): SafetyFlagCode[] {
  const raised = new Set<SafetyFlagCode>();
  if (content.allergies.length > 0) raised.add('allergy_on_file');
  if (
    content.indicators.anticoagulated ||
    content.medications.some((medication) => medication.anticoagulant === true)
  ) {
    raised.add('anticoagulant_on_file');
  }
  if (content.indicators.pregnant) raised.add('pregnancy');
  if (content.indicators.implantedDevice) raised.add('implanted_device');
  return SAFETY_FLAG_CODES.filter((code) => raised.has(code));
}
