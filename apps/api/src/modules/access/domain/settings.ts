import {
  CLINICAL_TEMPLATE_KINDS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_SHARED_TEMPLATES,
  QuietHours,
  type ClinicalTemplateKind,
  type SettingsDto,
  type UpdateSettingsRequest,
} from '@consultorio/contracts';

/** The settings as `tenant.settings` stores them (the keys other code already reads). */
export type StoredSettings = Record<string, unknown>;

export type SettingsEvent =
  | { kind: 'reception_metadata'; enabled: boolean }
  | {
      kind: 'sharing';
      clinicalSharing: boolean;
      added: ClinicalTemplateKind[];
      removed: ClinicalTemplateKind[];
    }
  | { kind: 'require_2fa'; enabled: boolean }
  | { kind: 'quiet_hours'; start: string; end: string };

export type SettingsPlan =
  | { ok: true; stored: StoredSettings; events: SettingsEvent[] }
  | { ok: false; path: string; i18nKey: string };

function isTemplate(value: unknown): value is ClinicalTemplateKind {
  return CLINICAL_TEMPLATE_KINDS.some((kind) => kind === value);
}

/**
 * Reads the stored settings. A value of the wrong type counts as the safe default (off, empty),
 * never as "on": a damaged setting cannot open anything.
 */
export function readSettings(stored: StoredSettings): SettingsDto {
  const templates = stored['sharedTemplates'];
  const quiet = QuietHours.safeParse(stored['quiet_hours']);
  return {
    receptionSeesClinicalMetadata: stored['reception_sees_clinical_metadata'] === true,
    clinicalSharing: stored['clinicalSharing'] === true,
    sharedTemplates: Array.isArray(templates) ? templates.filter(isTemplate) : [],
    require2fa: stored['require_2fa'] === true,
    quietHours: quiet.success ? quiet.data : DEFAULT_QUIET_HOURS,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * Turns a partial update into what to store and what to audit (authorization, "One clinical
 * visibility model" and "Organization setting 'reception sees clinical metadata'").
 *
 * - Sharing enabled for the first time seeds the shared scope with every template except
 *   psychology. A template added to the product later is never added here.
 * - Adding psychology to the scope needs `confirmPsychologySharing`: an explicit choice.
 * - A value that did not change produces no event, so the audit trail only records real changes.
 */
export function planSettingsUpdate(
  current: SettingsDto,
  patch: UpdateSettingsRequest,
): SettingsPlan {
  const stored: StoredSettings = {};
  const events: SettingsEvent[] = [];

  if (
    patch.receptionSeesClinicalMetadata !== undefined &&
    patch.receptionSeesClinicalMetadata !== current.receptionSeesClinicalMetadata
  ) {
    stored['reception_sees_clinical_metadata'] = patch.receptionSeesClinicalMetadata;
    events.push({ kind: 'reception_metadata', enabled: patch.receptionSeesClinicalMetadata });
  }

  const sharing = patch.clinicalSharing ?? current.clinicalSharing;
  const firstEnable =
    patch.clinicalSharing === true &&
    !current.clinicalSharing &&
    current.sharedTemplates.length === 0 &&
    patch.sharedTemplates === undefined;
  const templates: readonly ClinicalTemplateKind[] = firstEnable
    ? DEFAULT_SHARED_TEMPLATES
    : (patch.sharedTemplates ?? current.sharedTemplates);

  const added = templates.filter((kind) => !current.sharedTemplates.includes(kind));
  const removed = current.sharedTemplates.filter((kind) => !templates.includes(kind));
  if (added.includes('psychology') && patch.confirmPsychologySharing !== true) {
    return {
      ok: false,
      path: 'sharedTemplates',
      i18nKey: 'settings.psychology_confirmation_required',
    };
  }

  const sharingChanged =
    sharing !== current.clinicalSharing || !sameSet(templates, current.sharedTemplates);
  if (sharingChanged) {
    if (sharing !== current.clinicalSharing) stored['clinicalSharing'] = sharing;
    if (!sameSet(templates, current.sharedTemplates)) stored['sharedTemplates'] = [...templates];
    events.push({ kind: 'sharing', clinicalSharing: sharing, added, removed });
  }

  if (patch.require2fa !== undefined && patch.require2fa !== current.require2fa) {
    stored['require_2fa'] = patch.require2fa;
    events.push({ kind: 'require_2fa', enabled: patch.require2fa });
  }

  if (
    patch.quietHours &&
    (patch.quietHours.start !== current.quietHours.start ||
      patch.quietHours.end !== current.quietHours.end)
  ) {
    stored['quiet_hours'] = patch.quietHours;
    events.push({ kind: 'quiet_hours', start: patch.quietHours.start, end: patch.quietHours.end });
  }

  return { ok: true, stored, events };
}
