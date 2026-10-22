# Careers & alumni

Mounted at `/api/careers` (`src/routes/careers.js`, helpers in `src/careers/util.js`). Tests: `scripts/test-careers.js`.
All endpoints need a login; tenant isolation is automatic (`req.db`). Staff = `super_admin`/`head_teacher`/`academic_officer`.

## Job board
| Endpoint | Who | Notes |
|---|---|---|
| `GET /jobs?kind&q&page&limit` | student, teacher, staff | Students/teachers: only `status=open` and `deadline` null or today/future. Staff: all, plus `status` filter and `applicant_count`. Students get `my_application`. |
| `GET /jobs/:id` | same | Non-staff get 404 for draft/closed. |
| `POST /jobs`, `PUT /jobs/:id`, `DELETE /jobs/:id` | staff | kind `job/internship/volunteering`; status `open/closed/draft`; `apply_url` http(s) only; e-mail and `YYYY-MM-DD` validated. |
| `POST /jobs/:id/close`, `/reopen` | staff | atomic; 409 if already in that state. |
| `POST /jobs/:id/apply` | student (`active` or `graduated`) | `{cover_note}` max 2000. One application per (job, student): duplicate/parallel → 409. A withdrawn application can be re-submitted. Closed/expired → 409. |
| `POST /applications/:id/withdraw` | owner | only `submitted`/`shortlisted`. Others get 404. |
| `GET /my-applications` | student | own only. |
| `GET /jobs/:id/applications` | staff | applicant name, matricule, programme, cover note. |
| `PUT /applications/:id/status` | staff | `shortlisted/rejected/hired`; notifies the student (in-app); not allowed on withdrawn. |

## Alumni
Choice: **any student may maintain their own profile** (`GET/PUT /alumni/me`) so it can be prepared before graduation; it is private (`is_public=false`) until the owner opts in. Staff cannot change consent.
* `GET /alumni?q&programme_name&year&employer&city&page` (student/teacher/staff): only `is_public` profiles; fields exposed: name, graduation_year, programme_name, employer, position, city, bio, linkedin_url, contact_email. Never matricule, phone, student id or consent flag. `GET /alumni/filters` gives selectable programmes/years.
* Staff: `GET /alumni/register` (all profiles, matricule, public flag, count of graduates without a record), `GET /alumni/export.csv` (UTF-8 BOM, formula-injection neutralised, audited), `POST /alumni/invite` (notifies graduates whose profile is missing/empty), `POST /alumni/bulk-create` (private records for graduates without one; idempotent), `PUT /alumni/:studentId` (staff correction; cannot set `is_public`), `GET /alumni/stats?top=N`.
* Statistics: `response_rate = profiles with employer/position / (graduates ∪ profile owners)`; `employed_share = profiles with an employer / responded`; by programme, by year, top-N employers (case-insensitive).

## Validation
Control characters stripped; lengths enforced (title 160, company 120, description 5000, bio 2000, cover note 2000, URLs 500); URLs http/https only. Text is stored as plain text and rendered escaped by React; links are only made clickable when they start with http(s).

## Audit
`job.*`, `alumni.invite|bulk_create|export|update`, `job.application_status` rows in `academic_audit`.

## Not done / limits
* Directory consent is all-or-nothing (the schema has no per-field visibility column): the alumnus controls what is exposed by which fields they fill in.
* Notifications are in-app only (no SMTP).
* No resume/CV upload for applications; cover note only.
* Teachers can browse jobs and the directory through the API but have no dedicated careers page.
