/**
 * What a storage adapter that has no server of its own (the filesystem of the desktop profile) needs
 * so a browser can upload to it the way it uploads to S3: the adapter hands out a link that carries a
 * signed policy, and this port is the other half, called by the route that receives the POST. S3 and
 * MinIO check the same conditions on their side, so they have no receiver.
 */

/** The policy a link was made for: one object, one content type, a size cap and an expiry. */
export interface UploadGrant {
  tenantId: string;
  key: string;
  contentType: string;
  maxBytes: number;
  expiresAt: Date;
}

export type UploadOutcome = 'stored' | 'wrong_type' | 'too_large' | 'empty';

export interface UploadReceiver {
  /** The grant a link carries, or null when it is forged, altered or expired. */
  verify(token: string): UploadGrant | null;
  /** Stores what the browser posted, if it keeps within the grant. */
  accept(
    grant: UploadGrant,
    upload: { contentType: string; bytes: Buffer },
  ): Promise<UploadOutcome>;
}
