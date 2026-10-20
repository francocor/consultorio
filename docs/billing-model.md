# How the platform bills an organization

This page is the model behind the subscription of an organization (Stage 6, `modules/subscriptions`). The owner sees the same rules in the product: the definition of an active professional, the proration and the dates. Amounts are whole cents of Argentine pesos (ARS); there is no float anywhere.

## Who counts: the active professional

An organization pays **per active professional per month**. A member counts on a given day when all of these were true on that day:

1. the membership is `active` (not deactivated);
2. the membership holds the `professional` role;
3. the professional profile is `active` (an enabled profile).

Reception and administration seats are **free and unlimited**. An owner or an admin who is not also a professional does not count; an owner who is also a professional does. The same function (`domain/active-professional.ts`) decides the price, the plan limit and the WhatsApp quota, so they can never disagree. A professional who is deactivated keeps every record: the count only decides the price.

## The calendar

A billing period is a **calendar month** and a day is a day of that month, in the zone `America/Argentina/Buenos_Aires` for every organization (`domain/periods.ts`). One zone for the whole platform, so a statement, a quota and a proration never disagree about where a month starts.

## Proration

The monthly price is split over the days of the period, a day at a time. A professional who is active `k` of the `D` days of the period pays that share of the price, in whole cents (`domain/proration.ts`). The split uses the allocation of money (largest remainder, ties to the earliest part), so the days a professional was active and the days they were not always add up to the price of the period, **to the cent**, however the days are cut.

Example, price ARS 18.000,00 and a period of 31 days: 12 active days cost ARS 6.967,74 and the other 19 days ARS 11.032,26; together ARS 18.000,00.

When the owner invites or activates a professional, the product first shows the price change and this proration for the rest of the current period, and applies it only after the owner confirms. The server enforces the plan limit whatever the screen showed: a professional beyond the limit of the plan is refused with an offer to change plan.

## Plans and limits

A plan is configuration, not code (`plan` and `plan_entitlement`, platform tables the operator maintains): the price per active professional, the most active professionals, the WhatsApp quota of each professional (200 by default), the price of an extra message, the default and the platform maximum of the overage cap, and the lengths of the trial (14 days) and of the grace (7 days). The server enforces those fields. Actions that protect a patient or the custody of the records (reading, exporting, rectifying) are never blocked by a limit.

The seats that count against the limit are the active professionals plus the invitations to be one that are still open.

## The states of a subscription

`trial` (14 days) -> `active` (the provider confirmed the authorization or an approved payment) -> `past_due` (a payment failed, or the trial ended unpaid: the grace of 7 days, all functions available) -> `read_only` (the grace ended with no payment) -> `active` again when the provider confirms a payment that settles the debt. The owner cancels -> `cancelling` (full service until the end of the paid period) -> `cancelled`. `tenant.status` is derived: `read_only` follows `read_only`, `cancelled` follows `cancelled`, every other state keeps the organization active.

A state changes only because the **provider confirmed something**, a **date** arrived or the **owner** asked. The absence of a confirmation (an outage, a timeout, an answer nobody knows) is not an event and changes nothing: a provider that is down never advances a dunning, cancels a subscription or makes an organization read-only (`domain/subscription-state.ts`, with its table repeated in the database as a backstop).

An exempt organization (a demo, or a deployment that bills outside the platform) has no subscription: no trial, no grace, no dunning, no limit and no read-only state for billing reasons.

## What is metered

Two counts, both counts only (no message text, no patient):

- **Days of activity.** The job `usage.snapshot` runs every hour and writes one row per active professional and billing day (`usage_record`, kind `active_professional_day`), once, however often it runs. A professional deactivated mid-period stops being recorded from that day. It is the record the statement prorates by.
- **Accepted WhatsApp messages.** `whatsapp_usage_event` is the count of the notifications module: a message counts when the provider ACCEPTS it, once, against the professional of the appointment; a refusal and an email cost nothing. The snapshot rolls it up per professional and period (`usage_record`, kind `whatsapp_messages`) for the operator, and a single-tenant deployment with billing off keeps being metered the same way (`GET /operator/usage?tenantId=` shows days and messages per professional and period).

## The quota and the overage

Each active professional has the quota of the plan (200 messages a month by default), **prorated by the days they were active**, the trial included: a professional active 10 of 31 days has 65 of 200. A professional who is active now is counted for the rest of the month, so the quota does not shrink in the first days. Unused quota does not carry over.

Messages beyond the quota are **overage**, billed at the price of the plan, **while the cap of the organization allows it**. The cap is a number of overage messages per month for the whole organization: 0 turns overage off, the plan sets a maximum, and it is never unlimited (`PATCH /subscription/overage-cap`, audited as `subscription.cap_changed`). There is no overage during the trial. When overage is off or the cap is reached the message goes by email (when the patient has one) and the owner is told once for the month. The decision is taken under an advisory lock of the organization and the month, so two messages prepared at the same moment cannot both take the last place of the cap.

## The statement

At the close of every month the job `statement.generate` writes **one statement per period** (`statement`): the professionals counted, the days and the price of each one (prorated, the trial days are free), the overage messages and the total, in whole cents. Each overage line lists the ids of the counted events it bills, so a disputed line can be traced without exposing any message. The statement is published to the owner in the product (list, detail, PDF) and by email, and **its figures never change** (a database trigger refuses it).

## When a statement is collected

The recurring charge of the provider is always an amount the owner has seen: the amount shown at checkout, or the total of a published statement. The platform never raises it above what a published statement shows, and never before the owner had `STATEMENT_COLLECTION_DELAY_DAYS` (3) days to see it:

1. Once the window of the oldest unpaid statement has passed, the preapproval is updated to what is left of it (a write with its mark committed before the call, a bounded call and an answer in another transaction, like every write to the provider).
2. If the provider refuses to change the amount of a live authorization (`amount_change_refused`), the difference is asked as a one-off payment link, and the owner is emailed and finds the link next to the statement. If the amount would have to go down and the provider will not lower it, the subscription is parked for a person instead of charging more than is owed.
3. If the provider wants the payer to authorize the new amount again (`reauthorization_required`), the owner is asked first and nothing is charged for the difference.
4. What the provider charges is booked against the statements: a charge counts toward the oldest statement whose window had passed when the charge was made, and a link made for a statement counts toward that statement. What is booked is never above the total, and the database refuses a write to the provider for a statement before its window or above what is left (`app.subscription_attempt_statement_guard`, `statement_window_check`).

A statement is collected one month in arrears: the charge that lands in month `M + 1` pays the statement of month `M` and credits the coverage of `M + 1`. The first charge, made at the end of the trial, is the amount shown at checkout.

## What this model does not do

- It does not backfill a day the worker missed: the snapshot is hourly, and a professional active and deactivated within the same hour is not recorded.
- A message accepted by the provider after the statement of its month was written is not billed (the late acceptance of a delivery report does not reopen a published statement).
- The recurring amount the provider charges on its own schedule before the window of a statement has passed is the previous amount; it is booked against no statement.
