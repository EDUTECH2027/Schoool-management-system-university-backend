# Thesis / final-year project supervision

Mounted at `/api/thesis` (`src/routes/thesis.js`; state machine in `src/thesis/engine.js`). Tests: `scripts/test-thesis.js`.

## Workflow
`proposed → supervisor_accepted → approved → in_progress → submitted → defence_scheduled → defended → completed`, plus `rejected` (officer, from proposed/supervisor_accepted/approved) and `withdrawn` (student, before submission).

| Action | Endpoint | Who | From → To |
|---|---|---|---|
| propose | `POST /` | active student | → proposed (one open thesis per student; parallel requests safe) |
| edit proposal | `PUT /:id` | owner | only while proposed (can change preferred supervisor) |
| accept | `POST /:id/accept` | the supervisor | proposed → supervisor_accepted; blocked at the cap (409 `supervisor_full`) |
| decline | `POST /:id/decline {reason}` | the supervisor | stays proposed, supervisor cleared, student + officers notified |
| assign | `POST /:id/assign {supervisor_id?, co_supervisor_id?, note}` | officer | any open state; a *new* supervisor on a `supervisor_accepted` thesis sends it back to `proposed`; cap enforced for loaded states |
| approve / reject | `POST /:id/approve`, `/reject {note}` | officer | supervisor_accepted → approved; reject needs a note |
| start | `POST /:id/start` | supervisor/officer | approved → in_progress |
| submit final | `POST /:id/submit-final` | owner | in_progress → submitted; requires every milestone `accepted` and ≥1 uploaded file |
| schedule defence | `POST /:id/schedule-defence {date,time,room,jury[]}` | officer | submitted → defence_scheduled (re-schedulable); date ≥ today; jury entries `{name, role, teacher_id?}`; notifies student, supervisors and jury teachers |
| defended | `POST /:id/defended` | officer | defence_scheduled → defended |
| result | `POST /:id/result {score 0-100, grade, note}` | officer | defended → completed (a scheduled defence passes through `defended` automatically) |
| withdraw | `POST /:id/withdraw` | owner | proposed…in_progress → withdrawn |

Illegal transitions return 409. Every transition is a compare-and-set inside a transaction and appends a `ThesisEvent` plus an `academic_audit` row (`thesis.<action>`; also `thesis.review`, `thesis.assign`, `thesis.edit`, `thesis.propose`).

## Milestones, submissions
* `POST /:id/milestones {title, due_date?, position?}`, `PUT/DELETE /milestones/:mid` — supervisor, co-supervisor or officer, only while approved/in_progress. Deleting a milestone that has submissions is refused.
* `POST /:id/submissions` (multipart `file`, optional `milestone_id`, `note`) — owner only, in_progress. Versions increase per milestone (or per thesis for general documents) under an advisory lock. Files are stored in the DB (`file_data`), same type allow-list and `ELEARNING_MAX_UPLOAD_MB` limit (default 10) as e-learning; always served as attachment unless safe inline type; `nosniff` + sandbox CSP.
* `PUT /submissions/:sid/review {decision: accepted|revision_requested, feedback}` — supervisor/co-supervisor only; only the latest version of a milestone can be reviewed, once. General documents take feedback only.
* `GET /submissions/:sid/file` — owner, supervisor, co-supervisor, officer; jury teachers once the defence is scheduled; everyone else 404.

## Views
`GET /mine` (student), `GET /supervision` (teacher: requests, supervisees with `next_deadline`/`overdue`/`awaiting_review`, `load`/`max`), `GET /dashboard` (officer: status counts, workload per supervisor, upcoming defences), `GET /` (officer list; filters `status`, `supervisor_id`, `programme_id`, `q`, paging), `GET /:id`, `GET /supervisors` (picker with load/availability), `POST /:id/comments`.
Access: a student sees only their own thesis, a teacher only theirs (supervisor/co-supervisor, or jury member); other people get 404.

## Environment
* `THESIS_MAX_SUPERVISEES` (default 8): concurrent supervisees per lecturer (statuses supervisor_accepted…defended; co-supervision not counted). Checked under a per-supervisor advisory lock so parallel acceptances cannot exceed it.
* `ELEARNING_MAX_UPLOAD_MB` (default 10).

## Not done / limits
* Score scale is a plain 0–100 number plus a free-text grade (≤10 chars); it is not tied to the school grading scheme.
* Jury members are notified only if they are lecturers (`teacher_id`); external names are informational.
* In-app notifications only (no e-mail).
* No conflict detection of room/jury double-booking at the defence slot.
