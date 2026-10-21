# Runbook: incidents

Audience: whoever is on call for the platform. Scope: how to look at the numbers, what each alert of
`infra/alerts/rules.yml` means, and what to do first. Task 6.46. Each alert names one of the sections
below in its `runbook` annotation, and a test (`apps/api/test/policy/alert-rules.test.ts`) fails when a
section is renamed or an alert points at one that does not exist.

The rules of every incident:

1. **Patient safety first.** Reading a clinical record must keep working. If it does not, that is the
   incident, whatever the alert said.
2. **Never repair evidence.** Do not edit, delete or "fix" an audit event, a sealed chain, an invoice or
   an archive object. Freeze, copy, and ask (`docs/runbooks/audit-retention.md`).
3. **Never read patient data to diagnose.** The metrics are counts, ages and codes. The logs carry ids
   and codes, never a name, an address or a clinical text; if a diagnosis seems to need one, stop and
   ask the owner.
4. **Write it down.** The time it started, who looked, what was tried, what ended it. A short entry in
   the operations log is enough.

## Looking at the numbers

Each process (the API, the worker) can expose its numbers on a port of its own (`METRICS_PORT`,
`METRICS_HOST`, `METRICS_TOKEN`; `docs/dev-setup.md`). The worker measures the counts of the platform
every minute: the queues, the messages of the last day, the invoices pending past the outage threshold,
the documents waiting for the scan, the audit events not sealed, the subscriptions by state. The list of
series, with what each one means, is `apps/api/src/platform/metrics-catalog.ts`.

Locally, with Docker:

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile app --profile observability up
# Prometheus  http://127.0.0.1:9090   (the alert rules are loaded: Status, Rules)
# Grafana     http://127.0.0.1:3001   (admin / grafana_dev_only; the dashboard "Consultorio: plataforma")
```

The API of the compose file exposes its port inside the network. The worker is not part of the compose
file: run it on the machine with `METRICS_PORT=9465 METRICS_HOST=0.0.0.0
METRICS_TOKEN=metrics_token_dev_only_0123456789` and Prometheus reaches it through the host. Without
Docker, `curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:$METRICS_PORT/metrics` shows
the same text. In production the scraper and the rules belong to the monitoring service of the cloud;
the rules file is the same.

To prove the chain works (before the first customer, and after any change of the monitoring), stop the
worker for six minutes: `MetricsCollectorSilent` must fire. Record the date.

## Audit chain broken

**Alert `AuditChainBroken` (critical).** The nightly verification (03:00 UTC) walked the chain of an
organization, or the platform's, and found a gap, a row that does not point at its predecessor, or a
row whose hash is not the one its content gives.

1. Read the log line `audit chain break` of the worker: the organization, the first bad sequence number
   and the reason (`gap`, `prev_hash_mismatch`, `hash_mismatch`).
2. **Freeze.** Take a copy of the `audit_event` table of that organization as it is now and keep it
   apart. Do not repair, re-seal or delete anything.
3. Find out when it broke: restore the last backup that was verified into a scratch database
   (`docs/runbooks/backup-restore.md`) and walk the same chain there. If it verifies in the backup and
   not in the live database, the live data changed after the backup, and the rows that differ are the
   evidence. If it breaks in the backup too, go back one more.
4. A `hash_mismatch` at a sequence number means that row was altered after it was sealed. A `gap` means
   a row was removed. Either way it is a security incident: tell the owner the same day.
5. After the investigation, the owner decides what to tell the organization. The platform never
   rewrites a chain; a note in the operations log records what was found.

## Audit sealing late

**Alert `AuditSealingLate` (warning).** Audit events have waited more than five minutes to be sealed
into their chain. The events are durable and visible (the screens mark them "pending sealing"); the risk
is a longer window in which an event is not yet protected by the chain.

1. Is the worker running? (`WorkerDown`, `MetricsCollectorSilent`; the next section.) Restart it.
2. Does it have the sealer login? The worker refuses to start without `AUDIT_SEALER_DATABASE_URL`; a
   wrong password makes every `audit.seal` job fail: read the log for `scheduled task failed`.
3. Is one organization the problem? The gauge `audit_seal_lag_seconds{tenant}` names it. A job that
   fails for one organization does not stop the others.
4. When it drains, the alert resolves by itself. If it never drains, treat it as the incident above.

## A queue is stuck

**Alerts `QueueWaitingTooLong`, `QueueDeep` (warning).** A job has waited more than fifteen minutes, or
more than five hundred are waiting in one queue (`queue_jobs`, `queue_oldest_waiting_seconds`; the label
is the name of the queue).

1. Is the worker running and answering the scraper? A queue that nobody consumes grows without error.
2. Which queue? `dunning.step` never retries on its own (`retryLimit: 0`): a failed step waits for the
   next pass of the clock, it is not redelivered. `archive.release` runs only in the `releaser`
   process, which is a different process from the worker.
3. A job that fails again and again is in `failed` state in the schema `pgboss`; the error is in the log
   of the worker with the name of the queue and the id of the organization.
4. A read-only organization still runs the jobs of its category (exports, billing, the archive); a
   `write` job of a read-only organization is cancelled on purpose and is not a stuck job.
5. Do not delete jobs by hand to make the number go down. Fix the cause; the queue drains.

## The worker is silent

**Alerts `MetricsCollectorSilent`, `WorkerDown` (critical).** The worker did not measure the platform
for five minutes, or it does not answer the scraper. Everything that runs in the background has stopped:
sealing the audit trail, reminders, scans, invoices, dunning, exports, the archive.

1. Is the process alive? Restart it. The first thing it logs is any configuration error (a variable
   missing, `DB_POOL_MAX` under 46, a login that does not work).
2. Is the database reachable? `/ready` of the API says so.
3. Did the pool run out? A burst of connection-holding jobs with a pool under the floor looks like a
   hang (`docs/runbooks/deploy.md`, "Size the connection pool").
4. After it is back, check `audit_oldest_unsealed_seconds` and the queues: they should drain within
   minutes. Nothing is lost: the work is in the database.

## Reminders are failing

**Alert `ReminderFailureRateHigh` (warning)** and `BookingAbuse`. More than a fifth of the messages of the
last 24 hours failed (`messages_last_day{status="failed"}`), once there are at least twenty.

1. Is it one provider? The failure reasons are codes: `not_on_whatsapp`, `template_rejected`,
   `invalid_number`, `mailbox_unavailable`, `delivery_failed`, `retries_exhausted`. A wave of
   `mailbox_unavailable` or `delivery_failed` is the mail server or the provider; a wave of
   `template_rejected` is a template that was changed or withdrawn.
2. An email that cannot be sent is retried with a growing delay before it counts as failed
   (`retries_exhausted`). Check the status page of the provider before touching anything.
3. When the quota of an organization is spent the message goes by email instead of WhatsApp; that is not
   a failure. A message the provider refused is never counted against the quota.
4. `BookingAbuse` is about the public booking form: suspicious requests are refused by the challenge and
   the limits already. Read `booking_suspicious_total{reason}` for the reason code before deciding
   whether to tighten a limit.

## Documents wait for the scan

**Alerts `DocumentScanBacklog` (critical), `DocumentScanOverdue` (warning).** A document has waited more
than an hour for the malware scan. Nobody can open it meanwhile (it stays quarantined by design).

1. Is ClamAV up and reachable (`CLAMAV_HOST`, `CLAMAV_PORT`)? If the scanner stops answering the
   documents stay quarantined and are retried with a growing delay; none is ever released unscanned.
2. Is it downloading signatures? The container needs a minute or two after a restart.
3. When the scanner is back, the backlog drains by itself; `documents_scan_backlog` shows the count.
4. A document the scanner rejects is marked rejected and its uploader is told; that is not an incident.

## Subscriptions in dunning

**Alerts `SubscriptionsAboutToBeReadOnly`, `SubscriptionsReadOnly` (info).** Not a fault of the platform:
organizations whose payment failed are walking the dunning (reminders on day 1, 3 and 5, a grace of seven
days) and some are about to become read-only. Nobody needs to be woken; the owner of the platform
decides whether to call.

1. The operator console, tab "Suscripciones", shows the state, the dates and the usage counts of each
   organization, never a patient.
2. A state changes only when the payments provider confirms something or a date arrives. An outage of
   the provider never advances a reminder, never makes an organization read-only and never cancels one.
   If many organizations enter the dunning at once and the provider had an outage, check the provider
   first.
3. The owner of an organization comes back by paying what is due (the button "Pagar lo adeudado" of the
   subscription screen). The organization is active again as soon as the provider confirms the payment;
   what was blocked in the meantime is not replayed.
4. A refund or a duplicated payment is flagged for the operator on the same screen ("Pagos" of the
   organization). Refund it from there: give the reason, confirm, and the console makes one refund
   however many times it is pressed. The entry is in the trail of the organization and in the platform
   trail with your name. A second recurring charge for a month that an overdue link paid is given back
   by the platform itself; you only see it as reviewed. Do not refund from the provider's own panel
   without telling the platform: if you did, the next reconcile records the refund.

## A subscription is parked for a person

**Alert `SubscriptionParked` (warning); the console shows "Requiere revisión" on the organization.**
The payments provider holds something the platform cannot tell apart (several preapprovals under one
reference, an identity that does not match, one that is not what was asked, a state nobody expected).
The platform stopped sending anything to the provider for that subscription until a person decides,
because anything sent could charge the payer twice. The label `reason` of the series `subscriptions_parked`
says which. It is not an outage.

1. Open the tab "Suscripciones" of the console and the organization: it shows the reason and since when.
   Look at the provider's panel for the references of the organization (`sub:<subscription id>:<number>`):
   which preapprovals exist, for which payer and amount.
2. If the owner asked to cancel, nothing is needed: cancelling works while the subscription is parked, stops
   every preapproval the platform can find and clears the cause.
3. `ambiguous_preapproval`, `identity_mismatch` and `unexpected_state`: use "Dejar seguir" with the reason you
   found. The platform releases the parked requests and asks the provider again; it cancels any preapproval
   it did not adopt under those references. It never picks one for you. The owner subscribes again from
   their screen, and exactly one stays alive. Tell the owner first if what the provider held was theirs.
   If the provider refuses to cancel something the platform must not leave alive, the subscription parks as
   `unexpected_state`: cancel it in the provider's panel, then "Dejar seguir".
4. `reauthorization_needed` is not an ambiguity and does not raise `SubscriptionParked`: the owner has been
   told by email to authorize the right amount (the screen says so), or the charge lands and the statement
   is collected. It clears by itself at the next reconciliation and "Dejar seguir" refuses it until then.
   `SubscriptionReauthorizationWaiting` (info) rises after a day; if the owner still has not done it, call
   them.
5. Nothing is lost while it is parked: the clock of the dates keeps its rules, and no charge is attempted
   by the platform.

## Reconciliation with the payments provider is stale

**Alert `SubscriptionReconcileStale` (warning).** A subscription that has a preapproval was not
reconciled for two hours; it is reconciled every five minutes. The usual cause is the provider (an
outage or a revoked credential), then the worker.

1. Check `MetricsCollectorSilent` and `WorkerDown`: if the worker is down, this is the same incident.
2. Look at the worker log for `subscription.reconcile` failures: a code of the gateway (`unavailable`,
   `unauthorized`) names the provider's side. A credential that expired is replaced in the
   configuration of the worker.
3. While it is stale nothing advances toward read-only for lack of an answer: the dates wait.

## A surplus payment waits for review

**Alert `SubscriptionSurplusUnreviewed` (warning).** A second approved payment for a period that was
already paid is flagged as a surplus; it moves nothing and waits for an operator.

1. The tab "Suscripciones" lists the flagged payments of the organization with the amounts.
2. Decide: refund it (the console asks for confirmation) or mark it reviewed with the reason.
3. A surplus that repeats for the same organization is a duplicated authorization at the provider:
   treat it as a parked subscription.

## An archive failed to write or to verify

**Alerts `ArchiveVerifyProblem`, `ArchiveWriteFailed` (critical), `ArchiveVerifyOverdue` (warning).**
The records of a cancelled organization are in custody and one of the checks failed. Nothing is
released or erased by this alert; the hot rows of the organization still exist.

1. The tab "Archivo" of the console lists the archives with their state and the last verification
   (`corrupted`, `missing`, `overwritten`) and the number of problems, never an object name.
2. `ArchiveWriteFailed`: the failure code is on the archive; read the worker log for `archive.write`.
   The archive is written again by hand only after the cause is fixed.
3. `corrupted` or `overwritten`: the object in the write-once bucket differs from the manifest. Do not
   touch the bucket. Follow the section "Verifying and restoring" of `docs/runbooks/archive-release.md`
   (the restore drill) with the engineer in charge of retention.
4. `ArchiveVerifyOverdue`: the weekly verification did not run: the worker (`archive.verify`) or the
   bucket is the problem; see "A queue is stuck".
5. An archive that was erased by a legal order is not verified and does not raise this alert.

## An approved release was not carried out

**Alert `ArchiveReleaseNotCarriedOut` (critical).** Two operators approved the release of records to a
patient or a professional and the releaser did not carry it out within fifteen minutes. The requester
is waiting for records they are entitled to.

1. First `ReleaserSilent`: if the releaser is down, start it (below) and the request is carried out on
   its own.
2. If the releaser is alive, read its log: `restore_*` and `scope_*` failures end the request as
   `failed` with a code the operator sees; `email_failed` means the link did not reach the requester.
   A new request is recorded after the cause is fixed.
3. An approval is valid for seven days; after that the request expires and is recorded again.

## The releaser is silent

**Alert `ReleaserSilent` (critical).** The releaser writes a heartbeat every few seconds; none for two
minutes means the process is down or cannot reach the database with its own login (`app_releaser`).

1. Is the container running? `docker compose ... --profile app up -d releaser` (or the equivalent of the
   deployment). It needs `ARCHIVE_RELEASER_KEK`, the archive and files buckets and
   `RELEASER_DATABASE_URL`.
2. A login that was rotated or a role that does not exist shows as an authentication error in its log.
3. While it is down nothing is released and nothing is lost: approved requests wait, and expire after
   seven days if nobody restarts it.

## Signup emails are not going out

**Alert `SignupEmailsUnsent` (warning).** Signups wait for their verification link and the email never
left. The worker retries five times with a backoff and then stops; the person can ask for a new link.

1. Check the mail provider (credentials, quota, the sender domain) and the worker log for
   `a verification email of a signup could not be sent`.
2. Once the provider answers, ask the person to use "Enviar el correo de nuevo" on the screen they are
   on, or wait for the next retry if attempts remain. Unconfirmed signups are purged after seven days.

## After the incident

Write the entry of the operations log, and for anything that took more than an hour add what would have
made it shorter: an alert that was missing, a number that was not measured, a section of this page that
was wrong. This page is edited in the same change that fixes the cause.
