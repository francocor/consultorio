import { createHash, randomUUID } from 'node:crypto';

import type {
  ConsentMarkInput,
  ConsentRequestDto,
  ConsentSigningViewDto,
  SignConsentRequest,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';

import { consentSignature, consentTemplate } from '../../../db/schema/consent.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  signatureFingerprint,
  templateFingerprint,
  type SignatureMark,
} from '../domain/fingerprint.js';
import { effectiveStatus } from '../domain/visibility.js';

import { patientSigningFacts } from './patient-facts.js';
import {
  SIGNATURE_FIELD,
  requireRequest,
  tenantId,
  toRequestDto,
  type RequestWithVersion,
  type SignaturePayload,
} from './records.js';

/** Who is at the other end of the signature: the staff at the device, or the portal identity. */
export type SignatureRecorder =
  { kind: 'staff'; userId: string } | { kind: 'portal'; identityId: string };

export interface SigningService {
  /** The full text of the version a request is bound to, for the signer to read. */
  view(
    tx: Tx,
    input: { requestId: string; recorder: SignatureRecorder; patientId?: string },
  ): Promise<ConsentSigningViewDto>;
  /** Records the signature against the version the signer was shown. */
  sign(
    tx: Tx,
    input: {
      requestId: string;
      recorder: SignatureRecorder;
      auditActor: AuditActor;
      request: SignConsentRequest;
      /** The patient the caller serves (the portal's subject): another patient's request is not found. */
      patientId?: string;
    },
  ): Promise<ConsentRequestDto>;
}

/** The most a drawn signature may weigh once decoded. */
const MAX_IMAGE_BYTES = 100_000;
/** The biggest drawing accepted: the pad is 480 by 160; this leaves room for a larger one. */
const MAX_IMAGE_SIDE = 2_000;
const MAX_IMAGE_PIXELS = 1_000_000;
/** The longest typed mark, in characters. */
const MAX_TYPED_MARK = 120;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL_PREFIX = 'data:image/png;base64,';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

interface ResolvedMark {
  mark: SignatureMark;
  payload: SignaturePayload['mark'];
  digest: string;
}

/**
 * A typed name stands as it is (up to 120 characters); a drawing must be a real PNG of a reasonable
 * size, and it is really decoded here (JD-S5 R1-S5-5): a corrupt image, or garbage after a valid
 * header, would otherwise be stored for good, immutable, and break every render of the record. The
 * prefix is checked here whatever the route said, so no caller can hand over another kind of data.
 */
async function resolveMark(input: ConsentMarkInput): Promise<ResolvedMark> {
  if (input.kind === 'typed') {
    const name = input.name.normalize('NFC');
    if (name.trim().length === 0 || name.length > MAX_TYPED_MARK) {
      throw new AppError('consent_mark_invalid');
    }
    return {
      mark: { kind: 'typed', value: name },
      payload: { kind: 'typed', value: name },
      digest: sha256(name),
    };
  }
  if (!input.imageDataUrl.startsWith(DATA_URL_PREFIX)) throw new AppError('consent_mark_invalid');
  const encoded = input.imageDataUrl.slice(DATA_URL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new AppError('consent_mark_invalid');
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new AppError('consent_mark_invalid');
  }
  try {
    // The header says how big it is before anything is decoded; then every pixel is decoded, so a
    // truncated or corrupt image fails here and not when the record is printed.
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' });
    const { format, width, height } = await image.metadata();
    if (
      format !== 'png' ||
      width < 1 ||
      height < 1 ||
      width > MAX_IMAGE_SIDE ||
      height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS
    ) {
      throw new AppError('consent_mark_invalid');
    }
    await image.raw().toBuffer();
  } catch {
    throw new AppError('consent_mark_invalid');
  }
  const digest = sha256(bytes);
  return {
    mark: { kind: 'drawn', value: digest },
    payload: { kind: 'drawn', value: input.imageDataUrl },
    digest,
  };
}

/**
 * Signing (informed-consent, "Signature capture and binding" and "Minors, incapacitated patients and
 * representatives"). The same steps serve the device at reception and the portal; only the
 * recorder differs (`consent_signature.method` follows the way the request was made).
 *
 * - The signature binds to the version the signer was SHOWN: the request is bound to a version
 *   when it is made, the body names the version on screen, and they must be the same one, even if
 *   a newer version was published meanwhile.
 * - The explicit acceptance action is required.
 * - A minor never signs for themselves: the representative's name, document and relation are
 *   required, and the record says a representative signed.
 * - An expired or closed request cannot be signed.
 * - The personal part of the record (representative, mark, evidence) is encrypted with the tenant key.
 * - The request flips to `signed` by the trigger of the signature, in the same transaction.
 */
export function createSigningService(deps: {
  keys: TenantKeys;
  clock: () => Date;
}): SigningService {
  /** The request as the caller may see it: another patient's request does not exist for the portal. */
  async function load(
    tx: Tx,
    requestId: string,
    recorder: SignatureRecorder,
    patientId: string | undefined,
    lock: boolean,
  ): Promise<RequestWithVersion> {
    const found = await requireRequest(tx, requestId, { lock });
    if (patientId !== undefined && found.request.patientId !== patientId) {
      throw new AppError('not_found');
    }
    // A request is signed the way it was made: on the device at reception, or in the portal.
    const expected = recorder.kind === 'staff' ? 'in_person' : 'portal';
    if (found.request.method !== expected) throw new AppError('consent_method_mismatch');
    // A template the organization retired is not offered for new signatures, also to a request that
    // was made before it was retired (informed-consent, "Retire a template"). A NEWER version of a
    // live template is another matter: the signature binds to the version the signer was shown.
    const [template] = await tx
      .select({ status: consentTemplate.status })
      .from(consentTemplate)
      .where(eq(consentTemplate.id, found.version.templateId));
    if (template?.status === 'retired') throw new AppError('consent_template_retired');
    return found;
  }

  function assertOpen(found: RequestWithVersion, now: Date): void {
    const status = effectiveStatus(
      found.request.status as Parameters<typeof effectiveStatus>[0],
      found.request.expiresAt,
      now,
    );
    if (status === 'expired') throw new AppError('consent_request_expired');
    if (status !== 'pending') throw new AppError('consent_request_closed');
  }

  return {
    async view(tx, { requestId, recorder, patientId }) {
      const now = deps.clock();
      const found = await load(tx, requestId, recorder, patientId, false);
      assertOpen(found, now);
      const facts = await patientSigningFacts(tx, found.request.patientId, now);
      return {
        requestId: found.request.id,
        status: 'pending',
        method: found.request.method as ConsentSigningViewDto['method'],
        expiresAt: found.request.expiresAt.toISOString(),
        patientName: facts.name,
        requiresRepresentative: facts.minor,
        version: {
          id: found.version.id,
          number: found.version.versionNumber,
          title: found.version.title,
          body: found.version.body,
          contentHash: found.version.contentHash,
        },
      };
    },

    async sign(tx, { requestId, recorder, auditActor, request, patientId }) {
      const now = deps.clock();
      const found = await load(tx, requestId, recorder, patientId, true);
      assertOpen(found, now);

      if (!request.accepted) throw new AppError('consent_acceptance_required');
      if (request.versionId !== found.version.id) throw new AppError('consent_version_mismatch');

      const facts = await patientSigningFacts(tx, found.request.patientId, now);
      if (request.signer === 'representative') {
        if (!request.representative) throw new AppError('consent_representative_required');
      } else {
        if (facts.minor) throw new AppError('consent_representative_required');
        if (request.representative) throw new AppError('consent_representative_unexpected');
      }
      const mark = await resolveMark(request.mark);

      // What was published must still be what the version says it is.
      const versionFingerprint = templateFingerprint({
        title: found.version.title,
        body: found.version.body,
      });
      if (versionFingerprint !== found.version.contentHash) {
        throw new Error('The template version no longer matches its fingerprint');
      }

      const id = randomUUID();
      const signedAt = now;
      const representative = request.representative ?? null;
      const fingerprint = signatureFingerprint({
        requestId: found.request.id,
        patientId: found.request.patientId,
        versionId: found.version.id,
        versionFingerprint,
        signerKind: request.signer,
        representative,
        accepted: true,
        method: found.request.method as 'in_person' | 'portal',
        signedAt: signedAt.toISOString(),
        mark: mark.mark,
      });
      const payload: SignaturePayload = {
        v: 1,
        representative,
        // The full name the signer typed, kept beside a mark that may be a drawing.
        ...(request.signerName === undefined
          ? {}
          : { signerName: request.signerName.normalize('NFC') }),
        mark: mark.payload,
        markDigest: mark.digest,
        evidence: {
          ip: auditActor.ip,
          userAgent: auditActor.userAgent?.slice(0, 200) ?? null,
          requestId: auditActor.requestId,
        },
      };
      const payloadEnc = await deps.keys.encryptField(
        tx,
        { ...SIGNATURE_FIELD, rowId: id },
        JSON.stringify(payload),
      );
      // No RETURNING: whoever records a signing cannot read it back (only a professional does).
      await tx.insert(consentSignature).values({
        id,
        tenantId,
        requestId: found.request.id,
        patientId: found.request.patientId,
        templateVersionId: found.version.id,
        signerKind: request.signer,
        accepted: true,
        method: found.request.method,
        payloadEnc,
        contentFingerprint: fingerprint,
        signedAt,
        recordedBy: recorder.kind === 'staff' ? recorder.userId : null,
        portalIdentityId: recorder.kind === 'portal' ? recorder.identityId : null,
      });

      await audit(tx, {
        action: 'consent.signed',
        outcome: 'allow',
        actor: auditActor,
        resourceType: 'consent_request',
        resourceId: found.request.id,
        patientId: found.request.patientId,
        // Who, how and which version; never the text and never the signature.
        metadata: {
          templateId: found.version.templateId,
          version: found.version.versionNumber,
          method: found.request.method,
          signer: request.signer,
          ...(recorder.kind === 'portal' ? { identityId: recorder.identityId } : {}),
        },
      });

      const refreshed = await requireRequest(tx, found.request.id);
      return toRequestDto(refreshed.request, refreshed.version, now);
    },
  };
}
