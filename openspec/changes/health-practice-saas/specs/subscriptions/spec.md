# Delta for subscriptions

> Stage 6 (Growth). New capability. Billing of tenants by the platform: price per active professional per month, Mercado Pago payment, WhatsApp quotas with paid overage, plan limits, dunning and read-only transition.
> Commercial parameters (D6, binding): 14-day trial; 7-day grace period before read-only; WhatsApp quota of 200 messages per active professional per month, configurable per plan. Prices are plan configuration and are not specified here. The demo tenant is excluded from all subscription and trial logic.
> Left to sdd-design (per proposal): exact definition and proration of an "active professional". The requirements below constrain behavior without fixing that definition.
> Assumptions to confirm: (1) the WhatsApp quota applies per active professional and is not pooled across the tenant; (2) subscription management is restricted to the owner role; (3) the platform's own invoice to the tenant is out of scope here.

## Quick map

| Area | Requirements |
|---|---|
| Plan model | Pricing, active professional, free seats, plan limits and entitlement fields |
| Lifecycle states | trial, active, past due (grace), read-only, cancelling, cancelled |
| Billing | Mercado Pago subscription, billing cycle, webhooks, duplicates |
| Messaging | WhatsApp quota, usage visibility, overage |
| Failure path | Dunning, grace, read-only, recovery, Mercado Pago outage |
| Lifecycle | Trial, change, cancellation |
| Cross-cutting | Access, privacy, operator limits, single-tenant mode, audit, language |

## ADDED Requirements

### Requirement: Per-active-professional pricing

The tenant MUST be billed per active professional per month. Reception and administrative users MUST be free and unlimited and MUST NOT affect the price. The definition of "active professional" MUST be deterministic, documented in the product and shown to the tenant, and MUST be applied identically to billing, plan limits and the WhatsApp quota. A professional deactivated or added during a billing period MUST be charged according to a proration rule that is shown to the owner before they confirm the change. Prices MUST be in ARS.

#### Scenario: Reception and admin are free
- GIVEN a tenant with 2 active professionals, 4 reception users and 1 admin
- WHEN the monthly charge is calculated
- THEN only the 2 professionals MUST count toward the price

#### Scenario: Adding a professional shows the impact
- GIVEN an owner adding a third active professional
- WHEN they confirm the invitation or activation
- THEN the system MUST first show the price change and the proration for the current period
- AND MUST apply it only after the owner confirms

#### Scenario: Deactivating a professional
- GIVEN an active professional is deactivated mid-period
- WHEN the next charge is computed
- THEN the result MUST follow the displayed proration rule
- AND the professional's clinical records MUST remain accessible

### Requirement: Plan catalog and limits

The system MUST support one or more plans. Each plan is configuration, not code, and MUST define: the price per active professional, the maximum number of active professionals, the WhatsApp quota per active professional per month (200 by default), the overage price, the default overage cap, the platform maximum overage cap, the trial length (14 days by default) and the grace length (7 days by default). These plan and entitlement fields MUST be what the server enforces. Limits MUST be enforced on the server. When a limit would be exceeded the action MUST be blocked with an explanation and an upgrade path, except for actions that protect patient safety or legal custody. Reception and admin seats MUST NOT be limited.

#### Scenario: Exceeding the professional limit
- GIVEN a plan allowing 3 active professionals and 3 already active
- WHEN the owner activates a fourth
- THEN the system MUST refuse and offer a plan change

#### Scenario: Adding reception staff at the limit
- GIVEN the plan professional limit is reached
- WHEN the owner adds a reception user
- THEN the system MUST allow it

### Requirement: Tenant billing states

Every non-exempt tenant MUST be in exactly one billing state: **trial** (14 days from activation, by default), **active** (paid), **past due** (a payment failed or the trial ended unpaid; this is the 7-day grace period in which all functions remain available), **read-only** (grace expired without payment), **cancelling** (cancellation requested, service continues until the end of the paid period) and **cancelled** (period ended; export and retention archive per `tenancy`). Transitions MUST derive from provider-confirmed payment events and dates, never from the absence of a confirmation (see the outage requirement). The current state, its dates and the date of the next transition MUST be visible to the owner.

#### Scenario: Trial to past due
- GIVEN a tenant in trial whose 14 days ended with no subscription
- WHEN the end date passes
- THEN the tenant becomes "past due" with a 7-day grace period
- AND the owner is notified of the date it becomes read-only

#### Scenario: Past due to read-only
- GIVEN a tenant "past due" whose 7-day grace ended with no payment
- WHEN the date passes
- THEN the tenant becomes "read-only"

#### Scenario: Recovery
- GIVEN a "read-only" or "past due" tenant
- WHEN the provider confirms a payment that settles the debt
- THEN the tenant returns to "active"

### Requirement: Exempt tenants

A tenant flagged as demo (`demo-tenant`) MUST be excluded from subscription logic: it has no trial, no grace, no dunning, no plan limits, no billing notices and MUST NEVER become read-only for billing reasons. A single-tenant deployment with subscription billing disabled is exempt in the same way (see below).

#### Scenario: Demo tenant never expires
- GIVEN a demo tenant created more than 14 days ago
- WHEN a user opens the app
- THEN there is no trial banner, no limit and no read-only state

### Requirement: Mercado Pago subscription

The owner MUST be able to start a subscription via Mercado Pago and authorize recurring payment. The system MUST NOT store card numbers or sensitive payment credentials. A subscription MUST be confirmed only after the payment provider reports authorization, and the tenant's billing state MUST derive from provider-confirmed events. The owner MUST be able to see the current plan, the next charge date, the amount, and the payment method label provided by the provider.

#### Scenario: Subscription authorized
- GIVEN an owner completes the Mercado Pago authorization
- WHEN the provider confirms it
- THEN the subscription MUST become "active" and the next charge date MUST be shown

#### Scenario: Owner abandons authorization
- GIVEN the owner closes the payment page without authorizing
- WHEN they return
- THEN the subscription MUST remain "not subscribed" or in trial
- AND no billing state MUST be inferred

### Requirement: Webhook handling

Events from Mercado Pago MUST be accepted only after verifying authenticity. Processing MUST be idempotent: the same event delivered more than once MUST have the same effect as once. Out-of-order events MUST NOT regress the state (for example an older "pending" event arriving after an "approved" one). Events for unknown subscriptions MUST be ignored and logged without affecting any tenant. The endpoint MUST NOT reveal tenant information.

#### Scenario: Forged webhook
- GIVEN a request that fails the authenticity check
- WHEN it reaches the endpoint
- THEN the system MUST reject it without changing any state

#### Scenario: Duplicate delivery
- GIVEN an "approved" event processed once
- WHEN the same event arrives again
- THEN no second payment record or extension of coverage MUST be created

#### Scenario: Out-of-order events
- GIVEN an "approved" event already applied
- WHEN an older "pending" event for the same payment arrives
- THEN the subscription state MUST remain unchanged

### Requirement: Duplicate payment protection and refunds

The system MUST ensure a billing period is paid once. If the provider reports two successful payments for the same period, the system MUST record the second as a surplus, flag it for the platform operator and MUST NOT silently extend service twice. Refunds initiated by the operator MUST be recorded as separate entries. Retried charge attempts by the system MUST be idempotent.

#### Scenario: Two approved payments for one period
- GIVEN an approved payment for March
- WHEN a second approved payment for March arrives
- THEN the second MUST be flagged as surplus for operator review
- AND the paid-through date MUST not move twice

### Requirement: Billing cycle and statements

Each billing period MUST produce a statement for the tenant listing the number of active professionals counted, the unit price, prorations, WhatsApp overage and the total. Statements MUST be viewable and downloadable by the owner. Charges for overage MUST be shown to the tenant on the statement and in the usage view before the charge is collected. The system MUST NOT collect an amount that the tenant has not first seen on a statement: when the amount to collect differs from the previously authorized recurring amount (for example because of overage or proration), the collection MUST be limited to the amount shown on the issued statement and, if the payment provider requires a fresh authorization for a changed amount, the owner MUST be asked for it before collection.

#### Scenario: Collection equals the statement
- GIVEN a statement of 3 professionals plus overage issued before the due date
- WHEN the charge is collected
- THEN the collected amount equals the statement total

#### Scenario: Amount differs from the authorized recurring amount
- GIVEN a period with overage that makes the total higher than the recurring authorization
- WHEN the statement is issued
- THEN the owner sees the new total before any collection
- AND nothing beyond the statement total is collected

#### Scenario: Statement content
- GIVEN a period with 3 active professionals and some overage
- WHEN the statement is generated
- THEN it MUST list professionals counted, unit price, overage units and total

### Requirement: WhatsApp quota per active professional

Each active professional MUST receive a monthly WhatsApp message quota defined by the plan (200 messages by default). WhatsApp is used only for appointment reminders, confirmations and waitlist offers (`notifications`), and only those messages count. Each outbound WhatsApp message MUST be attributed to a professional (the professional of the related appointment) and counted against that professional's quota. Reminders and confirmations sent by email MUST NOT consume the quota. Unused quota MUST NOT carry over unless the plan states so. A professional deactivated mid-period MUST stop receiving quota according to the proration rule. A message that fails to be accepted by the provider MUST NOT be counted.

#### Scenario: Message counted
- GIVEN professional A with a quota of 200
- WHEN a WhatsApp reminder for A's appointment is accepted by the provider
- THEN A's usage MUST increase by 1

#### Scenario: Email does not consume the quota
- GIVEN a reminder sent by email
- WHEN usage is computed
- THEN the WhatsApp usage MUST be unchanged

#### Scenario: Failed delivery to provider
- GIVEN the messaging provider rejects a message at submission
- WHEN usage is computed
- THEN that message MUST NOT be counted

### Requirement: Usage visibility and thresholds

The owner MUST be able to view, per professional and in total, the current period's WhatsApp usage, quota, remaining amount and projected overage cost, updated close to real time. The system MUST notify the owner when usage reaches defined thresholds (at least 80% and 100% of the quota). Usage reports MUST contain only counts and MUST NOT include message content or patient identity.

#### Scenario: 80% threshold
- GIVEN a professional reaches 80% of their quota
- WHEN the threshold is crossed
- THEN the owner MUST be notified once for that threshold and period

#### Scenario: Usage view privacy
- GIVEN the usage view
- WHEN it is displayed
- THEN no message text or patient name MUST appear

### Requirement: Overage billing and cap

When a professional exhausts the quota, additional WhatsApp messages MAY continue to be sent and MUST be billed as overage at the plan price, subject to an overage cap. The cap is a maximum number of overage messages per period, per tenant, starting from the plan's default cap; the owner MAY lower it, raise it up to a platform maximum, or disable overage (cap of zero). A cap MUST always apply: overage MUST NOT be unlimited. When overage is disabled or the cap is reached, messages MUST fall back to email where the patient has an email address and MUST NOT be sent by WhatsApp. Overage MUST appear on the statement of the period in which it occurred. Disputed overage MUST be traceable to counted message events without exposing message content.

#### Scenario: Overage enabled
- GIVEN overage is enabled and a professional is at 100%
- WHEN another reminder is sent
- THEN the message MUST be sent and counted as overage

#### Scenario: Overage disabled
- GIVEN overage is disabled and the quota is exhausted
- WHEN a reminder is due
- THEN it MUST be delivered by email if possible
- AND no WhatsApp message MUST be sent

#### Scenario: Cap reached
- GIVEN an overage cap of 50 messages reached
- WHEN further reminders are due
- THEN the system MUST stop WhatsApp sends for the period and notify the owner

#### Scenario: Owner tries to remove the cap
- GIVEN an owner configuring overage
- WHEN they try to set an unlimited cap or a cap above the platform maximum
- THEN the system MUST refuse

### Requirement: Failed payment and dunning

When a recurring payment fails, the system MUST retry according to a documented schedule inside the grace period, notify the owner by email (never WhatsApp) and in the app after each failure, and show the date when the account will become read-only (7 days after the first failure by default). During the grace period all functions MUST remain available. Messages to the owner MUST contain no patient data.

#### Scenario: First failure
- GIVEN a recurring payment is rejected
- WHEN the failure is received
- THEN the subscription MUST enter "past due"
- AND the owner MUST be notified with the grace deadline

#### Scenario: Payment succeeds on retry
- GIVEN a subscription in "past due"
- WHEN a retry succeeds
- THEN the state MUST return to "active" and the dunning notices MUST stop

### Requirement: Read-only transition and clinical access guarantee

When the grace period ends without payment, the tenant MUST become read-only and the shared allowlist of `tenancy` applies: creation and modification of data, sending of messages, and issuing of documents MUST be blocked, except what that allowlist permits (among others: patient-protective writes, rectification addenda, the owner's subscription management, AFIP submissions already queued and provider webhooks). Reading and exporting clinical records MUST never be blocked by non-payment, because the professional is the legal custodian. Exports of the full tenant data MUST remain available. Patients MUST retain read access in the portal. A banner in the app MUST explain the state to the owner. The state MUST be enforced on the server for every capability.

#### Scenario: Read-only reached
- GIVEN grace has expired
- WHEN a professional tries to create an encounter
- THEN the system MUST refuse
- AND MUST allow the professional to read existing records

#### Scenario: Export in read-only state
- GIVEN a read-only tenant
- WHEN the owner requests a full export
- THEN the export MUST be produced

#### Scenario: Non-owner sees the reason
- GIVEN a reception user in a read-only tenant
- WHEN a write action is refused
- THEN the message MUST say the account is read-only and to contact the owner, without showing billing details

### Requirement: Recovery from read-only

When a successful payment settles the debt, the tenant MUST return to full operation without data loss and without operator intervention. Actions blocked during read-only MUST NOT be silently replayed. Queued messages from the read-only period MUST NOT be sent after recovery.

#### Scenario: Pay and recover
- GIVEN a read-only tenant
- WHEN the owner pays the overdue amount
- THEN the tenant MUST regain write access after the provider confirms the payment

### Requirement: Mercado Pago outage handling

If Mercado Pago is unavailable, the system MUST NOT interpret the absence of a confirmation as non-payment. Existing tenants MUST keep their current state while the outage lasts. Starting or changing a subscription during an outage MUST fail with a clear message and MUST be retryable. After recovery the system MUST reconcile states with the provider. A tenant MUST NOT become read-only because of a provider error that the platform cannot confirm as a payment failure.

#### Scenario: Provider outage during renewal
- GIVEN Mercado Pago is unreachable on the renewal date
- WHEN the system cannot obtain the payment result
- THEN the tenant MUST remain in its current state
- AND the system MUST reconcile when the provider recovers

#### Scenario: Subscribe during outage
- GIVEN Mercado Pago is down
- WHEN an owner tries to subscribe
- THEN the system MUST show a retry message and keep the tenant in trial or its current state

### Requirement: Trial, plan changes and cancellation

A new tenant MUST begin in a trial defined by the plan (14 days by default), and the system MUST show the trial end date. At trial end without a subscription the tenant MUST follow the same grace (7 days by default) and read-only rules as non-payment. The owner MUST be able to change plan and cancel at any time. Cancellation MUST take effect at the end of the paid period, MUST NOT delete data, and MUST trigger the tenant cancellation export (administrative part to the owner, clinical part to each professional for their own patients) and retention archive handled by `tenancy`. Reactivation before archive completion MUST restore the tenant.

#### Scenario: Cancel at period end
- GIVEN an active subscription
- WHEN the owner cancels
- THEN the state MUST become "cancelling" and service MUST continue until the end of the paid period
- AND the cancellation export MUST be offered
- WHEN the paid period ends
- THEN the state MUST become "cancelled"

#### Scenario: Reactivate while cancelling
- GIVEN a subscription in "cancelling"
- WHEN the owner reactivates before the paid period ends
- THEN the state MUST return to "active"

#### Scenario: Trial ends without payment
- GIVEN a trial reaches its end date with no subscription
- WHEN the date passes
- THEN the tenant MUST enter grace and then read-only per the dunning rules

### Requirement: Access control, isolation and audit

Only the owner role MUST view and manage subscription, payment and billing statements. Professionals, reception and patients MUST NOT access them. Subscription data MUST be isolated per tenant. The platform operator MUST be able to see subscription state, usage counts and surplus flags for support, and MUST NOT thereby gain access to any clinical data. Plan changes, subscription events, state transitions, overage cap changes and operator actions MUST be recorded in `audit-log`.

#### Scenario: Professional opens billing
- GIVEN a professional who is not an owner
- WHEN they request the billing page or API
- THEN the system MUST deny it

#### Scenario: Operator support view
- GIVEN a platform operator viewing a tenant's subscription
- WHEN the view is displayed
- THEN it MUST show billing and usage counts only
- AND no patient or clinical data MUST be reachable from it

### Requirement: Single-tenant deployments

In a single-tenant deployment, subscription billing and plan limits MUST be disableable by configuration, and WhatsApp usage MUST still be metered so it can be invoiced under contract. When disabled, the read-only transition for non-payment MUST NOT apply and the tenant is exempt as described above. Metering MUST use the same WhatsApp usage events as in multi-tenant mode.

#### Scenario: Billing disabled by configuration
- GIVEN a single-tenant deployment with subscription billing disabled
- WHEN a user opens the app
- THEN no payment prompts or limits MUST appear

### Requirement: Language and communication

All subscription UI, statements and notifications MUST be in Spanish (es-AR) using ARS formatting. Billing emails MUST be delivered to the owner and MUST NOT include patient data or clinical content.

#### Scenario: Notification language
- GIVEN a payment failure notice
- WHEN it is sent
- THEN the text MUST be in Spanish and amounts MUST use ARS formatting
