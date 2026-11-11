import { connect, type Socket } from 'node:net';

import {
  ScannerUnavailableError,
  type MalwareScanner,
  type ScanInput,
  type ScanVerdict,
} from '../../platform/scanning/malware-scanner.js';

export interface ClamdConfig {
  host: string;
  port: number;
  /** Time to open the connection. */
  connectTimeoutMs?: number;
  /** Longest silence on the connection, reading or writing, before the scan is abandoned. */
  idleTimeoutMs?: number;
  /** Longest a whole scan may take. */
  totalTimeoutMs?: number;
  /** Size of the pieces the content is sent in (clamd accepts up to its `StreamMaxLength` in total). */
  chunkBytes?: number;
}

const DEFAULTS = {
  connectTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  chunkBytes: 64 * 1024,
};

/** `z` makes clamd treat NUL as the line terminator, which is unambiguous in a binary protocol. */
const INSTREAM = Buffer.from('zINSTREAM\0', 'latin1');
const END_OF_STREAM = Buffer.alloc(4);
const MAX_REPLY_BYTES = 4096;

function lengthPrefix(size: number): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(size, 0);
  return prefix;
}

/** Splits whatever is scanned into pieces of at most `size` bytes. */
async function* pieces(content: ScanInput, size: number): AsyncGenerator<Buffer> {
  const source: AsyncIterable<Buffer | string> | Buffer[] = Buffer.isBuffer(content)
    ? [content]
    : content;
  for await (const part of source) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
  }
}

function connected(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ScannerUnavailableError('connection timed out'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new ScannerUnavailableError('connection failed', { cause: error }));
    });
  });
}

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) reject(new ScannerUnavailableError('connection lost', { cause: error }));
      else resolve();
    });
  });
}

/** Resolves with the reply line (up to the NUL) or rejects when the connection ends without one. */
function reply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      received = Buffer.concat([received, data]);
      const end = received.indexOf(0);
      if (end !== -1) resolve(received.subarray(0, end).toString('latin1').trim());
      else if (received.length > MAX_REPLY_BYTES) {
        reject(new ScannerUnavailableError('reply too long'));
      }
    });
    socket.once('timeout', () => {
      reject(new ScannerUnavailableError('no activity within the time limit'));
    });
    socket.once('error', (error) => {
      reject(new ScannerUnavailableError('connection lost', { cause: error }));
    });
    socket.once('close', () => {
      reject(new ScannerUnavailableError('connection closed without a reply'));
    });
  });
}

/** `stream: OK` is clean, `stream: <name> FOUND` is infected; anything else is no verdict. */
function verdictOf(line: string): ScanVerdict {
  if (line === 'stream: OK') return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found?.[1] !== undefined) return { status: 'infected', signature: found[1] };
  throw new ScannerUnavailableError('the scanner did not return a verdict');
}

/**
 * ClamAV `clamd` over TCP with the INSTREAM command. Every failure that is not a verdict becomes a
 * `ScannerUnavailableError`, so the caller fails closed. No error carries the content or the reply.
 */
export function createClamdScanner(config: ClamdConfig): MalwareScanner {
  const options = { ...DEFAULTS, ...config };

  return {
    async scan(content) {
      const socket = connect({ host: options.host, port: options.port });
      socket.setNoDelay(true);
      const total = setTimeout(() => {
        socket.destroy();
      }, options.totalTimeoutMs);
      try {
        await connected(socket, options.connectTimeoutMs);
        socket.setTimeout(options.idleTimeoutMs);
        const answer = reply(socket);
        // A failure while sending also rejects `answer`; this keeps that from being unhandled
        // before it is awaited below.
        answer.catch(() => undefined);

        await write(socket, INSTREAM);
        try {
          for await (const piece of pieces(content, options.chunkBytes)) {
            await write(socket, Buffer.concat([lengthPrefix(piece.length), piece]));
          }
        } catch (error) {
          if (error instanceof ScannerUnavailableError) throw error;
          throw new ScannerUnavailableError('the content could not be read', { cause: error });
        }
        await write(socket, END_OF_STREAM);
        return verdictOf(await answer);
      } catch (error) {
        throw error instanceof ScannerUnavailableError
          ? error
          : new ScannerUnavailableError('scan failed', { cause: error });
      } finally {
        clearTimeout(total);
        socket.destroy();
      }
    },
  };
}
