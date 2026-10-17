import { LOGO_MAX_DIMENSION, LOGO_TYPES } from '@consultorio/contracts';
import sharp from 'sharp';

/** The longest side the stored logo keeps; a larger one is shrunk, a smaller one is left alone. */
const STORED_MAX = 512;
/** Refuse to decode anything with more pixels than this: a small file can hide a huge picture. */
const PIXEL_LIMIT = LOGO_MAX_DIMENSION * LOGO_MAX_DIMENSION;

export type LogoRejection =
  | 'logo.type_unsupported'
  | 'logo.type_mismatch'
  | 'logo.trailing_data'
  | 'logo.corrupt'
  | 'logo.dimensions';

/** The upload is refused; `reason` is an i18n key for the admin and never repeats the content. */
export class LogoRejected extends Error {
  constructor(readonly reason: LogoRejection) {
    super(reason);
    this.name = 'LogoRejected';
  }
}

export interface NormalizedLogo {
  bytes: Buffer;
  contentType: 'image/png';
  width: number;
  height: number;
}

type Kind = 'png' | 'jpeg' | 'webp';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the first bytes say the file is, whatever its name or declared type claims. */
function sniff(bytes: Buffer): Kind | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** PNG ends at the IEND chunk; anything after it is not part of the image. */
function pngTrailing(bytes: Buffer): 'ok' | 'trailing' | 'corrupt' {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return 'corrupt';
    if (type === 'IEND') return end === bytes.length ? 'ok' : 'trailing';
    offset = end;
  }
  return 'corrupt';
}

/** JPEG ends with the EOI marker; a file with anything after it carries a second payload. */
function jpegTrailing(bytes: Buffer): 'ok' | 'trailing' | 'corrupt' {
  if (bytes.length < 4) return 'corrupt';
  return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 ? 'ok' : 'trailing';
}

/** WebP is a RIFF container whose size field says where the file ends. */
function webpTrailing(bytes: Buffer): 'ok' | 'trailing' | 'corrupt' {
  const declared = bytes.readUInt32LE(4) + 8;
  if (declared > bytes.length) return 'corrupt';
  return declared === bytes.length ? 'ok' : 'trailing';
}

const CHECKS: Record<Kind, (bytes: Buffer) => 'ok' | 'trailing' | 'corrupt'> = {
  png: pngTrailing,
  jpeg: jpegTrailing,
  webp: webpTrailing,
};

const DECLARED: Record<Kind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Validates a logo upload and returns the bytes to store (tenant-branding, "Logo upload safety").
 *
 * 1. The declared type must be PNG, JPEG or WebP (never SVG: it can carry script).
 * 2. The bytes must really be that type (magic bytes), and must end where the image ends: a file
 *    with a script appended is a polyglot and is refused.
 * 3. The picture is decoded with a pixel limit and its sides are bounded.
 * 4. What is stored is a NEW PNG made by re-encoding the pixels, so metadata (EXIF, GPS, comments)
 *    and anything hidden in the original container are gone.
 */
export async function normalizeLogo(input: Buffer, declaredType: string): Promise<NormalizedLogo> {
  if (!LOGO_TYPES.some((type) => type === declaredType))
    throw new LogoRejected('logo.type_unsupported');
  const kind = sniff(input);
  if (kind === null || DECLARED[kind] !== declaredType)
    throw new LogoRejected('logo.type_mismatch');

  const structure = CHECKS[kind](input);
  if (structure === 'trailing') throw new LogoRejected('logo.trailing_data');
  if (structure === 'corrupt') throw new LogoRejected('logo.corrupt');

  try {
    const source = sharp(input, { limitInputPixels: PIXEL_LIMIT * 4, failOn: 'error' });
    const meta = await source.metadata();
    const { width, height } = meta;
    if (width < 1 || height < 1 || width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
      throw new LogoRejected('logo.dimensions');
    }
    const { data, info } = await source
      .rotate()
      .resize({ width: STORED_MAX, height: STORED_MAX, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, contentType: 'image/png', width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof LogoRejected) throw error;
    // The decoder could not read it: the file is damaged or not what it claims.
    throw new LogoRejected('logo.corrupt');
  }
}
