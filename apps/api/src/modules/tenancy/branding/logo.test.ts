import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { LogoRejected, normalizeLogo } from './logo.js';

async function image(
  format: 'png' | 'jpeg' | 'webp',
  size = { width: 120, height: 80 },
  extra: { exif?: boolean } = {},
): Promise<Buffer> {
  let pipeline = sharp({
    create: { width: size.width, height: size.height, channels: 3, background: '#336699' },
  });
  if (extra.exif) pipeline = pipeline.withExif({ IFD0: { Copyright: 'Secreto de quien lo sacó' } });
  return pipeline[format]().toBuffer();
}

const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

async function reason(buffer: Buffer, declared: string): Promise<string> {
  try {
    await normalizeLogo(buffer, declared);
  } catch (error) {
    if (error instanceof LogoRejected) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('normalizeLogo', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    're-encodes a %s as a PNG and reports its size',
    async (format) => {
      const result = await normalizeLogo(await image(format), TYPES[format]);

      expect(result.contentType).toBe('image/png');
      expect(result.width).toBe(120);
      expect(result.height).toBe(80);
      expect((await sharp(result.bytes).metadata()).format).toBe('png');
    },
  );

  it('shrinks a large logo to fit 512 pixels and never enlarges a small one', async () => {
    const big = await normalizeLogo(await image('png', { width: 1600, height: 800 }), 'image/png');
    const small = await normalizeLogo(await image('png', { width: 64, height: 64 }), 'image/png');

    expect([big.width, big.height]).toEqual([512, 256]);
    expect([small.width, small.height]).toEqual([64, 64]);
  });

  it('strips the metadata: the stored logo carries no EXIF', async () => {
    const original = await image('jpeg', { width: 100, height: 100 }, { exif: true });
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const result = await normalizeLogo(original, 'image/jpeg');

    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  });

  describe('refuses', () => {
    it('a file whose bytes are not the declared type', async () => {
      expect(await reason(await image('png'), 'image/jpeg')).toBe('logo.type_mismatch');
      expect(await reason(await image('jpeg'), 'image/webp')).toBe('logo.type_mismatch');
    });

    it('bytes that are no image at all, whatever the declared type', async () => {
      expect(await reason(Buffer.from('MZ\x90\x00 an executable'), 'image/png')).toBe(
        'logo.type_mismatch',
      );
      expect(await reason(Buffer.alloc(0), 'image/png')).toBe('logo.type_mismatch');
      expect(
        await reason(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
          'image/png',
        ),
      ).toBe('logo.type_mismatch');
    });

    it('a type outside png, jpeg and webp', async () => {
      expect(await reason(await image('png'), 'image/svg+xml')).toBe('logo.type_unsupported');
      expect(await reason(await image('png'), 'image/gif')).toBe('logo.type_unsupported');
      expect(await reason(await image('png'), 'text/html')).toBe('logo.type_unsupported');
    });

    it('a polyglot: a valid image with a script after it', async () => {
      const script = Buffer.from('<script>alert(document.cookie)</script>');

      expect(await reason(Buffer.concat([await image('png'), script]), 'image/png')).toBe(
        'logo.trailing_data',
      );
      expect(await reason(Buffer.concat([await image('jpeg'), script]), 'image/jpeg')).toBe(
        'logo.trailing_data',
      );
      expect(await reason(Buffer.concat([await image('webp'), script]), 'image/webp')).toBe(
        'logo.trailing_data',
      );
    });

    it('a truncated file', async () => {
      const png = await image('png');

      expect(await reason(png.subarray(0, png.length - 20), 'image/png')).toBe('logo.corrupt');
    });

    it('a logo with more than 2048 pixels on a side', async () => {
      expect(await reason(await image('png', { width: 2049, height: 10 }), 'image/png')).toBe(
        'logo.dimensions',
      );
      expect(await reason(await image('png', { width: 10, height: 2049 }), 'image/png')).toBe(
        'logo.dimensions',
      );
      expect(await reason(await image('png', { width: 2048, height: 16 }), 'image/png')).toBe(
        'accepted',
      );
    });

    it('never names the content in the reason', async () => {
      expect(await reason(Buffer.from('secret-name.exe'), 'image/png')).not.toContain('secret');
    });
  });
});
