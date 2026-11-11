import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The DLLs a Windows program (or DLL) loads, read from its import tables. The installer ships the
 * PostgreSQL tools with exactly the libraries they need and no others, and this is how it knows which:
 * a missing DLL fails on the clinic's PC ("the code execution cannot proceed"), an extra one only weighs.
 */

interface Section {
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
}

function readCString(buffer: Buffer, offset: number): string {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString('latin1', offset, end);
}

/** The names of the DLLs a PE file imports (normal and delay-loaded), as written in the file. */
export function importedDlls(file: string): string[] {
  const buffer = readFileSync(file);
  if (buffer.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file} is not a Windows program`);
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error(`${file} has no PE header`);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  const magic = buffer.readUInt16LE(optional);
  // PE32+ (64-bit) keeps the data directories at 112, PE32 at 96.
  const directories = optional + (magic === 0x20b ? 112 : 96);

  const sections: Section[] = [];
  let sectionOffset = optional + optionalSize;
  for (let index = 0; index < sectionCount; index += 1) {
    sections.push({
      virtualSize: buffer.readUInt32LE(sectionOffset + 8),
      virtualAddress: buffer.readUInt32LE(sectionOffset + 12),
      rawSize: buffer.readUInt32LE(sectionOffset + 16),
      rawOffset: buffer.readUInt32LE(sectionOffset + 20),
    });
    sectionOffset += 40;
  }
  const toOffset = (rva: number): number => {
    const section = sections.find(
      (candidate) =>
        rva >= candidate.virtualAddress &&
        rva < candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize),
    );
    if (!section) throw new Error(`${file}: address ${String(rva)} is outside every section`);
    return section.rawOffset + (rva - section.virtualAddress);
  };

  const names = new Set<string>();
  const walk = (directoryIndex: number, size: number, nameField: number) => {
    const rva = buffer.readUInt32LE(directories + directoryIndex * 8);
    if (rva === 0) return;
    for (let descriptor = toOffset(rva); ; descriptor += size) {
      const isEnd = buffer.subarray(descriptor, descriptor + size).every((byte) => byte === 0);
      if (isEnd) break;
      const nameRva = buffer.readUInt32LE(descriptor + nameField);
      if (nameRva === 0) break;
      names.add(readCString(buffer, toOffset(nameRva)));
    }
  };
  // Import directory (index 1): 20-byte descriptors, the name at +12. Delay-load (index 13): 32 bytes, +4.
  walk(1, 20, 12);
  walk(13, 32, 4);
  return [...names];
}

/**
 * Every DLL the given programs need that is in `folder`, directly or through each other (a DLL that imports
 * another one). Imports that are not in `folder` belong to Windows itself and are left out; they are returned
 * separately so a caller can check that nothing unexpected is missing.
 */
export function dllClosure(folder: string, roots: string[]): { found: string[]; system: string[] } {
  const found = new Set<string>();
  const system = new Set<string>();
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current.toLowerCase())) continue;
    seen.add(current.toLowerCase());
    const path = existsSync(current) ? current : join(folder, current);
    for (const name of importedDlls(path)) {
      const local = join(folder, name);
      if (existsSync(local)) {
        found.add(name);
        queue.push(local);
      } else {
        system.add(name);
      }
    }
  }
  return { found: [...found], system: [...system] };
}
