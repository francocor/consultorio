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
  return {
    local,
    controls,
    gateway: local,
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
