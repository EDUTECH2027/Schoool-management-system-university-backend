# Student services (requests with a workflow)

Code: `src/routes/services.js` (mounted `/api/services`), `src/services/requests.js` (types, state machine, SLA, transition engine). Tests: `scripts/test-services.js`.

## Types
`certificate` (enrolment certificate), `transcript`, `correction` (data/grade), `leave` (suspension/leave of absence), `complaint`, `other`. Type-specific details go to `payload` (≤12 string/number/bool keys, each string ≤500 chars; objects are dropped): `leave` needs `start_date` (+ optional `end_date` ≥ start), `correction` needs `field`.

## Workflow
```
submitted → in_review → awaiting_info ↔ in_review
                      → approved → completed
                      → rejected                (needs a note)
any open state except approved → cancelled
```
`submitted`: in_review, cancelled. `in_review`: awaiting_info, approved, rejected, cancelled. `awaiting_info`: in_review, rejected, cancelled. `approved`: completed. `rejected`, `completed`, `cancelled` are terminal. A note (≥3 chars, visible to the student) is required for `awaiting_info`, `rejected` and staff `cancelled`. A student reply while `awaiting_info` moves the request back to `in_review` automatically. Transitions are claimed with the current status inside a transaction, so concurrent changes cannot both succeed (409 for the loser). Every transition writes a `service_request_events` row and an `academic_audit` row (`service.<status>`, `service.assign`, `document.issue`).

Completing an approved `certificate` / `transcript` issues the official document in the same transaction, using `academics/documents.js` (`buildPayload`, `newCode`) exactly like `POST /api/documents/issue` (enrolment certificate / transcript). When the data does not allow it (transcript without published results, student not active) the transition is refused with 422 and the request stays `approved`. `document_id` links the document; the student opens it from the existing documents page (`GET /api/documents/:id`).

## Endpoints
| Method / path | Who | Notes |
|---|---|---|
| `GET /meta` | any login | types, statuses, flow, SLA days, limits |
| `POST /` | student | create (subject 3–150, description ≤4000; max 10 open → 429) → reference `SR-YYMM-XXXXXX` |
| `GET /mine`, `GET /mine/:id` | student (own only) | timeline contains only `internal=false` events; no assignee exposed |
| `POST /mine/:id/comments` | student | while not rejected/completed/cancelled |
| `POST /mine/:id/cancel` | student | submitted / in_review / awaiting_info |
| `GET /` | super_admin, academic_officer | filters `status` (`open`, one status or list), `type`, `assignee` (`me`, `none`, user id), `search` (reference, subject, student name/number), `overdue=1`, `page`, `limit`; returns `counts` per status |
| `GET /:id` | staff | full timeline incl. internal notes |
| `GET /staff-users` | staff | assignee options |
| `POST /:id/assign {user_id\|null}` | staff | assignee must be admin/academic officer; internal event |
| `POST /:id/notes {body}` | staff | internal note (never visible to the student) |
| `POST /:id/comments {body}` | staff | public reply (notifies the student) |
| `POST /:id/status {to, note}` | staff | state machine above; completing may issue the document |

Teachers, finance officers, librarians and parents get 403 on everything except `/meta`. head_teacher is treated as super_admin.

## SLA
`SERVICE_SLA_DAYS` (default 5). Staff rows carry `age_days`, `sla_days`, `overdue`; a request is overdue when it waits on staff (`submitted`, `in_review`, `approved`) and is older than the SLA. `awaiting_info` is never overdue (the ball is with the student).

## Notifications
Student: type `service_update` on every staff-visible change (status, public reply). Staff: type `service_request` for new requests, student replies/cancellations (assignee only when assigned), and assignments. Internal notes never notify the student. `service_update` is in the e-mail allow-list (see NOTIFICATIONS.md).

## Not done
No attachments (students describe documents in text); no per-type SLA; no fee/payment gating of document requests; leave approval does not change `academic_status` automatically (staff do that in the student record).
