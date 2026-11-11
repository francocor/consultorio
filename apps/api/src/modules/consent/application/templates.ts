import type {
  ConsentStartersResponse,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  ConsentTemplateListResponse,
  ConsentTemplateVersionDto,
  CreateConsentTemplateRequest,
  OfferedConsentTemplatesResponse,
  UpdateConsentTemplateRequest,
} from '@consultorio/contracts';
import { desc, eq, inArray, sql } from 'drizzle-orm';

import {
  consentTemplate,
  consentTemplateVersion,
  type ConsentTemplateRow,
  type ConsentTemplateVersionRow,
} from '../../../db/schema/consent.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { CONSENT_STARTERS, findStarter } from '../assets/starters/es-AR.js';
import { templateFingerprint } from '../domain/fingerprint.js';

type Auditor = AuditActor & { userId: string };

export interface TemplateService {
  /** Every template of the organization, newest first. */
  list(tx: Tx): Promise<ConsentTemplateListResponse>;
  /** One template with its published versions, newest first. */
  detail(tx: Tx, templateId: string): Promise<ConsentTemplateDetailResponse>;
  /** A new draft. */
  create(
    tx: Tx,
    input: { actor: Auditor; request: CreateConsentTemplateRequest },
  ): Promise<ConsentTemplateDto>;
  /**
   * Changes a template. A draft changes in place; on a published template a new title or text
   * publishes the next version at once, and the versions already published stay as they were.
   */
  update(
    tx: Tx,
    input: { actor: Auditor; templateId: string; request: UpdateConsentTemplateRequest },
  ): Promise<ConsentTemplateDetailResponse>;
  /** Publishes a draft as version 1. */
  publish(
    tx: Tx,
    input: { actor: Auditor; templateId: string },
  ): Promise<ConsentTemplateDetailResponse>;
  /** Stops offering the template for new signatures. Its versions and signed consents stay. */
  retire(
    tx: Tx,
    input: { actor: Auditor; templateId: string },
  ): Promise<ConsentTemplateDetailResponse>;
  /** The latest published version of each live template: what can be requested from a patient. */
  offered(tx: Tx): Promise<OfferedConsentTemplatesResponse>;
  starters(): ConsentStartersResponse;
}

const tenantId = sql`current_setting('app.tenant_id')::uuid`;

interface VersionStats {
  latest: number | null;
  count: number;
}

function toTemplateDto(row: ConsentTemplateRow, stats: VersionStats): ConsentTemplateDto {
  return {
    id: row.id,
    title: row.title,
    body: row.draftBody,
    status: row.status as ConsentTemplateDto['status'],
    specialty: row.specialty,
    appointmentTypeId: row.appointmentTypeId,
    starterKey: row.starterKey,
    latestVersionNumber: stats.latest,
    versionCount: stats.count,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

function toVersionDto(row: ConsentTemplateVersionRow, latest: number): ConsentTemplateVersionDto {
  return {
    id: row.id,
    templateId: row.templateId,
    number: row.versionNumber,
    title: row.title,
    body: row.body,
    contentHash: row.contentHash,
    publishedAt: row.publishedAt.toISOString(),
    latest: row.versionNumber === latest,
  };
}

/** Versions of the given templates, newest first. */
async function versionsOf(
  tx: Tx,
  templateIds: readonly string[],
): Promise<Map<string, ConsentTemplateVersionRow[]>> {
  const byTemplate = new Map<string, ConsentTemplateVersionRow[]>();
  if (templateIds.length === 0) return byTemplate;
  const rows = await tx
    .select()
    .from(consentTemplateVersion)
    .where(inArray(consentTemplateVersion.templateId, [...templateIds]))
    .orderBy(desc(consentTemplateVersion.versionNumber));
  for (const row of rows) {
    byTemplate.set(row.templateId, [...(byTemplate.get(row.templateId) ?? []), row]);
  }
  return byTemplate;
}

function statsOf(versions: readonly ConsentTemplateVersionRow[] | undefined): VersionStats {
  const list = versions ?? [];
  return { latest: list[0]?.versionNumber ?? null, count: list.length };
}

async function lockTemplate(tx: Tx, templateId: string): Promise<ConsentTemplateRow> {
  const [row] = await tx
    .select()
    .from(consentTemplate)
    .where(eq(consentTemplate.id, templateId))
    .for('update');
  if (!row) throw new AppError('not_found');
  return row;
}

async function assertAppointmentType(tx: Tx, appointmentTypeId: string | null | undefined) {
  if (appointmentTypeId === null || appointmentTypeId === undefined) return;
  const [found] = await tx
    .select({ id: appointmentType.id })
    .from(appointmentType)
    .where(eq(appointmentType.id, appointmentTypeId));
  if (!found) throw new AppError('consent_appointment_type_unknown');
}

export function createTemplateService(deps: { clock: () => Date }): TemplateService {
  async function detailOf(tx: Tx, row: ConsentTemplateRow): Promise<ConsentTemplateDetailResponse> {
    const versions = (await versionsOf(tx, [row.id])).get(row.id) ?? [];
    const stats = statsOf(versions);
    return {
      template: toTemplateDto(row, stats),
      versions: versions.map((version) => toVersionDto(version, stats.latest ?? 0)),
    };
  }

  async function reload(tx: Tx, templateId: string): Promise<ConsentTemplateDetailResponse> {
    const [row] = await tx.select().from(consentTemplate).where(eq(consentTemplate.id, templateId));
    if (!row) throw new AppError('not_found');
    return detailOf(tx, row);
  }

  /** Writes the next version of a locked template. The lock makes the number safe to take. */
  async function publishVersion(
    tx: Tx,
    input: {
      actor: Auditor;
      template: ConsentTemplateRow;
      title: string;
      body: string;
      latest: number | null;
    },
  ): Promise<number> {
    const number = (input.latest ?? 0) + 1;
    await tx.insert(consentTemplateVersion).values({
      tenantId,
      templateId: input.template.id,
      versionNumber: number,
      title: input.title,
      body: input.body,
      contentHash: templateFingerprint({ title: input.title, body: input.body }),
      publishedAt: deps.clock(),
      publishedBy: input.actor.userId,
    });
    await audit(tx, {
      action: 'consent.template.published',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'consent_template',
      resourceId: input.template.id,
      metadata: { version: number },
    });
    return number;
  }

  return {
    starters: () => ({
      starters: CONSENT_STARTERS.map((starter) => ({ ...starter })),
    }),

    async list(tx) {
      const rows = await tx
        .select()
        .from(consentTemplate)
        .orderBy(desc(consentTemplate.createdAt), desc(consentTemplate.id));
      const versions = await versionsOf(
        tx,
        rows.map((row) => row.id),
      );
      return { templates: rows.map((row) => toTemplateDto(row, statsOf(versions.get(row.id)))) };
    },

    async detail(tx, templateId) {
      return reload(tx, templateId);
    },

    async create(tx, { actor, request }) {
      if (request.starterKey !== undefined && !findStarter(request.starterKey)) {
        throw new AppError('consent_starter_unknown');
      }
      await assertAppointmentType(tx, request.appointmentTypeId);
      const [row] = await tx
        .insert(consentTemplate)
        .values({
          tenantId,
          title: request.title,
          draftBody: request.body,
          specialty: request.specialty ?? null,
          appointmentTypeId: request.appointmentTypeId ?? null,
          starterKey: request.starterKey ?? null,
          createdBy: actor.userId,
        })
        .returning();
      if (!row) throw new Error('inserting a consent template returned no row');
      await audit(tx, {
        action: 'consent.template.created',
        outcome: 'allow',
        actor,
        resourceType: 'consent_template',
        resourceId: row.id,
        metadata: {
          fromStarter: row.starterKey !== null,
          ...(row.specialty === null ? {} : { specialty: row.specialty }),
        },
      });
      return toTemplateDto(row, { latest: null, count: 0 });
    },

    async update(tx, { actor, templateId, request }) {
      const row = await lockTemplate(tx, templateId);
      if (row.status === 'retired') throw new AppError('consent_template_retired');
      await assertAppointmentType(tx, request.appointmentTypeId);

      const title = request.title ?? row.title;
      const body = request.body ?? row.draftBody;
      const metadata = {
        ...(request.specialty === undefined ? {} : { specialty: request.specialty }),
        ...(request.appointmentTypeId === undefined
          ? {}
          : { appointmentTypeId: request.appointmentTypeId }),
      };

      if (row.status === 'draft') {
        await tx
          .update(consentTemplate)
          .set({ title, draftBody: body, ...metadata })
          .where(eq(consentTemplate.id, row.id));
        return reload(tx, row.id);
      }

      // Published: the text is only ever changed by publishing the next version, and a rewrite that
      // reads the same (see `canonicalText`) is not a new version.
      const versions = (await versionsOf(tx, [row.id])).get(row.id) ?? [];
      const latest = versions[0];
      const changed = !latest || templateFingerprint({ title, body }) !== latest.contentHash;
      if (changed) {
        await tx
          .update(consentTemplate)
          .set({ title, draftBody: body, ...metadata })
          .where(eq(consentTemplate.id, row.id));
        await publishVersion(tx, {
          actor,
          template: row,
          title,
          body,
          latest: latest?.versionNumber ?? null,
        });
      } else if (Object.keys(metadata).length > 0) {
        await tx.update(consentTemplate).set(metadata).where(eq(consentTemplate.id, row.id));
      }
      return reload(tx, row.id);
    },

    async publish(tx, { actor, templateId }) {
      const row = await lockTemplate(tx, templateId);
      if (row.status === 'retired') throw new AppError('consent_template_retired');
      if (row.status !== 'draft') throw new AppError('consent_template_not_draft');
      await tx
        .update(consentTemplate)
        .set({ status: 'published' })
        .where(eq(consentTemplate.id, row.id));
      await publishVersion(tx, {
        actor,
        template: row,
        title: row.title,
        body: row.draftBody,
        latest: null,
      });
      return reload(tx, row.id);
    },

    async retire(tx, { actor, templateId }) {
      const row = await lockTemplate(tx, templateId);
      if (row.status === 'retired') throw new AppError('consent_template_retired');
      await tx
        .update(consentTemplate)
        .set({ status: 'retired', retiredAt: deps.clock(), retiredBy: actor.userId })
        .where(eq(consentTemplate.id, row.id));
      await audit(tx, {
        action: 'consent.template.retired',
        outcome: 'allow',
        actor,
        resourceType: 'consent_template',
        resourceId: row.id,
        metadata: { wasPublished: row.status === 'published' },
      });
      return reload(tx, row.id);
    },

    async offered(tx) {
      const templates = await tx
        .select()
        .from(consentTemplate)
        .where(eq(consentTemplate.status, 'published'))
        .orderBy(consentTemplate.title, consentTemplate.id);
      const versions = await versionsOf(
        tx,
        templates.map((row) => row.id),
      );
      return {
        templates: templates.flatMap((row) => {
          const latest = versions.get(row.id)?.[0];
          return latest
            ? [
                {
                  templateId: row.id,
                  versionId: latest.id,
                  versionNumber: latest.versionNumber,
                  title: latest.title,
                  specialty: row.specialty,
                },
              ]
            : [];
        }),
      };
    },
  };
}
