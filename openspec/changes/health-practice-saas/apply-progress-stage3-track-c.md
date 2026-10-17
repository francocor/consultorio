# Apply progress: Stage 3, track C (waitlist, S3.11 to S3.13 and task 3.61)

Change: `health-practice-saas`. Branch `feat/stage-3-track-3c`, from `04048ea` (tracks A, B and D already integrated). Mode: automatic, strict TDD, `size:exception` (work-unit commits, no PR, no merge, CI not polled). This file is separate from `apply-progress.md` on purpose; the orchestrator merges it.

## Status of the tasks

| Task | State | Notes |
| ---- | ----- | ----- |
| 3.51 | done | `waitlist_entry`, `waitlist_offer` and `waitlist_call` + migration `0360`. |
| 3.52 | done | `entries.ts`, `POST\|GET\|PATCH /waitlist`, pause, resume, close, priority. |
| 3.53 | done | `domain/matching.ts` (pure), `domain/manual-contact.ts`. |
| 3.54 | done | `slot_freed` trigger, `waitlist.match` job, invalidation of offers for a taken slot. |

(Updated slice by slice below.)
