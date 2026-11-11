import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

/**
 * The icons of the installer and the tray, drawn from the product icon (`apps/web/public/icons`).
 * Windows reads a `.ico` made of PNG images from Vista on, so the file is just a directory of PNGs.
 */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

/** An `.ico` file holding one PNG per image. */
export function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const at = index * 16;
    // 0 stands for 256.
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, at);
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    entries.writeUInt8(0, at + 2); // palette
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(image.png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

async function png(source: string, size: number): Promise<Buffer> {
  return sharp(source, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/**
 * Writes `icon.ico` (installer, program and shortcuts) to `buildDir`, and `tray.png` and `window.png` to
 * `iconsDir` (the shell loads them at run time).
 */
export async function makeIcons(options: {
  source: string;
  buildDir: string;
  iconsDir: string;
}): Promise<void> {
  await mkdir(options.buildDir, { recursive: true });
  await mkdir(options.iconsDir, { recursive: true });
  const images = await Promise.all(
    ICO_SIZES.map(async (size) => ({ size, png: await png(options.source, size) })),
  );
  await writeFile(join(options.buildDir, 'icon.ico'), buildIco(images));
  await writeFile(join(options.iconsDir, 'tray.png'), await png(options.source, 32));
  await writeFile(join(options.iconsDir, 'window.png'), await png(options.source, 256));
}
