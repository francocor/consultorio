import type { AuditAction } from '@consultorio/contracts';

import type { AuditActor } from '../audit/writer.js';
import type { Actor, PortalActor } from '../authz/actor.js';
import type { Tx } from '../db/tenant-context.js';
import type { TokenKind } from '../tokens/kinds.js';

/**
 * What `GET /files/:token` serves (design 5.6 "Session-bound document download", extended in Stage
 * 4). One door, one rule: a link is bound to the session it was issued to, works once for about five
 * minutes, and is authorized AGAIN when it is used. What differs per kind of file (a patient's
 * document, a billing export, an invoice PDF) is decided by the resource that owns the kind:
 * which token it redeems, who may have the file, which audit entry the download writes.
 *
 * The documents module registers `document_download`; the billing track registers
 * `export_download` and the invoicing track `invoice_pdf`; the retention track (Stage 6) registers
 * `cancellation_export` for the packages of the cancellation export. None of them owns the route.
 *
 * The patient portal has a door of its own (Stage 5): the registry is generic over the actor who
 * redeems, so the staff registry holds resources that take a staff `Actor` and the portal registry
 * (`WiringContext.portalFileResources`) holds resources that take a `PortalActor`. The two never
 * share a resource, so a link of the portal cannot open a staff file and the other way round.
 */

/** The kinds of link that open a file. A reset or invitation link must never be one of them. */
export const FILE_TOKEN_KINDS = [
  'document_download',
  'export_download',
  'invoice_pdf',
  'prescription_pdf',
  'cancellation_export',
] as const satisfies readonly TokenKind[];
export type FileTokenKind = (typeof FILE_TOKEN_KINDS)[number];

/** The object to stream, and the headers its owner decided. */
export interface FileDelivery {
  /** The key of the object in the organization's storage (the route reads it for the caller). */
  objectKey: string;
  /** The final `content-type` header value. */
  contentType: string;
  /** The final `content-disposition` header value (a download name that cannot inject a header). */
  contentDisposition: string;
  /**
   * A file the owner rendered on demand and hands over as it is, instead of a stored object
   * (`objectKey` is then empty). Only the portal's door serves one: a signed consent PDF made for
   * the patient is streamed from memory and never written anywhere (JD-S5 R1-S5-8).
   */
  bytes?: Buffer;
}

/** Who redeems a link: a member of the staff, or a person signed in to the portal. */
export type FileActor = Actor | PortalActor;

export interface FileRedeemInput<A extends FileActor = Actor> {
  actor: A;
  auditActor: AuditActor;
  /** The session of the request: a link issued to another session is not valid here. */
  sessionId: string;
  token: string;
}

/**
 * A refusal a resource decided for a link that WAS live (the person lost access in the minutes
 * since the link was issued). The route answers the uniform 403 and writes the deny entry with what
 * the resource knew about the file.
 */
export class FileRefused extends Error {
  constructor(
    readonly reason: string,
    readonly resourceType: string,
    readonly context: { resourceId?: string; patientId?: string } = {},
  ) {
    super(reason);
    this.name = 'FileRefused';
  }
}

export interface FileResource<A extends FileActor = Actor> {
  /** The kind of link this resource redeems; one resource per kind. */
  kind: FileTokenKind;
  /** The audit actions `redeem` may write; the route declares them. */
  audits: readonly AuditAction[];
  /**
   * Spends the link and re-authorizes. Returns `null` when the token is not a live link of this
   * kind (unknown, spent, expired, another session's, another kind's): the registry then asks the
   * next resource. Throws `FileRefused` when the link was live but the caller may not have the
   * file. The audit entry of the download is written here, in the same transaction.
   */
  redeem(tx: Tx, input: FileRedeemInput<A>): Promise<FileDelivery | null>;
}

export interface FileResourceRegistry<A extends FileActor = Actor> {
  /** Throws for a second resource of one kind, and for a kind that is not a download kind. */
  register(resource: FileResource<A>): void;
  /** Redeems the link with the resource that owns it, or throws `FileRefused('file_link_invalid')`. */
  redeem(tx: Tx, input: FileRedeemInput<A>): Promise<FileDelivery>;
  /** Every audit action a download may write, once each. */
  audits(): AuditAction[];
  /** The kinds served, in registration order. */
  kinds(): FileTokenKind[];
}

function isFileTokenKind(kind: string): kind is FileTokenKind {
  return FILE_TOKEN_KINDS.some((known) => known === kind);
}

export function createFileResourceRegistry<A extends FileActor = Actor>(): FileResourceRegistry<A> {
  const resources: FileResource<A>[] = [];

  return {
    register(resource) {
      // The type already says it; the check is for a caller that casts.
      const kind: string = resource.kind;
      if (!isFileTokenKind(kind)) {
        throw new Error(`The token kind "${kind}" does not open files.`);
      }
      if (resources.some((known) => known.kind === resource.kind)) {
        throw new Error(`A file resource is already registered for "${resource.kind}".`);
      }
      resources.push(resource);
    },

    async redeem(tx, input) {
      for (const resource of resources) {
        const delivery = await resource.redeem(tx, input);
        if (delivery !== null) return delivery;
      }
      // Fail closed: no resource knows this link. Whatever the reason (never issued, spent,
      // expired, another session's, a kind nobody serves), the answer is the same.
      throw new FileRefused('file_link_invalid', 'file');
    },

    audits() {
      return [...new Set(resources.flatMap((resource) => resource.audits))];
    },

    kinds() {
      return resources.map((resource) => resource.kind);
    },
  };
}
