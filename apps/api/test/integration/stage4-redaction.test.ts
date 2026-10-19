import type { DownloadLinkResponse, ExportRequestDto, InvoiceDto } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createBillingExportJob } from '../../src/modules/billing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
import { captureLogs } from '../../src/testing/log-capture.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { runPending } from '../support/jobs.js';

/**
 * What Stage 4 never writes down (tasks 4.62; BIL-15, INV-12): card numbers, certificates, private
 * keys and download links. The whole application runs at the most talkative log level while a
 * person pays by card, loads the fiscal certificate, issues and credits a voucher, and downloads
 * the PDF and an export; then the log, the answers and the audit trail are searched for what must
 * not be there.
 */

/** Card numbers in the spellings people type them (13 to 19 digits, with spaces or dashes). */
const CARD_NUMBERS = ['4111111111111111', '4111 1111 1111 1111', '5500-0000-0000-0004'];
const digitsOf = (text: string) => text.replace(/[\s-]/g, '');

const logs = captureLogs();
const CUIT = '20-12345678-6';
let runtime: DbHandle;
let world: InvoicingWorld;
let certificate: { certificate: string; privateKey: string };
const tokens: string[] = [];

/** The lines of a PEM block that carry key material (the headers say nothing, the body is the secret). */
const bodyLines = (pem: string) =>
  pem.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----'));

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, {
    slug: 'stage4-redaction',
    app: { logLevel: 'trace', logStream: logs.stream },
  });
  await world.openRegister();
  certificate = generateDevCertificate({ cuit: CUIT.replaceAll('-', ''), algorithm: 'ec' });
}, 120_000);

afterAll(async () => {
  await world.close();
  await runtime.close();
});

describe('a card number', () => {
  it.each(CARD_NUMBERS)(
    'is refused as a voucher reference (%s) and appears nowhere',
    async (pan) => {
      const charge = await world.charge();

      const response = await world.pay(charge.id, {
        method: 'credit',
        amountCents: 100_000,
        externalRef: pan,
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(digitsOf(response.body)).not.toContain(digitsOf(pan));
      expect(digitsOf(logs.raw())).not.toContain(digitsOf(pan));
      // Nothing was recorded for the charge, and the table cannot hold a number like this one.
      expect((await world.chargeOf(charge.id)).payments).toEqual([]);
    },
  );

  // A reason or a description is text a person typed and is kept as typed (the audit trail of a
  // void shows its reason): only the voucher reference is checked for card numbers. What this test
  // holds is the log, which never carries a request body.
  it('is never written to the log when it travels in a field the product does not inspect', async () => {
    const charge = await world.charge();

    const added = await world.api.post(`/billing/charges/${charge.id}/lines`, world.owner, {
      description: 'Pago con tarjeta 4012888888881881 vencimiento 12/29',
      amountCents: 100,
    });
    const voided = await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Tarjeta 378282246310005 rechazada',
    });

    expect([added.statusCode, voided.statusCode]).toEqual([201, 200]);
    const raw = logs.raw();
    expect(raw).not.toContain('4012888888881881');
    expect(raw).not.toContain('378282246310005');
    expect(raw).not.toContain('vencimiento 12/29');
  });

  it('is no problem as part of a longer reference, which is what a voucher number looks like', async () => {
    const charge = await world.charge();

    const ok = await world.pay(charge.id, {
      method: 'debit',
      amountCents: 100_000,
      externalRef: 'LOTE 0042 CUPON 118',
    });

    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ payment: { externalRef: string } }>().payment.externalRef).toBe(
      'LOTE 0042 CUPON 118',
    );
  });
});

describe('the fiscal certificate and its private key', () => {
  it('are accepted, refused and replaced without a single line of them in the log or the answers', async () => {
    const accepted = await world.api.put('/invoicing/credentials', world.owner, {
      certificate: certificate.certificate,
      privateKey: certificate.privateKey,
    });
    const swapped = await world.api.put('/invoicing/credentials', world.owner, {
      certificate: certificate.certificate,
      privateKey: 'not a key at all',
    });
    const other = generateDevCertificate({ cuit: '30712345671', algorithm: 'ec' });
    const wrongCuit = await world.api.put('/invoicing/credentials', world.owner, {
      certificate: other.certificate,
      privateKey: other.privateKey,
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(swapped.statusCode).toBe(400);
    expect(wrongCuit.statusCode).toBe(400);
    const raw = logs.raw();
    const answers = [accepted, swapped, wrongCuit].map((response) => response.body).join('\n');
    for (const secret of [
      ...bodyLines(certificate.privateKey),
      ...bodyLines(certificate.certificate),
      ...bodyLines(other.privateKey),
      'not a key at all',
    ]) {
      expect(raw, 'the log').not.toContain(secret);
      expect(answers, 'the answers').not.toContain(secret);
    }
    expect(raw).not.toContain('BEGIN');
    expect(answers).not.toContain('BEGIN');
  });

  it('are never part of the configuration the screen reads back', async () => {
    const config = await world.api.get('/invoicing/config', world.owner);

    expect(config.statusCode).toBe(200);
    expect(config.body).not.toContain('BEGIN');
    for (const secret of bodyLines(certificate.privateKey))
      expect(config.body).not.toContain(secret);
    expect(JSON.parse(config.body)).toMatchObject({
      credential: { fingerprint: expect.any(String) as string },
    });
  });
});

describe('a voucher, its PDF and an export', () => {
  let invoice: InvoiceDto;

  beforeAll(async () => {
    const charge = await world.charge();
    const paid = await world.pay(charge.id, { method: 'cash', amountCents: 1_000_000 });
    expect(paid.statusCode, paid.body).toBe(201);
    invoice = await world.issueInvoiceOf(charge);
    const note = await world.creditNote(invoice.id, { amountCents: 500_000 });
    expect(note.statusCode, note.body).toBe(202);
    await world.runIssue();
    await world.runDocuments();
  }, 60_000);

  it('hand out links for one use whose token the log never sees', async () => {
    const link = await world.api.get(`/invoices/${invoice.id}/pdf-link`, world.owner);
    expect(link.statusCode, link.body).toBe(200);
    const pdfUrl = link.json<DownloadLinkResponse>().url;
    tokens.push(pdfUrl.split('/').pop() ?? '');
    expect((await world.api.get(pdfUrl, world.owner)).statusCode).toBe(200);

    const exported = await world.api.post('/billing/exports', world.owner, {
      kind: 'payments',
      format: 'csv',
      from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    });
    expect(exported.statusCode, exported.body).toBe(202);
    await runPending(runtime.db, world.recorded, [
      createBillingExportJob({ storage: world.storage }),
    ]);
    const download = await world.api.post(
      `/billing/exports/${exported.json<ExportRequestDto>().id}/download`,
      world.owner,
    );
    expect(download.statusCode, download.body).toBe(200);
    const exportUrl = download.json<DownloadLinkResponse>().url;
    tokens.push(exportUrl.split('/').pop() ?? '');
    expect((await world.api.get(exportUrl, world.owner)).statusCode).toBe(200);

    expect(tokens.every((token) => token.length >= 40)).toBe(true);
    for (const token of tokens) expect(logs.raw()).not.toContain(token);
    // The route is logged, so a download is still traceable without its secret.
    expect(logs.raw()).toContain('/files/:token');
  });

  it('keep the key and the card numbers out of the audit trail of the whole journey', async () => {
    const rows = await world.inTenant((tx) => tx.select().from(auditEvent));
    const actions = new Set(rows.map((row) => row.action));
    const trail = JSON.stringify(rows);

    for (const action of [
      'payment.recorded',
      'invoice.requested',
      'invoice.credit_note',
      'invoicing.credential.changed',
      'export.requested',
    ]) {
      expect(actions, `no ${action} entry in the trail`).toContain(action);
    }
    expect(trail.includes('BEGIN'), 'a PEM block is in the trail').toBe(false);
    for (const secret of bodyLines(certificate.privateKey)) {
      expect(trail.includes(secret), 'key material is in the trail').toBe(false);
    }
    for (const pan of CARD_NUMBERS) {
      expect(digitsOf(trail).includes(digitsOf(pan)), `${pan} is in the trail`).toBe(false);
    }
    for (const token of tokens) expect(trail.includes(token), 'a link is in the trail').toBe(false);
  });

  it('left a log that is not empty, so the searches above were looking at something', () => {
    const lines = logs.lines();

    // A canary: whatever the application logs is in the capture, so absence above means something.
    world.app.log.info({ canary: 'canary-4d-7731' }, 'canary');

    expect(logs.raw()).toContain('canary-4d-7731');
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.some((line) => typeof line['reqId'] === 'string')).toBe(true);
  });
});
