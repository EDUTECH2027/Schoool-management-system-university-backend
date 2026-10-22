# Executive analytics

Read-only dashboards for the university leadership. Code: `src/routes/analytics.js`, `src/analytics/{engine,cache,csv}.js`.
Frontend: `EDUTECH/src/pages/academics/Analytics.tsx`, `EDUTECH/src/composants/analytics/charts.tsx`, `EDUTECH/src/api/analytics.ts`.

## Access

| Endpoint | super_admin / head_teacher | academic_officer | finance_officer | others |
|---|---|---|---|---|
| `GET /api/analytics/filters` | yes | yes | yes | 403 |
| `overview`, `academics`, `attendance`, `exams`, `trends` | yes | yes | **403** | 403 |
| `finance` | yes | **403** | yes | 403 |

No finance number appears in any other endpoint. The page hides the Finance tab for roles that cannot call it.

## Filters (all optional, all endpoints)

`academic_year_id`, `term_id`, `programme_id`. `term_id` wins over the year; a term must belong to the given year (422); unknown ids → 422.
Programme = the cohort's programme (marks use the class recorded on the mark, falling back to the student's current class). Finance ignores the semester (fees are per academic year, matched on `fee_records.academic_year` = year label).
`trends` ignores `term_id` (it is the series).

## Numbers (what exactly is counted)

* **Academic figures use PUBLISHED marks only.** A course counts as *passed* on the first sit (`total_score ≥ pass_mark`) or on the resit (`min(resit_score, resit_cap) ≥ pass_mark`), the same rule as `GradingScheme.markPassed`. GPA = credit-weighted grade points of the mark's `grade` (scheme bands), per student over the selected scope; histogram bins of 0.5 up to the scheme maximum.
* `overview`: students total/active/graduated/withdrawn/suspended (programme filter only); by programme / level / gender are **active** students; lecturers; course offerings (total/open, in scope); registrations per semester (status `registered`: registrations, distinct students, credits, average credits per student); pending exception requests (`pending_approval`); results awaiting validation (`submitted`, plus `approved` not yet published and drafts); open service requests; open grade appeals.
* `academics`: pass rate per course/semester/programme, grade distribution, GPA histogram + mean/median, hardest/easiest courses (`min_sample`, default 5 marks, top 5), appeals by status (upheld rate = upheld / (upheld + rejected)), progression outcomes.
* `attendance`: rate = (present + late) / all records (excused days stay in the total – same definition as the student profile); by class, by programme, students below `threshold` (default 75 %, at least `min_records`, default 5 records; list capped at 200 lowest, count is exact). Semester filter = the semester's date range.
* `exams`: candidates, eligible / ineligible (+ rate), overrides, attendance recorded, ineligible by reason (from `ineligible_reasons`), per-session table.
* `finance`: due / collected / outstanding / overdue / collection rate over non-waived fee records; by due month and programme; cash received by month (`payments`); payment-method split from **successful** `payment_transactions` (provider) and, separately, manually recorded payments. *Overdue* = status `overdue` or balance > 0 with a due date in the past.
* `trends`: per semester: registered students, average credits, pass rate, average score, mean GPA, attendance rate, and the change versus the previous semester.

## Performance design

One scan per table family, rolled up in memory (marks → a (course, semester, programme, grade) cube; attendance → (student, class) groups; trends → (semester, student) groups), set-based SQL (`$queryRaw`), no per-row queries.
In-memory TTL cache per school and filter set: `ANALYTICS_CACHE_TTL_SEC` (default 60, `0` disables); responses carry `X-Cache: hit|miss`, `cached`, `cache_age_seconds`, `compute_ms`.
`?refresh=1` recomputes and drops **all** cached entries of that school (explicit invalidation); the page's *Refresh* button uses it. Data written meanwhile is not visible before the TTL expires or a refresh – by design.

Measured by `scripts/test-analytics.js` on a seeded school of **2,004 students, 24,000 published marks, 80,000 attendance records, 24,000 enrolments, 4,000 fee records, 12,000 exam candidates**
(Windows laptop, 4 cores, shared with other test suites; best of 3 forced recomputes, wall-clock including HTTP, auth and JSON):

| endpoint | computed (best of 3) | all 3 runs (ms) |
|---|---|---|
| overview | 640 ms | 748 / 1056 / 640 |
| academics | 425 ms | 881 / 643 / 425 |
| attendance | 272 ms | 345 / 313 / 272 |
| exams | 602 ms | 602 / 998 / 890 |
| finance | 159 ms | 1339 / 159 / 164 |
| trends | 538 ms | 1360 / 538 / 633 |

Cached answers: ≈ 10–120 ms when the machine is idle. **Caveat:** the first run after a cold start (Prisma warm-up) and runs while the machine is busy exceed 1 s (see the "all runs" column); the steady-state figure is under 1 s but the 1 s bound is not guaranteed under heavy contention.

## CSV export

`?format=csv[&table=<name>]` on every endpoint (UTF-8 with BOM, formula-safe). Tables — overview: `by_programme, by_level, by_gender, registrations`; academics: `pass_by_course, pass_by_term, pass_by_programme, grade_distribution, gpa_histogram, hardest_courses, easiest_courses`;
attendance: `by_class, by_programme, below_threshold`; exams: `sessions, ineligible_by_reason`; finance: `by_month, by_programme, payment_methods, cash_received_by_month`; trends: `series`. Unknown table → 422.

## Frontend

Filters (year → semester, programme), tabs (Overview, Academics, Attendance, Exams, Finance, Trends), KPI cards, hand-written SVG charts (ranked bars, columns/histogram, lines, donut – no chart library; each has a title, a visually hidden data table and tooltips),
CSV buttons, *Print* (filter bar and buttons hidden, cards kept whole), dark-mode safe, 390 px layout without page-level horizontal scroll (wide tables/charts scroll inside their card).

## Not done

No drill-down to individual students from charts, no scheduled reports/e-mail, no cross-year cohort tracking (graduation rates over time), no comparison between two filter sets, no persistence of the chosen filters. The cache is per process.
