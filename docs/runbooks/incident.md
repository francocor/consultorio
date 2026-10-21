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

## A subscription parked for a person

**The operator console shows "Requiere revisión" on an organization.** The payments provider holds
something the platform cannot tell apart (two preapprovals under one reference, one that is not what
was asked, a state nobody expected). Nothing is sent for it and its dates wait, because anything
sent could charge the payer twice. It is not an outage.

1. Open the organization and read the cause. Look at the provider's panel for the references of the
   organization (`sub:<subscription id>:<number>`): which preapprovals exist, for which payer and amount.
2. If the owner asked to cancel, nothing is needed: cancelling stops every preapproval the platform can
   find and clears the cause.
3. Otherwise use "Dejar seguir" with the reason you found. The platform releases the parked requests and
   asks the provider again; it cancels any preapproval it did not adopt under those references. It never
   picks one for you. The owner subscribes again from their screen, and exactly one stays alive. Tell
   the owner first if what the provider held was theirs.
4. `reauthorization_needed` is different: the owner has to authorize the right amount (the screen says
   so), or the charge lands and the statement is collected. It clears by itself and "Dejar seguir"
   refuses it until then.
5. If the provider refuses to cancel something the platform must not leave alive, the subscription
   parks as `unexpected_state`: cancel it in the provider's panel, then "Dejar seguir".

## After the incident

Write the entry of the operations log, and for anything that took more than an hour add what would have
made it shorter: an alert that was missing, a number that was not measured, a section of this page that
was wrong. This page is edited in the same change that fixes the cause.
