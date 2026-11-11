import { z } from 'zod';

/**
 * The manifest of an archive (tenancy, "Retention archive after cancellation": "objects carry a
 * SHA-256 manifest"): what the archive holds, object by object, with the checksum of the bytes as
 * they are stored. It is plain JSON on purpose: it names parts, sizes and hashes and carries no
 * content, and the verification that runs in the worker (which cannot decrypt anything) reads it to
 * know what to expect. It is stored last, once, and its own checksum is recorded in the database
 * and in the platform trail, so replacing it is detected.
 */

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ManifestObject = z.strictObject({
  /** The name of the object in the archive. */
  name: z.string().min(1),
  /** The size and checksum of the stored (sealed) bytes. */
  sealedBytes: z.number().int().nonnegative(),
  sealedSha256: Sha256,
  /** The size of the part of the package this object holds, before encryption. */
  plainBytes: z.number().int().nonnegative(),
});

export const ManifestPart = z.strictObject({
  /** `administrative`, or `clinical-<professional id>`. */
  part: z.string().min(1),
  kind: z.enum(['administrative', 'clinical']),
  /** The professional whose patients the part holds; null for the administrative one. */
  professionalId: z.uuid().nullable(),
  /**
   * Who that professional is by registration, so a release finds their part without opening the
   * archive (the registration of a professional is public; no name, no content).
   */
  professional: z
    .strictObject({
      matriculaJurisdiction: z.string().nullable(),
      matricula: z.string().nullable(),
      matriculaStatus: z.string(),
    })
    .nullable(),
  /** The package (a zip) the objects are the encrypted pieces of, in order. */
  zipBytes: z.number().int().nonnegative(),
  zipSha256: Sha256,
  objects: z.array(ManifestObject).min(1),
});

export const ArchiveManifest = z.strictObject({
  format: z.literal(1),
  tenantId: z.uuid(),
  archiveId: z.uuid(),
  attemptId: z.uuid(),
  keyVersion: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  retainUntil: z.iso.datetime(),
  parts: z.array(ManifestPart).min(1),
});

export type ManifestObject = z.infer<typeof ManifestObject>;
export type ManifestPart = z.infer<typeof ManifestPart>;
export type ArchiveManifest = z.infer<typeof ArchiveManifest>;

export function manifestBytes(manifest: ArchiveManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(ArchiveManifest.parse(manifest), null, 2)}\n`);
}

export function parseManifest(bytes: Uint8Array): ArchiveManifest {
  return ArchiveManifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Every object of the archive plus the manifest: what the database counts. */
export function objectCount(manifest: ArchiveManifest): number {
  return manifest.parts.reduce((total, part) => total + part.objects.length, 0) + 1;
}
