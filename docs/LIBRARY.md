# Library module

Routes: `src/routes/library.js` (`/api/library`), rules in `src/library/service.js`. Tests: `scripts/test-library.js`.

## Roles
| Role | Access |
|---|---|
| librarian, super_admin (and legacy head_teacher), academic_officer | everything: catalogue CRUD, issue/return/renew/lost, fines, reservations, settings, reports |
| student | browse (active items only), reserve/cancel own, renew own loans, `/me` (loans, fines, reservations) |
| teacher | browse and read settings (read-only) |
| finance_officer, parent, platform | 403 |

Everything is enforced server-side; a student can never read or act on another student's loans/reservations (404).

## Endpoints
- `GET/PUT /settings` — `loan_days, max_loans, max_renewals, fine_per_day, currency, block_on_fines` (PUT audited).
- `GET /items` (q, title, author, isbn, category, kind, available=true, active=true|false [staff], page, limit≤100), `GET /items/:id`, `POST/PUT/DELETE /items`, `GET /categories`.
  - ISBN is normalised (spaces/hyphens removed) and validated as ISBN-10/13 shape. A duplicate ISBN is **not** an error: the response carries `warnings: [{code:'duplicate_isbn'}]`.
  - Lowering `copies_total` below copies on loan/lost → 409. Items with loan/reservation history cannot be deleted (deactivate instead).
  - Each item reports `available`, `active_loans`, `lost_copies`, `held_for_reservation`, `waiting`; for students also `my_loan` / `my_reservation`.
- `GET /student-lookup?matricule=` (staff) — quick check before issuing (active loans, unpaid fines, blocked).
- Loans: `GET /loans` (status=active|overdue|returned|lost, q, student_id, item_id), `POST /loans {item_id, student_id|matricule, due_at?}`, `POST /loans/:id/return|renew|lost`, `POST /loans/:id/fine/pay`, `POST /loans/:id/fine/waive {reason}`.
- `GET /overdue`, `GET /fines?status=unpaid|paid|waived|all`, `GET /stats`.
- Reservations: `GET /reservations` (staff; positions per item), `POST /reservations {item_id}` (student; staff may pass student_id/matricule), `POST /reservations/:id/cancel` (owner or staff), `POST /sweep` (staff).
- `GET /me` (student) — `loans` (with `days_left`, `overdue_days`, `accrued_fine`), `history`, `fines`, `fines_unpaid`, `fines_total` (unpaid + accruing), `reservations` (with queue position).

## Rules
- **Availability** = `copies_total − active loans − lost copies − copies held for a "ready" reservation`. (Spec says total − active loans; lost copies stay out of circulation until the librarian raises `copies_total`, and a copy waiting for a reserver is not given to anyone else.) Digital items are always available and cannot be loaned.
- **Issue** checks (in a transaction holding row locks on the item, then on the student, always in that order): item active, not digital, student active (not withdrawn/graduated), student not already holding the item, `max_loans`, unpaid fines when `block_on_fines`, a free copy that is not held for someone else, and reservation queue order. The student's own `ready` reservation is honoured and becomes `fulfilled`. Concurrent issues of the last copy: exactly one succeeds (tested with 4 parallel requests); `max_loans` cannot be bypassed by parallel requests either.
- **Due date** = now + `loan_days` (a future `due_at` may be passed explicitly).
- **Return** stores `fine_amount = full days late × fine_per_day` (days = `floor((now − due)/24h)`, so < 24 h late costs nothing), sets `returned_at`, and promotes the queue.
- **Renew**: own loan (or staff); refused when overdue, when `max_renewals` reached, or when another student has a waiting/ready reservation on the item. Extends the current due date by `loan_days`.
- **Lost**: copy leaves circulation; fine = max(accrued late fine, `fine_amount` entered by the librarian — the replacement cost; there is no price column).
- **Fines**: `pay` / `waive` (reason ≥ 3 chars) only for open fines; both audited (`academic_audit`: `library.loan.fine.pay|waive`, with reason). Payment is just recorded: no online payment is wired.
- **Reservations**: only for an unavailable item (or one with a queue); one open (waiting/ready) reservation per student per item; FIFO. When a copy comes back (or `copies_total` is raised, or a hold is cancelled/expires) the first waiting reservation becomes `ready`, `notified_at` is set and the student gets an in-app notification (`notifyUsers`; no e-mail/SMS). A `ready` reservation is held **3 days** (`READY_HOURS = 72`); afterwards it is `expired`, the student is told, and the next in line is promoted.
- **Expiry** is applied lazily (on catalogue listing, `/me`, reservation list, issue, reserve) and on demand by `POST /sweep`. There is no background timer: if nobody touches the library for days, holds expire at the next access.
- Audited actions: item create/update/delete, settings, issue, return, renew, lost, fine pay/waive, staff reservation cancel.

## Not done / limits
- No barcode/RFID, no hold on overdue-but-unpaid students beyond fines, no fine payment integration, no e-mail notifications, no per-category loan rules, no teacher loans (schema has `teacher_id` but teachers are read-only here).
- Overdue loans do not block new loans by themselves (only recorded fines do, when `block_on_fines`).
