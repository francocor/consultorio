import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AppError } from '../../platform/http/problem.js';

import { CHECKOUT_CONTENT_SECURITY_POLICY, renderCheckoutPage } from './checkout-page.js';
import { deliver, paymentNotices, preapprovalNotice, type Notice } from './notices.js';

import type { CheckoutChoice, LocalPaymentsControls, LocalPaymentsGateway } from './index.js';

/**
 * The hosted page of the local Mercado Pago (`/local-providers/mercadopago/checkout/:id`), where the
 * payer authorizes a preapproval or pays a link. It is registered only while the provider console is
 * on (`LOCAL_PROVIDERS_CONSOLE`), and the prefix is the one the auth guard leaves open for the
 * simulators. What the payer decides is signed and posted to the application's own webhook, then the
 * payer is sent back to the address the subscription gave (`back_url`), with the outcome in `mp`.
 *
 * The page is public and moves no money; it only changes the state of the simulator, so the route is
 * of the `webhook` category: it keeps working when the organization is read-only, because paying is
 * how it recovers.
 */

const Params = z.strictObject({ id: z.string().min(1).max(80) });
const CHOICES = ['approve', 'reject', 'pending', 'abandon'] as const;

export interface CheckoutRoutesDeps {
  controls: LocalPaymentsControls;
  gateway: Pick<LocalPaymentsGateway, 'sign'>;
}

const OUTCOME_OF: Record<CheckoutChoice, string> = {
  approve: 'approved',
  reject: 'rejected',
  pending: 'pending',
  abandon: 'abandoned',
};

export function checkoutRoutes(deps: CheckoutRoutesDeps) {
  return (app: FastifyInstance): void => {
    // A child scope, so the form parser applies to this page only.
    void app.register((scope, _options, done) => {
      scope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 1024 },
        (_request, body, next) => {
          const value = new URLSearchParams(typeof body === 'string' ? body : '').get('choice');
          next(null, { choice: value });
        },
      );
      const page = '/local-providers/mercadopago/checkout/:id';

      scope.get(page, { config: { auth: 'public', readOnly: 'read' } }, async (request, reply) => {
        const { id } = Params.parse(request.params);
        const resource = await deps.controls.hostedResource(id);
        if (!resource) throw new AppError('not_found');
        const state =
          resource.kind === 'preapproval'
            ? resource.awaitingPayer
              ? 'open'
              : resource.status === 'cancelled'
                ? 'cancelled'
                : 'done'
            : resource.expired
              ? 'expired'
              : 'open';
        return reply
          .header('content-security-policy', CHECKOUT_CONTENT_SECURITY_POLICY)
          .header('x-robots-tag', 'noindex, nofollow')
          .header('referrer-policy', 'same-origin')
          .type('text/html; charset=utf-8')
          .send(
            renderCheckoutPage({
              kind: resource.kind,
              amountCents: resource.amountCents,
              ...(resource.kind === 'link' ? { title: resource.title } : {}),
              state,
            }),
          );
      });

      scope.post(
        page,
        {
          config: {
            auth: 'public',
            readOnly: 'webhook',
            audits: 'none',
            rateLimit: { max: 60, timeWindow: 60_000 },
          },
        },
        async (request, reply) => {
          const { id } = Params.parse(request.params);
          const raw = (request.body as { choice?: unknown } | null | undefined)?.choice;
          const choice = CHOICES.find((candidate) => candidate === raw);
          if (!choice) throw new AppError('bad_request');
          const resource = await deps.controls.hostedResource(id);
          if (!resource) throw new AppError('not_found');

          const notices: Notice[] = [];
          if (resource.kind === 'preapproval') {
            const decided = await deps.controls.decidePreapproval(id, choice);
            if (decided?.notify) notices.push(preapprovalNotice(decided.notify));
          } else {
            const decided = await deps.controls.decideLink(id, choice);
            if (decided?.paymentId) notices.push(...paymentNotices(decided.paymentId));
          }
          if (notices.length > 0) {
            await deliver(request.server, deps.gateway, await deps.controls.mode(), notices);
          }

          const back = new URL(resource.backUrl);
          back.searchParams.set('mp', OUTCOME_OF[choice]);
          return reply.redirect(back.toString(), 303);
        },
      );
      done();
    });
  };
}
