import {
  createFakePaymentsGateway,
  type FakePaymentsGateway,
} from '../../src/adapters/mercadopago-fake/index.js';
import {
  createLocalPaymentsControls,
  createLocalPaymentsGateway,
  type LocalPaymentsControls,
  type LocalPaymentsGateway,
} from '../../src/adapters/mercadopago-local/index.js';
import type {
  GatewayMode,
  PaymentsGatewayHarness,
} from '../../src/adapters/payments-gateway.contract.js';
import type { DbHandle } from '../../src/platform/db/pool.js';

/**
 * The payments providers of the tests, in the shape the contract suite drives them (a harness): the
 * in-memory fake, which can hold a request in flight, and the local Mercado Pago on Postgres, which
 * serves the hosted page. Both read the clock of the test, so the window of a notice is the one of the
 * world.
 */

export interface FakeHarness extends PaymentsGatewayHarness {
  fake: FakePaymentsGateway;
}

export function fakeHarness(options: {
  clock: { now: Date };
  idempotent?: boolean;
  settleWindowMs?: number;
}): FakeHarness {
  const fake = createFakePaymentsGateway({
    idempotent: options.idempotent ?? false,
    clock: () => options.clock.now,
    ...(options.settleWindowMs === undefined ? {} : { settleWindowMs: options.settleWindowMs }),
  });
  return {
    fake,
    gateway: fake,
    secret: fake.secret,
    now: () => options.clock.now,
    setMode: (mode: GatewayMode) => {
      fake.setMode(mode);
      return Promise.resolve();
    },
    authorize: (id) => {
      fake.authorize(id);
      return Promise.resolve();
    },
    chargeCycle: (id, outcome) => {
      fake.chargeCycle(id, outcome);
      return Promise.resolve();
    },
    payLink: (id) => {
      fake.payLink(id);
      return Promise.resolve();
    },
    sign: (body, ts) => Promise.resolve(fake.sign(body, ts)),
    hold: (holdOptions) => fake.hold(holdOptions),
  };
}

type WriteMethod =
  | 'createPreapproval'
  | 'updatePreapprovalAmount'
  | 'cancelPreapproval'
  | 'createPaymentLink'
  | 'refund';
const WRITES: readonly WriteMethod[] = [
  'createPreapproval',
  'updatePreapprovalAmount',
  'cancelPreapproval',
  'createPaymentLink',
  'refund',
];

/**
 * Lets a test hold the writes of the local provider in flight, as the in-memory fake can: the request
 * is waiting inside the provider when the caller gives up, and lands (when the hold allows it) after.
 * Only the writes wait; every read answers at once (JD-S6 R1, B-S: the contract suite runs its
 * in-flight cases against this adapter too).
 */
function holdable(local: LocalPaymentsGateway): {
  gateway: LocalPaymentsGateway;
  hold: NonNullable<PaymentsGatewayHarness['hold']>;
} {
  let held: { gate: Promise<void>; completeLate: boolean; enter: () => void } | null = null;
  const gateway = Object.create(local) as LocalPaymentsGateway;
  for (const method of WRITES) {
    const original = (local[method] as (...args: unknown[]) => Promise<unknown>).bind(local);
    (gateway as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const current = held;
      if (!current) return original(...args);
      current.enter();
      const signal =
        args[args.length - 1] instanceof AbortSignal
          ? (args[args.length - 1] as AbortSignal)
          : undefined;
      if (!signal) {
        await current.gate;
        return original(...args);
      }
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('The call was aborted.', 'AbortError'));
          return;
        }
        const onAbort = () => {
          reject(new DOMException('The call was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void current.gate.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      }).catch((error: unknown) => {
        // The request is already inside the provider: it lands at the release even though nobody waits.
        if (current.completeLate) {
          void current.gate.then(() => original(...args.slice(0, -1)));
        }
        throw error;
      });
      return original(...args);
    };
  }
  return {
    gateway,
    hold(options = {}) {
      let release!: () => void;
      let enter!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      held = { gate, completeLate: options.completeLate === true, enter };
      return {
        release() {
          held = null;
          release();
        },
        entered,
      };
    },
  };
}

export interface LocalHarness extends PaymentsGatewayHarness {
  local: LocalPaymentsGateway;
  controls: LocalPaymentsControls;
}

export function localHarness(
  runtime: DbHandle,
  options: {
    clock: { now: Date };
    secret: string;
    idempotent?: boolean;
    hostedCheckout?: boolean;
    publicBaseUrl?: string;
  },
): LocalHarness {
  const clock = () => options.clock.now;
  const local = createLocalPaymentsGateway({
    db: runtime.db,
    webhookSecret: options.secret,
    publicBaseUrl: options.publicBaseUrl ?? 'https://platform.consultorio.test/api',
    idempotent: options.idempotent ?? false,
    hostedCheckout: options.hostedCheckout ?? true,
    clock,
  });
  const controls = createLocalPaymentsControls(runtime.db, { clock });
  const holdable_ = holdable(local);
  return {
    local,
    controls,
    gateway: holdable_.gateway,
    hold: holdable_.hold,
    secret: options.secret,
    now: clock,
    setMode: (mode: GatewayMode) => controls.setMode(mode),
    authorize: async (id) => {
      await controls.decidePreapproval(id, 'approve');
    },
    chargeCycle: async (id, outcome) => {
      await controls.charge(id, outcome);
    },
    payLink: async (id) => {
      await controls.decideLink(id, 'approve');
    },
    sign: (body, ts) => Promise.resolve(local.sign(body, ts)),
  };
}
