# Notification centre, broadcasts and e-mail delivery

Code: `src/routes/notificationCenter.js` (`/api/notification-center`), `src/utils/notify.js`, `src/utils/mailer.js`, `src/services/mailWorker.js`, `src/services/audience.js`. Tests: `scripts/test-notifications.js`.

## In-app notifications (any logged-in role, own data only)
`GET /` (`page`, `limit`, `unread=1`, `type`), `GET /unread-count`, `POST /read {ids?}` (all when no ids), `POST /:id/read`, `DELETE /:id`. The existing `/api/elearning/notifications` bell endpoints read the same table and keep working.

## Preferences
`GET|PUT /preferences` → `{ in_app, email, muted_types[], always_delivered, email_configured }`. Defaults: everything on. `security` and `must_read` can never be muted (422) and are delivered even when `in_app=false`. `in_app=false` or a muted type suppress NON-critical notifications (and their e-mail). `GET /email-status` tells any user whether SMTP is configured.

## `notifyUsers(db, userIds, {type,title,body,link})` (src/utils/notify.js)
Signature and return value (in-app rows created) are unchanged; failures still propagate only if the in-app insert itself fails (callers wrap with `safe`). New behaviour:
* Preferences are applied (see above).
* For types in `EMAIL_TYPES` = `broadcast, must_read, service_update, results_published, registration_decision, appeal_decision, exam_rescheduled`, users with an address and `email=true` (and the type not muted) get an `email_outbox` row. If SMTP is not configured the row is written as `skipped` with the reason, otherwise `queued`. E-mail problems are logged, never thrown.
* Optional `channels: ['in_app'|'email']` restricts delivery (used by broadcasts). `notifyDetailed` returns `{in_app, email}` counts.

## Broadcasts (super_admin, academic_officer)
* `GET /broadcasts/options` — roles, programmes, classes, current-term offerings, caps, `email_configured`.
* `POST /broadcasts/preview {audience}` → recipients, `with_email`, breakdown. `POST /broadcasts {title(3–150), body(≤5000), channels[], must_read?, audience}` → creates the `broadcasts` row and notifications (type `broadcast`, or `must_read`, which ignores preferences). `GET /broadcasts` history with delivery counts. Audited (`broadcast.send`).
* Audience = union of: `roles` (active students only for `student`), `programme_ids` / `class_ids` (active students), `offering_ids` (students with a `registered` enrolment). Unknown ids → 422; ≤50 ids per list; recipients ≤ `BROADCAST_MAX_RECIPIENTS` (5000) else 422; empty audience → 422. Offerings target students only (not the lecturer).
* E-mail-only broadcast while SMTP is unconfigured → 409; combined with in-app it is accepted and the response carries a warning (rows are `skipped`).

## E-mail
`utils/mailer.js` (nodemailer): `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`; `isConfigured()` = host and from/user set. Worker (`MAIL_WORKER=off` disables; `MAIL_WORKER_INTERVAL_MS`, default 30 s) starts when the router file loads, sweeps all active tenant schemas (like `utils/reminders.js`) only while SMTP is configured, claims rows atomically (no double send across instances), max 3 attempts (error stored, row stays `queued` until the third failure → `failed`). Staff endpoints: `GET /outbox` (counts by status, SMTP state, rows, `status` filter, paging), `POST /outbox/process` (run the worker for this school now; with SMTP unconfigured it marks queued rows `skipped`), `POST /outbox/retry {ids?}` (failed/skipped → queued, attempts reset).

## Limits / not done
Plain-text mail only (no HTML templates, no unsubscribe link, no per-recipient personalisation); no SMS/WhatsApp; no push; no scheduled broadcasts; no read receipts per broadcast; outbox rows are never purged; preferences are not applied to modules that insert into `notifications` directly instead of calling `notifyUsers`.
