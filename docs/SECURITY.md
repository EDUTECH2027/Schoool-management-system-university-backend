# Security hardening (no MFA)

Scope: lockout, rate limiting, password policy, token invalidation, security events, safe headers/errors,
trust-proxy handling and a super-admin Security centre. **Multi-factor authentication is explicitly out of scope and not implemented.**

Code: `src/security/*` (config, limiter, rateLimit, policy, events, sessions), `src/routes/auth.js`, `src/routes/security.js`,
`src/middleware/{auth,authorize,errorHandler}.js`, the middleware block of `src/index.js`, the password lines of `src/routes/users.js`.
Frontend: `EDUTECH/src/pages/academics/SecurityCenter.tsx`, `EDUTECH/src/api/security.ts`.

## Environment variables (all optional, read at request time)

| Variable | Default | Meaning |
|---|---|---|
| `LOGIN_MAX_FAILURES` | 5 | failed password attempts before an account locks |
| `LOGIN_LOCK_MINUTES` | 15 | lock duration (decimals allowed, e.g. `0.05`) |
| `RATE_LOGIN_IP_MAX` / `RATE_LOGIN_IP_WINDOW_SEC` | 60 / 900 | **failed** sign-ins per client IP (login + matricule login); successes do not count, so a school behind one NAT is not penalised |
| `RATE_LOGIN_ACCOUNT_MAX` / `_WINDOW_SEC` | 20 / 900 | login requests per account (e-mail) – counts every attempt |
| `RATE_RESET_IP_MAX` / `_WINDOW_SEC` | 30 / 900 | forgot-password, reset-status, reset-password requests per IP |
| `RATE_RESET_ACCOUNT_MAX` / `_WINDOW_SEC` | 8 / 900 | same endpoints, per e-mail |
| `RATE_GLOBAL_MAX` / `RATE_GLOBAL_WINDOW_SEC` | 3000 / 60 | generous per-IP limit on the whole `/api` (health check and provider webhooks excluded) |
| `AUTH_USER_CACHE_SEC` | 15 | how long `password_changed_at` is cached per user (explicitly refreshed in-process on every change) |
| `BODY_LIMIT_DEFAULT` / `BODY_LIMIT_LARGE` | 2mb / 10mb | JSON body limits; "large" applies to finance, migrate, platform, students, teachers, school, elearning, fees, payroll, notification-center |
| `TRUST_PROXY` | unset (`1` when `RENDER` is set) | number of proxy hops, `true`, or a CSV/subnet list for Express `trust proxy` |
| `CORS_ORIGINS` | unset = any origin | comma-separated allow-list of browser origins |
| `SECURITY_LOG_DENIED` | on | `off` disables `permission_denied` events |
| `NODE_ENV=production` | | enables HSTS and generic 5xx messages |

## Behaviour

**Lockout.** Wrong passwords increment `users.failed_logins` atomically; at `LOGIN_MAX_FAILURES` the account gets
`locked_until = now + LOGIN_LOCK_MINUTES` and the counter restarts. While locked every login answers `429 {code:"locked", retry_after_seconds}` without
checking the password (a correct password is not confirmed). A success resets the counter. The matricule (student) login has no password, so it only
honours `locked_until` and is slowed by the per-IP failure gate. A wrong *current* password on `PUT /auth/me/password` also counts.
Platform admins and unknown e-mails share an in-memory lockout with identical behaviour (401 until the threshold, then 429), so the response sequence does not reveal whether an
address exists; a dummy bcrypt comparison equalises timing. Messages are generic (`Invalid email or password`, `Invalid Student ID`).
The in-memory part resets when the process restarts (real accounts are persisted in the database).

**Rate limiting.** In-memory sliding windows (single process – like `routes/documents.js`; behind several instances the limits are per instance). 429 responses carry
`Retry-After`; a `rate_limited` event is written once a minute per IP and scope (tenant resolved from a valid token or the login e-mail).

**Password policy** (`src/security/policy.js`): 8–72 bytes, not only spaces, not a single repeated character, not equal to the e-mail / local part / name, not in a short common-password list,
and different from the current one on a self-service change. Enforced on `PUT /auth/me/password`, `POST /auth/reset-password`, `POST /users`, `PATCH /users/:id/password`
with `422 {error, code:"weak_password"}`. Not covered (owned by other modules): accounts created by `students.js` / `teachers.js` / `migrate.js` with generated passwords.

**Token invalidation.** `users.password_changed_at` is set on every password change (self, reset request, admin patch, forced reset). `middleware/auth.js` rejects a JWT whose
`iat` is earlier than that instant with `401 {code:"session_revoked"}` (second resolution: a token issued in the same second as the change is still accepted). The session that
performed a *self-service* change keeps working: its exact token is remembered (hash only, in memory, until it expires) and the response also returns a fresh `token` the client may adopt.
After an API restart that exemption is gone and the user simply signs in again. Harness-style forged JWTs (users that never changed a password) are unaffected.

**Security events** (`security_events`): `login_success`, `login_failed`, `account_locked`, `account_unlocked`, `password_changed`, `password_reset_forced`,
`permission_denied` (403 from `authorize`, collapsed to one per user and route per minute and at most 30 per user and hour), `rate_limited`. Stored: type, e-mail, user id, IP, user agent
(truncated to 200), small `detail` (reason codes, route). Never passwords, tokens or request bodies. Failed logins of unknown e-mails cannot be attributed to a school and are not stored.
No automatic retention job: delete old rows with SQL if needed.

**Headers / errors.** Helmet defaults (no `X-Powered-By`, nosniff, frame deny, referrer `no-referrer`, HSTS in production), a `default-src 'none'; frame-ancestors 'none'` CSP and a
`Permissions-Policy` on `/api` only (the desktop build also serves the SPA from the same server), `Cache-Control: no-store` on auth/security/assistant. JSON bodies: 400 for malformed JSON, 413 over the limit.
The error handler never sends stack traces; in production 5xx messages are generic.

## `/api/security` (super_admin / head_teacher only; every other role 403)

| Endpoint | |
|---|---|
| `GET /config` | effective thresholds (`mfa:false`) |
| `GET /events?type=a,b&email=&user_id=&ip=&from=&to=&page=&limit=` | paged (max 200), newest first |
| `GET /events/export` | same filters, CSV (≤ 10 000 rows, formula-safe) |
| `GET /summary?days=14` | per-day counts, totals, top IPs by failures, currently locked accounts, `must_change_password` count |
| `POST /users/:id/unlock` | clears lock + counter, event `account_unlocked` |
| `POST /users/:id/force-reset {revoke_sessions?}` | sets `must_change_password`; by default also revokes open sessions |

## Tests

`node scripts/test-security.js` (spawns its own API instances: default thresholds, production mode, strict limits with `TRUST_PROXY=1`, and a low global limit).

## Not done / limits

No MFA. In-memory limiters are per process. Unknown-address failures are not logged. Old events are not purged automatically. Other modules that create user accounts do not apply the password policy.
