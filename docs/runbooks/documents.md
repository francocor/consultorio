# Runbook: documents

Audience: the operator on call and whoever reviews retention. Scope: the `document` table and the
objects it points at. Rules come from the documents spec and from design sections 5.6 and 7.

## The rules in one place

| Rule                                   | How it is enforced                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing is downloadable before a scan  | A new document is `quarantined`. Only the `document.scan` job moves it to `available`, and only after a real verdict. A scanner that cannot be reached leaves it quarantined (fail closed).                                  |
| Nothing is deleted                     | `app_rw` has no `DELETE` or `TRUNCATE` on `document`. A corrected file is a new row linked to the old one (`replaces_document_id`); a mistake is hidden with a reason; an abandoned upload is marked (`abandoned_at`).       |
| Files do not change                    | A trigger fixes the identity of a row (patient, uploader, name, declared type) and writes the result of the scan once (hash, detected type). The storage key moves only when the scan releases the file.                     |
| Clinical documents stay clinical       | A RESTRICTIVE row policy shows a clinical row only to a health professional who may read it. Reception sees clinical metadata (name and category) only when the organization turns it on, through one definer function.      |
| A download link is not a bearer URL    | `POST /documents/:id/download-link` issues a single-use token bound to the session, valid 5 minutes. `GET /files/:token` checks the session, spends the token and decides the authorization again before streaming the file. |
| Lists never carry content              | The list returns metadata only: no storage key, no hash, no link.                                                                                                                                                            |
| Documents are kept as long as the care | At least 10 years after the patient's last encounter, like the clinical record. A read-only organization can still list and download; it cannot upload, hide or replace.                                                     |

## Storage layout

- `t/{tenantId}/quarantine/{documentId}`: the object while it waits for its scan. The browser
  uploads here with a presigned POST that pins the content type and the 20 MB cap.
- `t/{tenantId}/docs/{documentId}`: the object after a clean scan. The name of the file is never
  part of a key.
- An infected or refused file is removed from storage; its row stays, with the reason.

## The scan

`document.scan` runs in the worker. In order: read the object (never more than 20 MB), decide the
type from the bytes (the whitelist: PDF, JPEG, PNG, WebP, plain text, DOCX), compare it with the type
declared at upload, hash it, then ask ClamAV (`INSTREAM`). An executable, a script, an archive, a
polyglot or a type mismatch is refused without asking the scanner.

If ClamAV does not answer, the job queues itself again with a growing delay (30 s, 60 s, ... up to
15 minutes) and the document stays `quarantined`. After one hour the worker logs an error
(`a document has waited more than an hour for its malware scan`) and increments
`document_scan_overdue_total`: alert on it. Fix ClamAV (it needs about 1 GB of RAM and a minute or
two to load signatures after a start) and the backlog drains by itself.

Production refuses to start with a bucket and no `CLAMAV_HOST`. `freshclam` keeps the signatures
up to date inside the ClamAV container.

## Housekeeping (`document.cleanup`)

Once an hour, per organization:

- An upload requested but never confirmed for 24 hours is marked `abandoned_at` and its orphan
  object is removed. The row is kept.
- A confirmed upload still quarantined with no activity for 30 minutes gets its scan queued again.

## Export when an organization leaves

Documents register two contributors: the administrative part holds every administrative document
(hidden ones, refused ones and previous versions included) and goes to the owner; the clinical part
is built per professional and holds the clinical documents of the patients that professional treats.
Both carry the storage key and the hash so the exporter can fetch and verify each file. A clinical
document never travels in the administrative part.

## Never

- Never `DELETE` a document row or remove an object under `docs/` to save space. Legal erasure is a
  separate, audited procedure of the retention policy (decision D13).
- Never move an object out of `quarantine/` by hand: only the scan decides.
- Never widen `document_classification` to let a role read clinical rows. If a screen needs more,
  add a function that returns exactly that and test who can call it.
