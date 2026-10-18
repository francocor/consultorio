import { isDeepStrictEqual } from 'node:util';

import {
  CLINICAL_TEMPLATE_KINDS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_SHARED_TEMPLATES,
  QuietHours,
  SettingsDto as SettingsDtoSchema,
  type AuditAction,
  type ClinicalTemplateKind,
  type SettingsDto,
  type SettingsSectionKey,
  type UpdateSettingsRequest,
} from '@consultorio/contracts';

import type { SettingsSection } from '../../../platform/settings-sections.js';

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
  | { kind: 'quiet_hours'; start: string; end: string }
  | {
      /** A section a capability module owns (notifications, online booking, ...). */
      kind: 'section';
      section: SettingsSectionKey;
      /** Names only: the values stay out of the audit trail. */
      changedFields: string[];
      /** A changed field that has an audit action of its own. */
      fieldAudits: { action: AuditAction; field: string; enabled?: boolean }[];
    };

export type SettingsPlan =
  | { ok: true; stored: StoredSettings; events: SettingsEvent[] }
  | { ok: false; path: string; i18nKey: string };

function isTemplate(value: unknown): value is ClinicalTemplateKind {
  return CLINICAL_TEMPLATE_KINDS.some((kind) => kind === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One section as stored: its defaults with what the organization set on top. A section that does
 * not satisfy its schema as a whole counts as its defaults, never as something half valid.
 */
function readSection(stored: unknown, section: SettingsSection): Record<string, unknown> {
  if (!isRecord(stored)) return { ...section.defaults };
  const merged = { ...section.defaults, ...stored };
  const parsed = section.schema.safeParse(merged);
  return parsed.success ? parsed.data : { ...section.defaults };
}

/**
 * Reads the stored settings. A value of the wrong type counts as the safe default (off, empty),
 * never as "on": a damaged setting cannot open anything. Every section the modules registered is
 * read from its own key; the response schema rejects a result that lacks a section, so a module
 * that forgot to register one fails loudly instead of silently dropping it.
 */
export function readSettings(
  stored: StoredSettings,
  sections: readonly SettingsSection[],
): SettingsDto {
  const templates = stored['sharedTemplates'];
  const quiet = QuietHours.safeParse(stored['quiet_hours']);
  return SettingsDtoSchema.parse({
    receptionSeesClinicalMetadata: stored['reception_sees_clinical_metadata'] === true,
    clinicalSharing: stored['clinicalSharing'] === true,
    sharedTemplates: Array.isArray(templates) ? templates.filter(isTemplate) : [],
    require2fa: stored['require_2fa'] === true,
    quietHours: quiet.success ? quiet.data : DEFAULT_QUIET_HOURS,
    ...Object.fromEntries(
      sections.map((section) => [section.key, readSection(stored[section.key], section)]),
    ),
  });
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
  sections: readonly SettingsSection[],
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

  for (const section of sections) {
    const change = patch[section.key];
    if (change === undefined) continue;
    const before: Record<string, unknown> = current[section.key];
    const merged: Record<string, unknown> = { ...before, ...change };
    const parsed = section.schema.safeParse(merged);
    if (!parsed.success) {
      return { ok: false, path: section.key, i18nKey: 'settings.section_value_invalid' };
    }
    const changedFields = Object.keys(change).filter(
      (field) => !isDeepStrictEqual(parsed.data[field], before[field]),
    );
    if (changedFields.length === 0) continue;
    stored[section.key] = parsed.data;
    events.push({
      kind: 'section',
      section: section.key,
      changedFields,
      fieldAudits: changedFields.flatMap((field) => {
        const action = section.fieldAudits?.[field];
        if (action === undefined) return [];
        const value = parsed.data[field];
        return [{ action, field, ...(typeof value === 'boolean' ? { enabled: value } : {}) }];
      }),
    });
  }

  return { ok: true, stored, events };
}
