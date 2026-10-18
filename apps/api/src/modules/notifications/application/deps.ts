import type { WorklistKind, WorklistSubjectType } from '@consultorio/contracts';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';

import type { WhatsAppSender } from './ports.js';
import type { QuotaPolicy } from './usage.js';
import type { VideoJoinResolver } from './video-join.js';

/** The organization a message is about; a demo organization never reaches a real provider. */
export interface TenantRef {
  id: string;
  isDemo: boolean;
}

/**
 * Which provider serves which organization. The wiring builds these from the adapter resolver, so
 * the module never knows the resolver, the registry or the environment. `undefined` means the
 * channel is not configured for that organization (no mail server, no WhatsApp provider).
 */
export interface Channels {
  email(tenant: TenantRef): EmailSender | undefined;
  whatsapp(tenant: TenantRef): WhatsAppSender | undefined;
}

/** What messaging asks of the reception worklist (the queue itself belongs to scheduling). */
export interface WorklistItem {
  kind: Extract<WorklistKind, 'reminder_not_sent' | 'reminder_not_delivered' | 'reply_to_review'>;
  subjectType: WorklistSubjectType;
  subjectId: string;
  locationId: string | null;
  /**
   * Administrative detail for the person who works the item, stored encrypted. Only the worklist
   * of the API process keeps it; the worker's version leaves it out.
   */
  detail?: Record<string, unknown>;
}

export interface Worklist {
  /** Idempotent: an open item of the same kind and subject is left as it is. */
  open(tx: Tx, item: WorklistItem): Promise<void>;
  /** Closes the open item of that kind about that subject, if there is one. */
  close(tx: Tx, item: Pick<WorklistItem, 'kind' | 'subjectType' | 'subjectId'>): Promise<void>;
}

/** What the sending jobs and the planner use. The composition root builds it once per process. */
export interface MessagingDeps {
  withTenant: WithTenant;
  channels: Channels;
  /** Enqueues jobs in the caller's transaction (retries, fallbacks, planned reminders). */
  jobs: JobClient;
  clock: () => Date;
  /** Where the links in an email point (never the Host header of a request). */
  origins: PublicOrigins;
  tokens: ActionTokens;
  worklist: Worklist;
  /** Encrypts what messaging keeps that is a capability (the address of an offer). */
  keys: TenantKeys;
  /** The plan's WhatsApp quota. Absent: no quota, everything is allowed and counted. */
  quota?: QuotaPolicy;
  /**
   * The join address of a virtual appointment, for the messages that carry it. Absent (a process
   * where teleconsultation is not wired): such a message says the link follows.
   */
  videoJoin?: VideoJoinResolver;
}
