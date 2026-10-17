import {
  ScannerUnavailableError,
  type MalwareScanner,
  type ScanInput,
  type ScanVerdict,
} from '../../platform/scanning/malware-scanner.js';

/** The marker inside the EICAR test string. Written without the whole string, see test-files. */
const EICAR_MARKER = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

export interface FakeScanner extends MalwareScanner {
  /** Simulates an outage: while false, `scan` fails closed like the real adapter does. */
  setAvailable(available: boolean): void;
  /** How many scans produced a verdict. */
  scans(): number;
}

async function containsMarker(content: ScanInput): Promise<boolean> {
  if (Buffer.isBuffer(content)) return content.includes(EICAR_MARKER);
  // A marker split across two chunks must still be found: keep a tail as long as the marker.
  let tail = Buffer.alloc(0);
  for await (const part of content) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : (part as Buffer);
    const window = Buffer.concat([tail, bytes]);
    if (window.includes(EICAR_MARKER)) return true;
    tail = window.subarray(Math.max(0, window.length - EICAR_MARKER.length));
  }
  return false;
}

/**
 * The fake of the `MalwareScanner` port (design section 6): flags the EICAR test string and passes
 * everything else. Used by tests and by the demo organization, never by a production deployment
 * (the configuration refuses to start without a real scanner there).
 */
export function createFakeScanner(): FakeScanner {
  let available = true;
  let count = 0;

  return {
    async scan(content): Promise<ScanVerdict> {
      if (!available) throw new ScannerUnavailableError('the fake scanner is switched off');
      const infected = await containsMarker(content);
      count += 1;
      return infected
        ? { status: 'infected', signature: 'Eicar-Test-Signature' }
        : { status: 'clean' };
    },
    setAvailable(next) {
      available = next;
    },
    scans: () => count,
  };
}
