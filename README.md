# School Management API

Node.js / Express REST API backed by SQLite (via Node.js built-in `node:sqlite`).

## Quick Start

```bash
cd backend
npm install
node src/db/seed.js   # create & seed the database (run once)
npm run dev           # nodemon hot-reload on port 3001
# or
npm start             # production start
```

## Demo Credentials

| Role         | Email                    | Password      |
|--------------|--------------------------|---------------|
| Head Teacher | admin@edutech.com        | admin123      |
| Teacher      | teacher@edutech.com      | teacher123    |
| Secretary    | secretary@edutech.com    | secretary123  |

## Endpoint Reference

All routes are prefixed with `/api/` and require `Authorization: Bearer <token>` except `/api/auth/login`.

| Method | Path | Description |
|--------|------|-------------|
| POST   | /auth/login | Login, returns JWT token |
| GET    | /auth/me | Current user profile |
| PUT    | /auth/me/password | Change password |
| GET    | /dashboard | Aggregated stats |
| GET/PUT | /school | School info |
| GET/POST | /academic/years | Academic years |
| GET/POST | /academic/terms | Terms |
| GET    | /academic/grade-levels | Grade levels |
| GET/POST/PUT/DELETE | /subjects | Subjects |
| GET/POST/PUT/DELETE | /teachers | Teachers |
| GET/POST/PUT/DELETE | /classes | Classes |
| GET    | /classes/:id/students | Students in class |
| GET/POST/PUT/DELETE | /students | Students |
| GET/POST/PUT/DELETE | /parents | Parents |
| GET    | /attendance | Student attendance (filter: ?date=&classId=) |
| POST   | /attendance | Bulk upsert attendance |
| GET    | /attendance/stats | Monthly stats per student |
| GET    | /attendance/teachers | Teacher attendance |
| POST   | /attendance/teachers | Bulk upsert teacher attendance |
| GET/POST/PUT/DELETE | /timetable | Teacher schedule |
| GET/POST/PUT | /marks | Student marks |
| GET/POST/PUT | /report-cards | Report cards |
| PATCH  | /report-cards/:id/status | Change card status |
| GET/POST/PUT | /fees | Fee records |
| GET    | /fees/summary | Aggregated fee stats |
| POST   | /fees/:id/payments | Record a payment |
| GET    | /payroll?month=YYYY-MM | Payroll sheet for month |
| PUT    | /payroll/:teacherId/:month | Update payroll record |
| PATCH  | /payroll/:teacherId/:month/status | Change status |
| PATCH  | /payroll/:month/bulk-status | Bulk status update |
| GET/POST/PUT/DELETE | /announcements | Announcements |
| GET/POST/DELETE | /email-alerts | Email alerts |
| GET/POST/DELETE | /forums/threads | Forum threads |
| GET/POST/DELETE | /forums/threads/:id/messages | Forum messages |
| GET    | /health | Health check |

## Architecture

```
backend/
├── src/
│   ├── index.js          Main Express server
│   ├── db/
│   │   ├── database.js   DatabaseSync setup (node:sqlite)
│   │   ├── schema.js     CREATE TABLE statements
│   │   └── seed.js       Seed with mock data
│   ├── middleware/
│   │   ├── auth.js       JWT verification
│   │   └── errorHandler.js
│   └── routes/           One file per resource
├── data/
│   └── school.db         SQLite database (auto-created)
└── .env                  PORT, JWT_SECRET, DB_PATH, FRONTEND_URL
```

## E-Learning (live classes)

Routes under `/api/elearning` (teacher, student, admin roles). A "course" is
Class + subject + Teacher taken from the timetable (`teacher_schedule`); a student
is enrolled in every course of their own class.

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET  | /elearning/courses | all | Courses the caller teaches / attends |
| GET  | /elearning/sessions | all | Role-scoped class list |
| POST | /elearning/sessions | teacher | Schedule (or `instant: true`) — 409 on teacher/class time conflicts |
| PUT  | /elearning/sessions/:id | teacher | Edit / reschedule (scheduled only) |
| POST | /elearning/sessions/:id/{start,end,cancel} | teacher (cancel: admin too) | Lifecycle |
| POST | /elearning/sessions/:id/join | teacher, student | Returns a signed Jitsi room token; opens an attendance record |
| POST | /elearning/sessions/:id/{heartbeat,leave} | teacher, student | Server-side attendance tracking |
| GET  | /elearning/sessions/:id/attendance | teacher (own), admin | Attendance report incl. absentees |

**Setup:** apply the migration (`prisma migrate deploy` runs automatically on server
boot for every school), then configure Jitsi via the `JITSI_*` variables in
`.env.example`. The public `meet.jit.si` cannot be used: it does not honour
server-signed JWTs, so moderator rights and access control would not be enforced.
For self-hosting, enable JWT auth in Prosody (`authentication = "token"`, same
`app_id` / `app_secret`, `allow_empty_token = false`).

### E-Learning: materials, notifications, reminders

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET  | /elearning/resources | all | Materials visible to the caller (students: own class only) |
| POST | /elearning/resources | teacher | multipart `file` **or** `url`; fields `class_id, subject_name, title, topic?, session_id?` |
| GET  | /elearning/resources/:id/file[?inline=1] | enrolled students, owner, admin | Authorised download / preview |
| DELETE | /elearning/resources/:id | owner teacher, admin | Remove material and file |
| GET  | /elearning/notifications | all | Latest 30 + unread count |
| POST | /elearning/notifications/read | all | `{ids?}` — omit to mark all read |

* **Uploads:** allow-list of extensions (pdf, ppt(x), doc(x), xls(x), txt, csv, zip, png/jpg/gif, mp4/webm, mp3);
  HTML/SVG/executables are rejected. Size cap `ELEARNING_MAX_UPLOAD_MB` (default 10). File bytes are stored in the
  database (`elearning_resources.file_data`) so they persist on ephemeral hosts such as Render's free plan, and are
  served only through the authorised download endpoint. Large videos should be shared as links instead.
* **Notifications are in-app only** (bell icon): class scheduled / rescheduled / cancelled / live, a reminder
  ~15 min before start (job in `src/utils/reminders.js`, checked every minute), and new materials.
  **No email/SMS is sent** — the project has no SMTP integration. Adding one means calling a mailer from
  `src/utils/notify.js`.
* **Not implemented:** session recordings (needs a Jitsi recording backend such as Jibri/JaaS recording and a
  storage policy), saved chat history (chat lives only inside the Jitsi call), in-app slide viewer
  (teachers present with Jitsi screen share; materials are shared as files).

### Tests

`scripts/test-elearning.js` is an end-to-end suite (≈155 checks) for scheduling, conflicts, permissions, join tokens,
attendance, reminders, uploads and downloads. It needs a **throwaway local Postgres** (it refuses to run against
a remote DB) and a running API — see the header of the file for the exact steps.
