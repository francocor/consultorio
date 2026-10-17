import { createServer, type Server, type Socket } from 'node:net';

/**
 * A stand-in for `clamd` that speaks just enough of its protocol for tests: the `zINSTREAM`
 * command (chunks of a 4-byte big-endian length and data, closed by a zero length) answered with
 * `stream: OK`, `stream: <signature> FOUND` or an error. Tests choose the behaviour; production
 * code never imports this module.
 */
export type FakeClamdBehavior =
  /** Answers by content: the EICAR test string is FOUND, anything else is OK. */
  | 'scan'
  /** Reads everything and never answers. */
  | 'silent'
  /** Answers with an ERROR line. */
  | 'error'
  /** Closes the connection after the first chunk. */
  | 'hangup';

export interface FakeClamd {
  port: number;
  /** The payload of every INSTREAM command received, reassembled. */
  received: Buffer[];
  /** The size of every chunk received, in order, for every command. */
  chunkSizes: number[];
  setBehavior(behavior: FakeClamdBehavior): void;
  close(): Promise<void>;
}

const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
const COMMAND = Buffer.from('zINSTREAM\0', 'latin1');

export async function startFakeClamd(initial: FakeClamdBehavior = 'scan'): Promise<FakeClamd> {
  let behavior = initial;
  const received: Buffer[] = [];
  const chunkSizes: number[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let pending = Buffer.alloc(0);
    let commandSeen = false;
    const payload: Buffer[] = [];

    const reply = (line: string) => {
      socket.end(Buffer.from(`${line}\0`, 'latin1'));
    };

    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data]);
      if (!commandSeen) {
        if (pending.length < COMMAND.length) return;
        if (!pending.subarray(0, COMMAND.length).equals(COMMAND)) {
          reply('UNKNOWN COMMAND');
          return;
        }
        pending = pending.subarray(COMMAND.length);
        commandSeen = true;
      }
      for (;;) {
        if (pending.length < 4) return;
        const size = pending.readUInt32BE(0);
        if (size === 0) {
          const whole = Buffer.concat(payload);
          received.push(whole);
          if (behavior === 'silent') return;
          if (behavior === 'error') {
            reply('INSTREAM size limit exceeded. ERROR');
          } else if (whole.includes(EICAR_MARKER)) {
            reply('stream: Eicar-Test-Signature FOUND');
          } else {
            reply('stream: OK');
          }
          return;
        }
        if (pending.length < 4 + size) return;
        payload.push(pending.subarray(4, 4 + size));
        chunkSizes.push(size);
        pending = pending.subarray(4 + size);
        if (behavior === 'hangup') {
          socket.destroy();
          return;
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake clamd has no port');

  return {
    port: address.port,
    received,
    chunkSizes,
    setBehavior(next) {
      behavior = next;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
