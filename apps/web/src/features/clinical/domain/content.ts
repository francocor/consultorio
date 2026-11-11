import type { ClinicalTemplateKind, FieldIssue } from '@consultorio/contracts';

/**
 * The content of a note as the screens handle it. A form holds what the person typed (strings,
 * blank rows, empty lists); the API wants only what means something. These pure helpers do that
 * translation in one place, so the draft that is saved and the content that is validated are the
 * same thing for every template.
 */

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function clean(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(clean).filter((item) => !isBlank(item));
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, clean(item)] as const)
      .filter(([, item]) => !isBlank(item));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * The content to send: text trimmed, blank text, missing numbers, empty lists and empty objects
 * left out at every depth. Numbers (including 0) and booleans are kept exactly.
 */
export function cleanContent(values: unknown): Record<string, unknown> {
  const cleaned = clean(values);
  return typeof cleaned === 'object' && cleaned !== null && !Array.isArray(cleaned)
    ? (cleaned as Record<string, unknown>)
    : {};
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

/** A text that is the same for the same content: to know whether anything changed since a save. */
export function contentKey(values: unknown): string {
  return JSON.stringify(sorted(cleanContent(values)));
}

/** A number field's raw text as a number: empty or not a number is "nothing"; a comma is a point. */
export function numberFromInput(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Field errors by path, for a screen that looks one up while it renders a field. */
export function issueMap(issues: readonly FieldIssue[]): Record<string, string> {
  return Object.fromEntries(issues.map((issue) => [issue.path, issue.i18nKey]));
}

const FIELDS: Record<ClinicalTemplateKind, readonly string[]> = {
  general: [
    'reasonForConsultation',
    'symptoms',
    'measurements',
    'diagnosis',
    'plan',
    'medications',
  ],
  odontology: ['reasonForConsultation', 'odontogram', 'notes', 'treatmentPlan'],
  psychology: ['sessionDate', 'modality', 'topics', 'observations', 'risk', 'followUpNote', 'plan'],
  physiotherapy: [
    'painIntensity',
    'affectedRegion',
    'rangeOfMotion',
    'functionalTests',
    'procedures',
    'sessionNumber',
    'totalSessions',
    'goals',
  ],
  nutrition: [
    'weightKg',
    'heightM',
    'waistCm',
    'dietaryHabits',
    'allergiesIntolerances',
    'goals',
    'mealPlan',
  ],
};

/** The fields of a template in reading order. */
export function fieldsOf(kind: ClinicalTemplateKind): readonly string[] {
  return FIELDS[kind];
}
