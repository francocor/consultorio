import { randomBytes } from 'node:crypto';

const MAX_SEQUENCE = 0xfff;

export type UuidV7Generator = (nowMs?: number) => string;

/**
 * Builds a UUIDv7 generator (RFC 9562): a 48-bit millisecond timestamp, version 7, a 12-bit counter,
 * the variant bits and 62 random bits. Ids created later sort later, so primary key indexes stay
 * append-mostly. Each generator is strictly increasing, even inside one millisecond or when the
 * clock steps back, because its counter (and, on overflow, its timestamp) only moves forward.
 */
export function createUuidV7Generator(): UuidV7Generator {
  let lastMs = 0;
  let sequence = 0;

  return (nowMs = Date.now()) => {
    if (nowMs > lastMs) {
      lastMs = nowMs;
      // Start below the top of the range so a burst in one millisecond has headroom.
      sequence = randomBytes(2).readUInt16BE() & 0x7ff;
    } else {
      sequence += 1;
      if (sequence > MAX_SEQUENCE) {
        lastMs += 1;
        sequence = 0;
      }
    }

    const bytes = randomBytes(16);
    bytes.writeUIntBE(lastMs, 0, 6);
    bytes[6] = 0x70 | (sequence >> 8);
    bytes[7] = sequence & 0xff;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/**
 * Process-wide generator for application code. The database has its own `app.uuid_v7()` default
 * for rows created by SQL; the two produce compatible ids.
 */
export const uuidv7: UuidV7Generator = createUuidV7Generator();
