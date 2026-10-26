/**
 * A `pg_dump` archive (custom format, version 1.14) made by hand, to put SQL in front of `pg_restore` that
 * `pg_dump` would never write. A backup is a program for `pg_restore`: every entry of its table of contents carries
 * the SQL that is run when the entry is restored, whatever the entry says it is, so a hostile backup is simply an
 * archive whose entries say something else. The tests of the restore use this to be the hostile backup.
 *
 * Only what is needed: no data, no dependencies, no compression. The layout is the one of `WriteHead`,
 * `WriteToc` and `_WriteExtraToc` in `pg_backup_archiver.c` and `pg_backup_custom.c`.
 */

const INT_SIZE = 4;
const OFFSET_SIZE = 8;

/** `K_OFFSET_NO_DATA`: an entry that has no data to read. */
const OFFSET_NO_DATA = 3;

class ArchiveBytes {
  private readonly chunks: Buffer[] = [];

  byte(value: number): void {
    this.chunks.push(Buffer.from([value]));
  }

  /** `WriteInt`: a sign byte, then the magnitude, little-endian, in `INT_SIZE` bytes. */
  int(value: number): void {
    const bytes = Buffer.alloc(1 + INT_SIZE);
    bytes.writeUInt8(value < 0 ? 1 : 0, 0);
    bytes.writeUInt32LE(Math.abs(value), 1);
    this.chunks.push(bytes);
  }

  /** `WriteStr`: the length, then the bytes; `null` is -1. */
  text(value: string | null): void {
    if (value === null) {
      this.int(-1);
      return;
    }
    const bytes = Buffer.from(value, 'utf8');
    this.int(bytes.length);
    this.chunks.push(bytes);
  }

  /** `WriteOffset`: the flag, then the offset in `OFFSET_SIZE` bytes. */
  offset(flag: number, value = 0): void {
    const bytes = Buffer.alloc(1 + OFFSET_SIZE);
    bytes.writeUInt8(flag, 0);
    bytes.writeBigUInt64LE(BigInt(value), 1);
    this.chunks.push(bytes);
  }

  raw(bytes: Buffer): void {
    this.chunks.push(bytes);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** `SECTION_PRE_DATA`: what is created before the data is loaded. */
const SECTION_PRE_DATA = 2;

export interface CraftedEntry {
  /** What `pg_restore --list` calls it. */
  tag: string;
  /** The SQL that restoring this entry runs. */
  sql: string;
  /** The kind of entry it claims to be. Restored in full, whatever it is. */
  kind?: string;
}

/** An archive whose entries run `entries`, in order, each in the transaction of the restore. */
export function craftDump(entries: readonly CraftedEntry[]): Buffer {
  const out = new ArchiveBytes();
  out.raw(Buffer.from('PGDMP'));
  out.byte(1); // major
  out.byte(14); // minor: 1.14, the last before the compression algorithm byte
  out.byte(0); // revision
  out.byte(INT_SIZE);
  out.byte(OFFSET_SIZE);
  out.byte(1); // archCustom
  out.int(0); // compression: none
  const now = new Date();
  for (const part of [
    now.getSeconds(),
    now.getMinutes(),
    now.getHours(),
    now.getDate(),
    now.getMonth(),
    now.getFullYear() - 1900,
    0,
  ]) {
    out.int(part);
  }
  out.text('crafted');
  out.text('17.0');
  out.text('17.0');
  out.int(entries.length);
  entries.forEach((entry, index) => {
    out.int(index + 1); // dump id
    out.int(0); // no data dumper
    out.text('0'); // table oid
    out.text('0'); // oid
    out.text(entry.tag);
    out.text(entry.kind ?? 'TABLE');
    out.int(SECTION_PRE_DATA);
    out.text(entry.sql.endsWith('\n') ? entry.sql : `${entry.sql}\n`);
    out.text(''); // drop statement
    out.text(''); // copy statement
    out.text(''); // namespace
    out.text(null); // tablespace: the default one
    out.text(null); // table access method: the default one
    out.text(''); // owner
    out.text('false'); // with OIDs
    out.text(null); // no dependencies
    out.offset(OFFSET_NO_DATA);
  });
  return out.build();
}
