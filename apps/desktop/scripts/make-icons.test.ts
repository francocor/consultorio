import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildIco, ICO_SIZES, makeIcons } from './make-icons.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-icons-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const productIcon = fileURLToPath(new URL('../../web/public/icons/icon.svg', import.meta.url));

describe('the icon file', () => {
  it('is a directory of PNG images with the sizes Windows asks for', () => {
    const png = Buffer.from('\x89PNG-fake');
    const ico = buildIco([
      { size: 16, png },
      { size: 256, png },
    ]);

    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    // First entry: 16 x 16, 32 bits, the image right after the directory.
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt16LE(12)).toBe(32);
    expect(ico.readUInt32LE(14)).toBe(png.length);
    expect(ico.readUInt32LE(18)).toBe(6 + 32);
    // 256 is written as 0.
    expect(ico.readUInt8(6 + 16)).toBe(0);
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(6 + 32 + png.length);
  });

  it('is made from the product icon, with the tray and window images beside it', async () => {
    await makeIcons({
      source: productIcon,
      buildDir: join(folder, 'build'),
      iconsDir: join(folder, 'icons'),
    });

    const ico = readFileSync(join(folder, 'build', 'icon.ico'));
    expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length);
    // The biggest image is a real 256-pixel PNG.
    const lastEntry = 6 + 16 * (ICO_SIZES.length - 1);
    const offset = ico.readUInt32LE(lastEntry + 12);
    const length = ico.readUInt32LE(lastEntry + 8);
    const biggest = await sharp(ico.subarray(offset, offset + length)).metadata();
    expect([biggest.format, biggest.width, biggest.height]).toEqual(['png', 256, 256]);
    const tray = await sharp(join(folder, 'icons', 'tray.png')).metadata();
    const window = await sharp(join(folder, 'icons', 'window.png')).metadata();
    expect([tray.width, tray.height]).toEqual([32, 32]);
    expect([window.width, window.height]).toEqual([256, 256]);
  });
});
