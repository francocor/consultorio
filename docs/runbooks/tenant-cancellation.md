# Runbook: the end of an organization

Audience: whoever operates the platform, and the owner who answers customers. Scope: what happens from
the moment an organization stops being a customer to the day its records are released or erased, what
the platform does by itself, what a person does, and what nobody may do. Task 6.46. The archive in
detail is `docs/runbooks/archive-release.md`.

## The timeline

1. **The owner cancels** (screen "Suscripción", "Cancelar la suscripción"). The subscription goes to
   `cancelling`: the service continues until the end of the paid period and the owner can take it back.
   Nothing is deleted. A trial that ends unpaid does not cancel: it follows the grace and the read-only
   state (`docs/runbooks/incident.md`, "Subscriptions in dunning").
2. **The paid period ends.** The clock of the dunning (`dunning.step`) moves the subscription to
   `cancelled` and announces it to retention (`TenantCancelled`). The operator can announce the same
   thing for a deployment without billing, or to test, with the console action "cancel the
   organization".
3. **The export is requested** in the same transaction that cancelled: one administrative package for
   the owner and one clinical package for each professional (their own patients, decrypted). The
   packages are built by the job `export.build`, with no transaction open while they are written, and
   the people they are for get an email when each is ready. The export works in every state, including
   `cancelled`.
4. **The export window.** The organization is read-only and its people can sign in to download. A
   professional who left before the end gets nothing: patients whose professional is gone are covered by
   the archive. An owner who is not a professional gets no clinical package.
5. **The archive is written** after `ARCHIVE_AFTER_DAYS` (30 by default): every package, encrypted with
   the public key of the organization, in the write-once store with a retention of
   `ARCHIVE_RETENTION_DAYS` (3650 by default). The API and the worker can write the archive and cannot
   read it. The organization gets `archived_at`.
6. **Each week the archive is verified**: checksums, and a test restore in the test harness of the
   releaser. A corrupted object raises an entry in the platform trail.
7. **Records are released** only through the break-glass release (`docs/runbooks/archive-release.md`):
   an operator records the request and verifies the identity, a different operator approves, the
   releaser (the only process with the key) decrypts and sends a link of one use, valid for 72 hours.
   The operator never sees the content.
8. **Legal erasure** is the only way an archived object is removed before its retention ends:
   `pnpm archive:legal-erase --reference "<legal reference>"` with the privileged credential, which
   records the reference. Nothing else, and nobody else, can.

## Version 1 keeps the rows

The plan has no exception that allows deleting the hot rows of a cancelled organization, so version 1
keeps them in the database, read-only, and treats the archive as the copy in custody. The owner has to
confirm this policy (`docs/go-live-checklist.md`). No code path removes them; the scan of deletions
(`no-delete`) lists exactly four exceptions and none is this.

## What to do when a customer leaves

1. Check that the subscription says `cancelled` (operator console, "Suscripciones") and the date.
2. Check that the export packages are ready: the owner sees them on "Exportación". If a package failed,
   its row says the code, never a text; the job retries, and the last try records `build_failed`.
3. Tell the owner, in writing, when the archive will be written and how long it is kept.
4. After `ARCHIVE_AFTER_DAYS`, check the archive in the console, tab "Archivo": the state is `written`,
   later `verified`.
5. If a patient or a professional asks for their records after that, follow
   `docs/runbooks/archive-release.md`. Do not export from the database by hand.

## Never

- Never delete rows of a cancelled organization, an object of the archive or an entry of the trail.
- Never give the key of the releaser (`ARCHIVE_RELEASER_KEK`) to the API, the worker or an operator.
- Never release records without the identity verification of the request and a second operator.
- Never restart the clock of a cancelled organization to "give it more time": reactivation is the owner's
  action, before the end of the paid period.
