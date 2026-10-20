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
