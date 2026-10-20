# University academic module (Phase 1 + 2)

Foundation (structure, course catalogue, registration) and results (grading, validation workflow, exams, progression, official documents).
Everything is enforced **on the server**; the browser only displays verdicts.

## Data model

`Faculty → Department → Programme`. A **Class stays a cohort** and is attached to a Programme (`classes.programme_id`).
`Subject` is the course catalogue (department, level, usual semester, credits, prerequisites, active flag).
`CourseOffering` = a course taught in a semester (section, lecturer, capacity, weekly slots).
`RegistrationPeriod` (per semester, optionally per programme/level) holds the window, add/drop deadline, credit min/max, and whether exception requests are allowed.
`CourseEnrollment` = a student's registration (`registered | pending_approval | rejected | dropped`, kind `regular | retake | exception`).
Results: `Mark.status` (`draft → submitted → approved → published`), `MarkHistory`, `GradingScheme`/`GradeBand`, `GradeAppeal`.
Exams: `ExamSession`, `ExamInvigilator`, `ExamCandidate`. Progression: `ProgressionDecision`, `StudentEnrollmentHistory`.
Documents: `OfficialDocument` (immutable snapshot + public verification code). `AcademicAudit` = append-only action log. `AcademicSettings` (id `main`) = exam eligibility + progression thresholds.

## Migrations (tenant schema, applied automatically at boot)

| Migration | Content |
|---|---|
| `20261020100000_academic_foundation_and_results` | all tables above + backfill (see below). **Never edit — already applied.** |
| `20261020110000_academic_audit` | `academic_audit` table |

Backfill of existing data: every existing mark becomes `published` (students keep seeing what they saw); a default grading scheme reproducing the previous hard-coded rules (CA 40 / Exam 60, pass 50, A+ 90 … F 0); one Programme per existing Class (`PRG-xxxxxxxx`, under a "General" faculty/department); enrolment-history snapshot per student; `academic_settings` row.
New schools get the same defaults because the template schema is migrated too.

## Roles

New role **`academic_officer`** (registry / academic affairs): everything in `/api/academics`, `/api/results`, `/api/exams`, `/api/progression`, `/api/documents`; no access to finance. `super_admin` can do all of it as well (and sees the finance block of a student file). Create the account in *User management*.

## Endpoints

| Area | Endpoints |
|---|---|
| Structure (`/api/academics`) | `faculties`, `departments`, `programmes` CRUD (409 when children exist) · `PUT classes/:id/programme` · `GET classes` · `GET/PUT programmes/:id/curriculum` |
| Catalogue (`/api/subjects`) | CRUD; `prerequisite_ids` with loop detection; delete blocked (409) when marks/offerings exist — archive with `is_active:false` |
| Offerings | `GET/POST/PUT/DELETE offerings` (teacher clash → 409, override with reason) · `GET offerings/:id/roster` |
| Registration periods | `GET/POST/PUT/DELETE registration-periods` |
| Registration (staff) | `GET registrations` (queue) · `POST registrations/:id/decision` · `POST registrations` (on behalf, override needs reason) · `POST registrations/:id/drop` |
| Registration (student, `/api/registration`) | `GET me`, `POST me/enroll`, `POST me/drop`, `GET me/summary`, `GET me/profile` |
| Student file | `GET /api/academics/students/:id/profile` · `GET /api/academics/audit` |
| Lecturer (`/api/lecturer`) | `GET offerings`, `GET offerings/:id/roster`, `POST offerings/:id/marks` (drafts), `POST offerings/:id/submit` |
| Results (`/api/results`) | `GET batches`, `GET marks`, `GET marks/:id/history`, `POST transition {approve,publish,reject,reopen}` · `GET/PUT scheme` · `GET/PUT settings` · student `GET me`, `POST me/appeals` · `GET appeals`, `POST appeals/:id/decision` |
| Exams (`/api/exams`) | CRUD + conflicts (room, invigilator, students), `cancel`, `complete`, `candidates/generate`, `GET candidates`, `candidates/:studentId/override`, `attendance`, student `GET me/timetable` |
| Progression (`/api/progression`) | `POST run`, `GET /`, `POST :id/decision`, `POST :id/apply`, student `GET me` |
| Documents (`/api/documents`) | `POST issue`, `GET /`, `GET me`, `GET :id` (with QR), `POST :id/revoke` · **public** `GET /api/verify/:code` (30 checks/min/IP) |

## Registration rules (single engine: `src/academics/registration.js`)

*Blockers* (cannot register): no/closed period, course closed or full, already registered, timetable clash, credit ceiling, inactive/graduated student.
*Exceptions* (a reviewer must approve; only if the period allows): missing prerequisite, course outside the programme curriculum (only when the programme has one), course already passed.
Seats are protected by a row lock on the offering (verified: 3 students racing for 2 seats → exactly 2 succeed).

## Behaviour changes to know about

* A lecturer's marks are **drafts**. Students/parents, GPA, transcripts and progression use **published** marks only. Administrators' direct entries are published immediately.
* Published/submitted marks are locked for lecturers; changes are recorded in `mark_history`.
* `/api/marks` is now staff-only (students and parents use the portal endpoints); `POST/PUT` is administrators/academic officers only.
* Totals and grades come from the configured grading scheme (default = the old rules).
* A course with marks or offerings can no longer be deleted (archive it).
* **Deploy order matters:** an old backend (before this change) running against the migrated database writes marks as `draft`, which students cannot see until published in *Results validation*. Deploy the new backend promptly after the migration is applied.

## Deploying

1. Deploy the backend (migrations run at boot for every school schema).
2. Set `FRONTEND_URL` (already used elsewhere): QR codes on documents point to `<FRONTEND_URL>/verify/<code>`.
3. Deploy the frontend (`vercel.json` already rewrites all paths to `index.html`, so `/verify/<code>` works).
4. Create an `academic_officer` user, then in the UI: Structure → Catalogue → Offerings → Registration periods.
5. Lecturers can enter marks only while a **marks session** (existing Assessments feature) is open.

## What is NOT done in this phase

Not implemented (later phases of the master plan): assignments/quizzes in e-learning, student service requests, e-mail/SMS notification centre beyond the in-app notifications already present, library, rooms/timetable engine beyond slot-clash detection, executive analytics, careers/alumni, thesis, AI assistant, MFA.
Grade-point/credit rules for **resits** use the existing resit fields; there is no separate resit exam workflow beyond scheduling an exam of kind `resit`.
Exam eligibility by attendance uses the existing attendance records; a student with no attendance records is not blocked.

## Tests

`node scripts/test-academics.js` (needs the API on `API_URL`, default `http://127.0.0.1:3099`, and a **local** `DATABASE_URL`; refuses remote databases) — 173 checks.
