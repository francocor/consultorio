import type { z } from 'zod';

import { CLINICAL_TEMPLATE_KINDS, type ClinicalTemplateKind } from '../access.js';

import { validateWith, type ContentResult } from './common.js';
import { GeneralContent, GeneralDraft } from './general.js';
import { NutritionContent, NutritionDraft, computeBmi } from './nutrition.js';
import { OdontologyContent, OdontologyDraft } from './odontology.js';
import { PhysiotherapyContent, PhysiotherapyDraft } from './physiotherapy.js';
import { PsychologyContent, PsychologyDraft } from './psychology.js';

/**
 * One version of a clinical template: its fields (as two schemas), what is required to sign, and
 * the keywords that tie it to a professional's specialties. A note is bound to the exact version
 * used when it was created, so publishing version 2 later never changes what version 1 notes
 * mean: add a new entry for the new version and keep the old one in the registry.
 */
export interface ClinicalTemplate {
  kind: ClinicalTemplateKind;
  version: number;
  /** Translation key of the name shown to the professional (es-AR). */
  labelKey: string;
  /** Fields that must be present to sign, for the form to mark them. */
  requiredFields: readonly string[];
  /** Words (without accents, lower case) that mark a specialty as using this template. */
  specialtyKeywords: readonly string[];
  draft: z.ZodType;
  content: z.ZodType;
}

const template = (
  kind: ClinicalTemplateKind,
  version: number,
  parts: Pick<ClinicalTemplate, 'requiredFields' | 'specialtyKeywords' | 'draft' | 'content'>,
): ClinicalTemplate => ({ kind, version, labelKey: `clinical.template.${kind}`, ...parts });

export const CLINICAL_TEMPLATES: Record<ClinicalTemplateKind, readonly ClinicalTemplate[]> = {
  general: [
    template('general', 1, {
      requiredFields: ['reasonForConsultation'],
      specialtyKeywords: [],
      draft: GeneralDraft,
      content: GeneralContent,
    }),
  ],
  odontology: [
    template('odontology', 1, {
      requiredFields: ['reasonForConsultation'],
      specialtyKeywords: ['odont', 'dental', 'dentist'],
      draft: OdontologyDraft,
      content: OdontologyContent,
    }),
  ],
  psychology: [
    template('psychology', 1, {
      requiredFields: ['sessionDate', 'modality', 'risk'],
      specialtyKeywords: ['psicolog'],
      draft: PsychologyDraft,
      content: PsychologyContent,
    }),
  ],
  physiotherapy: [
    template('physiotherapy', 1, {
      requiredFields: ['painIntensity', 'affectedRegion', 'sessionNumber'],
      specialtyKeywords: ['kinesi', 'fisioter'],
      draft: PhysiotherapyDraft,
      content: PhysiotherapyContent,
    }),
  ],
  nutrition: [
    template('nutrition', 1, {
      requiredFields: ['weightKg', 'heightM'],
      specialtyKeywords: ['nutric'],
      draft: NutritionDraft,
      content: NutritionContent,
    }),
  ],
};

export function isTemplateKind(value: string): value is ClinicalTemplateKind {
  return CLINICAL_TEMPLATE_KINDS.some((kind) => kind === value);
}

/** The version of a template that new notes use. */
export function latestTemplate(kind: string): ClinicalTemplate | undefined {
  if (!isTemplateKind(kind)) return undefined;
  const versions = CLINICAL_TEMPLATES[kind];
  return versions.reduce<ClinicalTemplate | undefined>(
    (best, candidate) =>
      best === undefined || candidate.version > best.version ? candidate : best,
    undefined,
  );
}

/** An exact version, for rendering or validating an existing note. */
export function templateFor(kind: string, version: number): ClinicalTemplate | undefined {
  if (!isTemplateKind(kind)) return undefined;
  return CLINICAL_TEMPLATES[kind].find((candidate) => candidate.version === version);
}

const UNKNOWN_TEMPLATE: ContentResult = {
  ok: false,
  errors: [{ path: '(template)', i18nKey: 'clinical.template.unknown' }],
};

/** Validates a draft: partial content is fine, a wrong value is not. */
export function validateDraftContent(
  kind: string,
  version: number,
  content: unknown,
): ContentResult {
  const found = templateFor(kind, version);
  return found ? validateWith(found.draft, content) : UNKNOWN_TEMPLATE;
}

/** Validates the content to sign: required fields present and the rules of the whole note met. */
export function validateSignContent(
  kind: string,
  version: number,
  content: unknown,
): ContentResult {
  const found = templateFor(kind, version);
  return found ? validateWith(found.content, content) : UNKNOWN_TEMPLATE;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * The templates a professional is offered: the generic one plus those of every specialty they
 * practise (clinical-records, "Specialty templates"). A specialty with no template of its own
 * simply gets the generic one.
 */
export function templatesForSpecialties(specialties: readonly string[]): ClinicalTemplateKind[] {
  const normalized = specialties.map(normalize);
  return CLINICAL_TEMPLATE_KINDS.filter(
    (kind) =>
      kind === 'general' ||
      CLINICAL_TEMPLATES[kind].some((candidate) =>
        candidate.specialtyKeywords.some((keyword) =>
          normalized.some((specialty) => specialty.includes(keyword)),
        ),
      ),
  ).sort((a, b) => order(a) - order(b));
}

/** The order templates are listed in: general first, then the specialty ones. */
const LISTING: readonly ClinicalTemplateKind[] = [
  'general',
  'odontology',
  'psychology',
  'physiotherapy',
  'nutrition',
];
function order(kind: ClinicalTemplateKind): number {
  return LISTING.indexOf(kind);
}

/**
 * Fields the server computes from the content and shows with it. Never stored and never accepted
 * from a client: today only the body mass index of a nutrition visit.
 */
export function deriveContent(kind: string, content: unknown): Record<string, unknown> {
  if (kind !== 'nutrition' || typeof content !== 'object' || content === null) return {};
  const { weightKg, heightM } = content as { weightKg?: unknown; heightM?: unknown };
  return {
    bmi: computeBmi(
      typeof weightKg === 'number' ? weightKg : undefined,
      typeof heightM === 'number' ? heightM : undefined,
    ),
  };
}
