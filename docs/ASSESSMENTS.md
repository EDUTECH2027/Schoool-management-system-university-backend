# Assessments — assignments, quizzes, gradebook

Attached to a `CourseOffering`. **Roster = students with `CourseEnrollment.status = 'registered'`** for that offering.
Code: `src/routes/assessments.js` (mounted at `/api/assessments`), `src/assessments/{common,assignments,quizzes,quiz,gradebook}.js`.
Tests: `scripts/test-assessments.js` (314 checks). Frontend: `TeacherAssessments`, `StudentAssessments`, `src/composants/assessments/**`.

## Who can do what
| | lecturer (owner of the offering) | other lecturer | academic officer / admin / head teacher | student on roster | other student | finance, librarian, parent |
|---|---|---|---|---|---|---|
| create / edit / publish / delete assignments & quizzes, edit questions | yes | 403 | 403 (content belongs to the lecturer) | 403 | 403 | 403 |
| list/view submissions, attempts, stats, gradebook | yes | 403 | yes (oversight) | own only | 403 | 403 |
| grade a submission / override a quiz score | yes | 403 | yes | 403 | 403 | 403 |
| download a submission file | yes | 403 | yes | own file only | 404 | 403 |
| submit / take quiz | – | – | – | yes | 403 | 403 |
| CA export preview | yes | 403 | yes | 403 | 403 | 403 |
| CA export (real write) | yes | 403 | **403** (see below) | 403 | 403 | 403 |

Students never see drafts (404). A student not on the roster gets 403 on offering-scoped resources (and empty lists). Tenant isolation comes from `req.db` (another school's ids give 404).

## Endpoints (all `Authorization: Bearer`)
- `GET /offerings[?termId]` — lecturer: own; staff: all; student: registered ones (with assignment/quiz counts).
- Assignments: `GET /assignments[?offering_id&term_id]`, `POST /assignments`, `GET|PUT|DELETE /assignments/:id`, `POST /assignments/:id/status {status}`,
  `GET /assignments/:id/submissions`, `POST /assignments/:id/submissions/:sid/grade {score, feedback?, status: graded|returned}`,
  `POST /assignments/:id/submit` (JSON `{text}` or multipart `text` + `file`), `GET /assignments/:id/submissions/:sid/file[?inline=1]`.
- Quizzes: `GET /quizzes`, `POST /quizzes`, `GET|PUT|DELETE /quizzes/:id`, `POST /quizzes/:id/status`,
  `POST /quizzes/:id/questions`, `PUT /quizzes/:id/questions/reorder {ids}`, `PUT|DELETE /quizzes/:id/questions/:qid`,
  `POST /quizzes/:id/attempts` (start/resume), `GET /quizzes/:id/attempts/mine`, `GET /quizzes/:id/attempts/:aid`,
  `PUT /quizzes/:id/attempts/:aid/answers {responses}`, `POST /quizzes/:id/attempts/:aid/submit {responses?}`,
  `GET /quizzes/:id/attempts` (lecturer/staff), `GET /quizzes/:id/stats`, `POST /quizzes/:id/attempts/:aid/override {score, note}`.
- Gradebook: `GET /gradebook/me`, `GET /gradebook/:offeringId`, `POST /gradebook/:offeringId/export-ca {dry_run, student_ids?}`.

## Assignments
- Status `draft → published → closed` (`closed → published` reopens, `published → draft` only with no submissions). Students are notified on first publish. Delete only when there are no submissions (409, "close instead").
- `max_score` cannot change after a submission was graded; `allow_text/allow_file` cannot change after anyone submitted.
- Submission: text and/or one file; empty → 422; text > 20 000 chars → 422. Files are stored in `assignment_submissions.file_data` (Bytes), limited by `ELEARNING_MAX_UPLOAD_MB` (default 10; 413 above), allowed extensions = the e-learning list (`src/utils/elearningUploads.js`); the content type served is derived from the extension, never from the client. Downloads send `nosniff`, a sandbox CSP and `attachment` (inline only for the safe types).
- After `due_at`: refused (409 `past_due`) unless `allow_late`, in which case `is_late = true`. A resubmission **replaces the whole previous submission** (text and file) and recomputes `is_late`; it is refused (409) once graded/returned (compare-and-set, so a grade and a resubmission racing cannot both win).
- Grading: `0 ≤ score ≤ max_score`; status `graded` or `returned`; audited (`academic_audit`); student notified.
- Notifications (best effort via `safe`): students on publish and on grade/return; lecturer on every (re)submission.

## Quizzes
- Questions: `single`, `multiple` (all-or-nothing), `true_false`, `short` (accepted answers; compared case-/whitespace-insensitively after Unicode NFC — accents are significant). Points per question, optional explanation. Answers live in `quiz_questions.answer` and are **only** returned to lecturer/staff or in a student's review once allowed.
- Questions cannot be added/edited/deleted once any attempt exists (409); reorder stays possible. Publishing needs ≥ 1 question.
- Window: `opens_at`/`closes_at`; attempts: `max_attempts`; `duration_minutes` (null = untimed). `deadline_at = min(start + duration, closes_at)`, set by the server. Moving `closes_at` earlier, or closing the quiz, also ends attempts already running.
- Start is **idempotent and race-safe**: an open attempt is returned instead of creating another; creation relies on `UNIQUE(quiz_id, student_id, attempt_no)` — of N concurrent starts exactly one insert wins, so `max_attempts` can never be exceeded.
- Autosave `PUT …/answers` merges responses; after the deadline it answers 409 `expired` and the attempt is auto-submitted. `POST …/submit` after the deadline **ignores the payload** and grades only what was saved (the client clock is never used; server time is returned as `server_now` for the countdown). Any access (student, lecturer list, student quiz list) auto-submits attempts whose deadline passed (`answers.auto_submitted = true`, `submitted_at` = deadline).
- Shuffle: question order is shuffled on the server per attempt and stored in `question_order`.
- Answers reveal: only if `show_answers` **and** (`closes_at` passed **or** status `closed`) **and** the requesting student's attempt is finished. Otherwise the student gets only the score (no per-question correctness, no explanations, no answers). Covered by leak tests (`"answer"`, explanations and correct texts are searched for in every student-facing payload).
- Storage workaround (no schema change): `quiz_attempts.answers` = `{responses, saved_at, graded:{qid:{correct,points}}, auto_score, override?:{score,note,by,at,previous}, auto_submitted?}`. Attempt `status` is `in_progress` or `graded` (auto-graded on submit; `submitted` is unused).
- Lecturer: attempts per student, per-question stats (correct %, option distribution), attempt review, score override (note required, audited, student notified).

## Gradebook and CA
- Columns: published/closed assignments and quizzes (drafts never count).
- An item **counts for a student only when graded**: a graded/returned assignment, or ≥ 1 finished quiz attempt (best attempt by percentage). Submitted-but-ungraded = `pending`, none = `missing`; neither is treated as zero.
- `CA = Σ(pct_i × weight_i) / Σ(weight_i)` over counted items, 0–100, 2 decimals; `null` if nothing is graded. Each line reports `counted / pending / missing / total` so the lecturer can see what is not included before exporting.
- Export to marks: `POST /gradebook/:offeringId/export-ca`. **Default is a dry-run preview** (`dry_run` must be explicitly `false` to write). The real write is for the offering's own lecturer only (an approver going through `saveMark` would publish the mark directly) and requires an open marks session like the existing lecturer mark entry (403 `marks_closed`). It uses `getScheme` + `saveMark` from the results code: the existing exam score / absence / resit are passed back unchanged, the mark stays `draft`, `mark_history` records the change, an `assessments.export_ca` audit row is written. Students with no graded item or whose mark is `submitted/approved/published` are skipped and listed with the reason. Re-exporting unchanged values reports `unchanged`.

## Env vars / limits
`ELEARNING_MAX_UPLOAD_MB` (default 10). Text answer 20 000 chars; quiz ≤ 200 questions, ≤ 12 options; short answer 1 000 chars; attempts ≤ 20; duration ≤ 600 min.

## Not done / known limits
- No file attachments on questions, no question banks, no manual grading of free text (short answers are exact-match only), no partial credit for `multiple`.
- Quiz percentage in the gradebook uses the best attempt only (policy choice); other policies (last/average) are not configurable.
- Late-penalty rules are not implemented (late work is flagged, not penalised).
- In-app notifications only (no e-mail/SMS). No plagiarism check or virus scanning of uploads (type allow-list + sandboxed download only).
- Submissions of students who later leave the roster remain visible to the lecturer ("not on roster") and are excluded from the gradebook.
