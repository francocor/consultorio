import {
  ChannelParams,
  PatientChannelsResponse,
  type MessageChannel,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant, Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { TOKEN_KIND_REGISTRY, type ActionTokens } from '../../../platform/tokens/index.js';
import { readPatientContact } from '../../patients/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { TOKEN_PATH } from '../application/links.js';
import { optOutChannel } from '../application/opt-out.js';
import {
  describeChannel,
  loadPreferences,
  OptInRefused,
  recordOptIn,
} from '../application/preferences.js';
import { renderOptInRequestEmail } from '../assets/es-AR/opt-in-email.js';
import { firstNameOf } from '../domain/content.js';
import { normalizeWhatsAppNumber } from '../domain/phone.js';

/**
 * What reception does about the channels of a patient (spec "Opt-out and consent"): see what the
 * patient chose, record an opt-in or an opt-out the patient gave in person, and send the patient a
 * link by email to accept WhatsApp. Staff can switch a channel OFF for a patient; only the patient
 * can switch one back on after opting out.
 */

export interface ChannelRoutesDeps {
  withTenant: WithTenant;
  tokens: ActionTokens;
  /** Sends the opt-in request. Routed by organization in the application. */
  email: EmailSender;
  origins: PublicOrigins;
}

const NoBody = z.strictObject({});
const PatientParams = z.strictObject({ id: z.uuid() });
const DAY_MS = 86_400_000;

async function channelsOf(tx: Tx, patientId: string): Promise<PatientChannelsResponse> {
  const contact = await readPatientContact(tx, patientId);
  if (!contact) throw new AppError('not_found');
  const email = await describeChannel(tx, patientId, 'email');
  const whatsapp = await describeChannel(tx, patientId, 'whatsapp');
  const stateOf = (found: typeof email, fallback: 'default' | 'none') => ({
    state: found.state ?? fallback,
    source: found.source,
    recordedAt: found.recordedAt?.toISOString() ?? null,
  });
  return {
    email: stateOf(email, 'default'),
    whatsapp: stateOf(whatsapp, 'none'),
    hasEmail: (contact.email?.trim() ?? '') !== '',
    hasMobile: contact.phone !== null && normalizeWhatsAppNumber(contact.phone) !== null,
  };
}

function actorOf(request: FastifyRequest) {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return { userId: actor.userId, tenantId: actor.tenantId, audit: request.auditActor };
}

export function channelRoutes(deps: ChannelRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/channels',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: PatientChannelsResponse } },
      },
      (request) => {
        const { userId, tenantId } = actorOf(request);
        return deps.withTenant({ tenantId, userId }, (tx) => channelsOf(tx, request.params.id));
      },
    );

    typed.post(
      '/patients/:id/channels/:channel/opt-in',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['notification.optin.recorded'],
        },
        schema: { params: ChannelParams, body: NoBody, response: { 200: PatientChannelsResponse } },
      },
      (request) => {
        const { userId, tenantId, audit } = actorOf(request);
        const { id, channel } = request.params;
        return deps.withTenant({ tenantId, userId }, async (tx) => {
          const current = await channelsOf(tx, id);
          if (channel === 'whatsapp' && !current.hasMobile) {
            throw new AppError('patient_without_phone');
          }
          try {
            if (channel === 'email') {
              // Email works until the patient opts out: there is nothing for staff to switch on,
              // and a channel the patient switched off stays off.
              if ((await loadPreferences(tx, id)).email === 'opted_out') throw new OptInRefused();
            } else {
              await recordOptIn(tx, {
                patientId: id,
                channel,
                source: 'staff',
                recordedBy: userId,
                actor: audit,
              });
            }
          } catch (error) {
            if (error instanceof OptInRefused) throw new AppError('channel_opted_out');
            throw error;
          }
          return channelsOf(tx, id);
        });
      },
    );

    typed.post(
      '/patients/:id/channels/:channel/opt-out',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['notification.optout.recorded'],
        },
        schema: { params: ChannelParams, body: NoBody, response: { 200: PatientChannelsResponse } },
      },
      (request) => {
        const { userId, tenantId, audit } = actorOf(request);
        const { id, channel } = request.params;
        return deps.withTenant({ tenantId, userId }, async (tx) => {
          await channelsOf(tx, id);
          await optOutChannel(tx, {
            patientId: id,
            channel: channel satisfies MessageChannel,
            source: 'staff',
            recordedBy: userId,
            actor: audit,
          });
          return channelsOf(tx, id);
        });
      },
    );

    // The patient accepts WhatsApp by a link in an email: reception cannot hear a yes in person.
    typed.post(
      '/patients/:id/whatsapp-opt-in-request',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: 'none' },
        schema: {
          params: PatientParams,
          body: NoBody,
          response: { 200: z.strictObject({ sent: z.literal(true) }) },
        },
      },
      async (request) => {
        const { userId, tenantId } = actorOf(request);
        const host = request.hostContext;
        if (host?.kind !== 'tenant') throw new AppError('not_found');
        const { id } = request.params;
        await deps.withTenant({ tenantId, userId }, async (tx) => {
          const contact = await readPatientContact(tx, id);
          if (!contact) throw new AppError('not_found');
          const email = contact.email?.trim() ?? '';
          if (email === '') throw new AppError('patient_without_email');
          if (contact.phone === null || normalizeWhatsAppNumber(contact.phone) === null) {
            throw new AppError('patient_without_phone');
          }
          const preferences = await loadPreferences(tx, id);
          if (preferences.whatsapp === 'opted_in') throw new AppError('conflict');
          // The request is an email: a patient who opted out of email is not written to by it.
          if (preferences.email === 'opted_out') throw new AppError('channel_opted_out');

          // A newer request replaces the older link.
          await deps.tokens.revokeForSubject(tx, 'whatsapp_opt_in', id);
          const issued = await deps.tokens.issue(tx, { kind: 'whatsapp_opt_in', subjectId: id });
          const message = renderOptInRequestEmail({
            organizationName: await readOrganizationName(tx),
            patientName: firstNameOf(contact.givenNames),
            link: `${deps.origins(host.tenant.slug)}${TOKEN_PATH}${issued.token}`,
            expiresInDays: Math.round(TOKEN_KIND_REGISTRY.whatsapp_opt_in.ttlMs / DAY_MS),
          });
          await deps.email.send({
            to: email,
            ...message,
            tenant: { id: host.tenant.id, isDemo: host.tenant.isDemo },
          });
        });
        return { sent: true as const };
      },
    );
  };
}
