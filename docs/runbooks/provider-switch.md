# Runbook: switching a provider from the local adapter to the real one

Audience: whoever deploys. Scope: how the product chooses which provider serves an organization, how to
move one provider at a time from its local adapter to the real one, and how to go back. Task 6.46. The
accounts and contracts each real adapter needs are in `docs/go-live-checklist.md`; the one with the most
detail is `docs/runbooks/afip-switch-to-real.md`.

## How a provider is chosen

Every outside service the product calls (email, WhatsApp, video, the bot challenge, the tax authority,
the e-prescription platform, the payments gateway, the archive store, the key service) is a **port** with
a contract suite. Two things decide which adapter serves an organization:

1. **The setting of the deployment**, one variable per provider (`WHATSAPP_PROVIDER`, `VIDEO_PROVIDER`,
   `BOT_CHALLENGE`, `AFIP_PROVIDER`, `ERX_PROVIDER`, `PAYMENTS_PROVIDER`, `ARCHIVE_*`, `KMS_PROVIDER`,
   `SMTP_*`). Outside production the default is the local adapter; in production the default is `off`
   (or the real one for the bot challenge), and a local adapter needs `ALLOW_LOCAL_PROVIDERS=true`, which
   a deployment that serves patients must not set.
2. **The kind of organization.** A demonstration organization is always served by the fake, whatever the
   setting says; the resolver refuses to start if a demo slot holds anything that is not a fake. A real
   organization is served by the adapter the deployment selects.

So switching a provider changes what real organizations use and never what the demo uses.

## The order of a switch

Do one provider at a time, in staging first, and write down the date.

1. **Get what the real adapter needs** (the checklist names it: an account, a certificate, a contract)
   and put the secrets in the secret store of the deployment, never in the repository or the image.
2. **Run the contract suite against the real adapter** (the file named in the checklist). It is the same
   suite the local adapter passes; a difference is a defect of the adapter, not a reason to relax the
   suite. Where the plan asks for a recorded-fixture test or a staging-only test, run that too.
3. **Set the variable in staging** and restart the API and the worker (both read it at start). Check
   that the boot log shows the real adapter and that the screens no longer say "simulated" (the banner
   is driven by the adapter, not by a label).
4. **Rehearse the journey** that uses the provider with a test organization: send the reminder, issue
   the invoice, authorize the payment. Look at what the provider's own console shows.
5. **Set it in production** for one organization if the provider allows it (the invoicing credentials
   are per organization), or for the deployment if it does not. Watch the alert dashboard for an hour
   (`docs/runbooks/incident.md`).

## Going back

Set the variable back (`off` in production, `local` in staging) and restart. What was written while the
real adapter was in use stays: invoices that were issued are issued, subscriptions that exist keep their
state, objects in the archive stay archived. Nothing is deleted by switching. For the payments gateway
the subscription of an organization remembers the identifiers the provider gave; with the gateway `off`
nobody can subscribe or change a plan, and the dates keep counting, but no state moves because of a
missing confirmation.

## What each switch touches

| Provider                | Changes for the users                                                           | Watch                                                             |
| ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Email                   | Real messages leave: reminders, invitations, statements, the notices of dunning | `messages_last_day{status="failed"}`, bounces and complaints      |
| WhatsApp                | Messages go through the Cloud API with approved templates, counted for quota    | `ReminderFailureRateHigh`, `template_rejected`                    |
| Video                   | Rooms are made by the video service with recording disabled                     | Join failures reported by professionals                           |
| Bot challenge           | The public forms ask Turnstile, not the local proof of work                     | `booking_suspicious_total`, abandoned bookings                    |
| Tax authority (ARCA)    | Invoices have fiscal validity                                                   | `invoices_pending_past_threshold`, `docs/runbooks/afip-outage.md` |
| E-prescription          | Prescriptions are registered with the authorized platform                       | Prescriptions in `failed` or waiting                              |
| Payments (Mercado Pago) | Subscriptions charge real cards; the webhook is signed with the real secret     | The operator view of subscriptions, duplicate payments flagged    |
| Archive store           | Archived objects go to the object-lock bucket of the cloud account              | `docs/runbooks/archive-release.md`, the verification of each week |
| Key service             | Clinical fields are encrypted with the KMS key                                  | The restore drill opens a restored copy with it                   |

## Never

- Never point a real organization at a local adapter to "keep things going": a local adapter does not
  send, bill or issue anything, and its screens would lie by silence.
- Never reuse the secret of a webhook between staging and production.
- Never switch two providers in one deployment: when something breaks you will not know which.
