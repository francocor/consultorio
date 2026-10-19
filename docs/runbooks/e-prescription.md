# Runbook: e-prescription and the portal notices

For whoever runs the platform. It covers what the worker does about prescriptions the provider did not confirm, what a prescription that is "in progress" for a long time means, and the notices the portal sends when the staff change something about a person.

## A prescription stays "in progress"

A prescription is valid only when the provider confirmed it. Until then it is `pending_submission`, and the worker (queue `erx.submit`, and the pass `erx.reconcile` every two minutes) keeps asking, with a wait that doubles from a minute to an hour.

| What the row says                          | What it means                                                                                                                                                                    | What to do                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivery_state = retrying`                | The provider was down or refused to answer; nothing reached it.                                                                                                                  | Nothing: the next attempt sends it.                                                                                                                                                    |
| `delivery_state = awaiting_reconciliation` | The provider may hold the prescription and the answer was lost. The next attempt asks for the key BEFORE it sends anything.                                                      | Nothing: it adopts what the provider holds, or sends once.                                                                                                                             |
| `provider_in_flight_until` in the future   | A call to the provider TIMED OUT and may still be running there. For ten minutes (`inFlightPinMs`) nothing is sent again, cancelled or registered by hand, not even by a person. | Wait. If the provider is slower than ten minutes in the worst case, raise the window in `createPrescriptionsWiring` (it must be at least the processing time plus the socket timeout). |
| `attempt_lease_until` in the future        | A request holds the row without a connection, for at most two minutes. A crashed process leaves a lease that simply runs out.                                                    | Wait two minutes.                                                                                                                                                                      |
| `delivery_state = needs_attention`         | The matricula lost its verification or changed, or the provider holds a prescription that cannot be recorded for this one.                                                       | The professional reads the reason on the screen. The operator verifies the matricula again if that is the cause.                                                                       |

A prescription whose provider was disconnected can be closed by its professional with `acknowledgeUnknownOutcome` (the trail says `unconfirmed`): it is closed here without asking, because there was nobody to ask. While a provider is connected the provider is always asked first. An owner or an administrator cannot close a prescription for them (they never read one): this is a known gap, recorded for the next review.

## Notices of the portal

Three notices warn a person that the staff changed something that concerns them. None carries a link, a code, a value or a name.

- **The record changed.** A change of the e-mail or the birth date of a patient's record is written by the database in the same transaction (`patient_record_change`). The sweep `portal.notice_sweep` (every minute, per organization) tells the address the record HAD and clears it from the table. A row without an address (the record had none) tells nobody. If the worker is stopped the notices wait in the table; after seven days the address is cleared without being told.
- **An account moved to another address** and **a representative was given access to a minor.** Queued in the transaction of the change (`portal.notice_send`). A failed delivery is retried by the queue; the entry `portal.notice.sent` of the trail is written when it is sent, so its absence is how a notice that did not go out shows.

Both queues keep running when an organization is read-only (they protect a person). For seven days after a change of the e-mail or the birth date of a record, reception cannot invite the patient or a representative: an owner or an administrator does it (`portal_recent_identity_change`).
