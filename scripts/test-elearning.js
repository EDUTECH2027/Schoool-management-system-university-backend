// End-to-end test for the e-learning module against a LIVE API + a THROWAWAY Postgres.
//
//   1. Point DATABASE_URL (+ PLATFORM_/TENANT_TEMPLATE_ URLs) at a scratch local Postgres,
//      run `prisma migrate deploy` for both schemas.
//   2. Start the API with the SAME env, plus JITSI_DOMAIN/JITSI_APP_ID/JITSI_APP_SECRET,
//      JWT_SECRET, ELEARNING_MAX_UPLOAD_MB=1, ELEARNING_REMINDERS=off.
//   3. node scripts/test-elearning.js     (API_URL defaults to http://127.0.0.1:3099)
//
// It creates two throwaway schools in the platform DB and seeds them directly, then drives
// everything through the HTTP API with real signed JWTs. Refuses to run on a non-local DB.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing to run: DATABASE_URL must point at a local scratch database.'); process.exit(2);
}
const platformClient = require('../src/db/platformClient');
const tenantPool = require('../src/db/tenantPool');
const { provisionTenantSchema } = require('../src/db/provisionTenant');
const { runOnce } = require('../src/utils/reminders');

const BASE = process.env.API_URL || 'http://127.0.0.1:3099';
const SECRET = process.env.JWT_SECRET || 'dev_secret';
const JITSI_SECRET = process.env.JITSI_APP_SECRET;

let failures = 0, passes = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log(`  [OK]   ${label}`); }
  else { failures++; console.error(`  [FAIL] ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const section = t => console.log(`\n── ${t}`);

async function call(method, url, { token, body, form, raw } = {}) {
  const headers = { ...(token && { Authorization: `Bearer ${token}` }) };
  let payload;
  if (form) payload = form; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}/api${url}`, { method, headers, body: payload });
  if (raw) return res;
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json };
}

const mkToken = (schoolId, u) => jwt.sign({
  id: u.id, email: u.email, role: u.role, name: u.name, initials: 'XX',
  teacher_id: u.teacher_id || null, student_id: u.student_id || null, parent_id: null,
  school_id: schoolId, scope: 'tenant', must_change_password: false,
}, SECRET, { expiresIn: '1h' });

const iso = ms => new Date(Date.now() + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;

async function seedSchool(label) {
  const schoolId = uuid();
  await platformClient.school.create({ data: { id: schoolId, name: `Test ${label}`, email: `${schoolId}@t.local`, admin_name: 'Adm', admin_email: `adm-${schoolId}@t.local`, status: 'active' } });
  await provisionTenantSchema(schoolId);
  const db = tenantPool.getOrOpen(schoolId);
  const mkClass = (name) => db.class.create({ data: { id: uuid(), name } });
  const clsA = await mkClass('Class A'), clsB = await mkClass('Class B');
  const mkTeacher = (n) => db.teacher.create({ data: { id: uuid(), first_name: n, last_name: 'Teacher', email: `${n}-${uuid()}@t.local` } });
  const t1 = await mkTeacher('Tina'), t2 = await mkTeacher('Tom');
  const sched = (t, c, subject, period) => db.teacherSchedule.create({ data: { id: uuid(), teacher_id: t.id, day: 'monday', period_key: period, class_id: c.id, subject_name: subject } });
  await sched(t1, clsA, 'Math', 'p1'); await sched(t1, clsB, 'Physics', 'p2');
  await sched(t2, clsA, 'Chemistry', 'p3'); await sched(t2, clsB, 'Biology', 'p4');
  const mkStudent = (n, c, active = true) => db.student.create({ data: { id: uuid(), student_number: `M-${uuid().slice(0, 8)}`, first_name: n, last_name: 'Student', class_id: c.id, is_active: active } });
  const stud = { a1: await mkStudent('Ann', clsA), a2: await mkStudent('Abe', clsA), a3: await mkStudent('Amy', clsA), b1: await mkStudent('Bob', clsB), inactive: await mkStudent('Old', clsA, false) };
  const mkUser = (name, role, extra = {}) => db.user.create({ data: { id: uuid(), name, email: `${name.toLowerCase()}-${uuid()}@t.local`, password_hash: 'x', role, initials: 'XX', ...extra } });
  const users = {
    admin: await mkUser('Admin', 'super_admin'),
    t1: await mkUser('Tina', 'teacher', { teacher_id: t1.id }), t2: await mkUser('Tom', 'teacher', { teacher_id: t2.id }),
    a1: await mkUser('Ann', 'student', { student_id: stud.a1.id }), a2: await mkUser('Abe', 'student', { student_id: stud.a2.id }),
    a3: await mkUser('Amy', 'student', { student_id: stud.a3.id }), b1: await mkUser('Bob', 'student', { student_id: stud.b1.id }),
    inactive: await mkUser('Old', 'student', { student_id: stud.inactive.id }),
    parent: await mkUser('Pat', 'parent'),
  };
  const tok = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, mkToken(schoolId, u)]));
  return { schoolId, db, clsA, clsB, t1, t2, stud, users, tok };
}

(async () => {
  const S = await seedSchool('one');
  const O = await seedSchool('two');   // second tenant for isolation checks
  const { tok, db } = S;
  const create = (token, body) => call('POST', '/elearning/sessions', { token, body });
  const MATH = { class_id: S.clsA.id, subject_name: 'Math' };

  section('Authentication & roles');
  check('no token → 401', (await call('GET', '/elearning/sessions')).status === 401);
  check('parent role → 403', (await call('GET', '/elearning/sessions', { token: tok.parent })).status === 403);

  section('Courses (derived from timetable)');
  let r = await call('GET', '/elearning/courses', { token: tok.t1 });
  check('teacher 1 sees her 2 courses', r.status === 200 && r.body.length === 2 && r.body.every(c => c.teacher_id === S.t1.id), r.body);
  check('teacher course shows active student count (inactive excluded)', r.body.find(c => c.subject_name === 'Math')?.student_count === 3, r.body);
  r = await call('GET', '/elearning/courses', { token: tok.a1 });
  check('student A sees only class A courses (Math + Chemistry)', r.body.map(c => c.subject_name).sort().join() === 'Chemistry,Math', r.body);
  r = await call('GET', '/elearning/courses', { token: tok.b1 });
  check('student B sees only class B courses', r.body.map(c => c.subject_name).sort().join() === 'Biology,Physics', r.body);
  check('admin sees all 4 courses', (await call('GET', '/elearning/courses', { token: tok.admin })).body.length === 4);

  section('Scheduling: validation & permissions');
  const T0 = 3 * HOUR;
  r = await create(tok.t1, { ...MATH, title: 'Intro', starts_at: iso(T0), ends_at: iso(T0 + HOUR) });
  check('teacher creates class for own course → 201', r.status === 201 && r.body.status === 'scheduled', r.body);
  const sess1 = r.body;
  check('room name is unguessable random id', /^edutech-[0-9a-f]{24}$/.test(sess1.room_name || ''), sess1.room_name);
  check('teacher_name + class_name populated', sess1.teacher_name === 'Tina Teacher' && sess1.class_name === 'Class A');
  check('course she does not teach → 403', (await create(tok.t1, { class_id: S.clsB.id, subject_name: 'Biology', title: 'x', starts_at: iso(T0), ends_at: iso(T0 + HOUR) })).status === 403);
  check('other teacher cannot use Math/A → 403', (await create(tok.t2, { ...MATH, title: 'x', starts_at: iso(9 * HOUR), ends_at: iso(10 * HOUR) })).status === 403);
  check('student cannot create → 403', (await create(tok.a1, { ...MATH, title: 'x', starts_at: iso(9 * HOUR), ends_at: iso(10 * HOUR) })).status === 403);
  check('admin cannot create → 403', (await create(tok.admin, { ...MATH, title: 'x', starts_at: iso(9 * HOUR), ends_at: iso(10 * HOUR) })).status === 403);
  check('missing title → 422', (await create(tok.t1, { ...MATH, title: '  ', starts_at: iso(9 * HOUR), ends_at: iso(10 * HOUR) })).status === 422);
  check('invalid dates → 422', (await create(tok.t1, { ...MATH, title: 'x', starts_at: 'nope', ends_at: 'nah' })).status === 422);
  check('end before start → 422', (await create(tok.t1, { ...MATH, title: 'x', starts_at: iso(9 * HOUR), ends_at: iso(8 * HOUR) })).status === 422);
  check('in the past → 422', (await create(tok.t1, { ...MATH, title: 'x', starts_at: iso(-3 * HOUR), ends_at: iso(-2 * HOUR) })).status === 422);
  check('longer than 8h → 422', (await create(tok.t1, { ...MATH, title: 'x', starts_at: iso(20 * HOUR), ends_at: iso(29 * HOUR) })).status === 422);

  section('Scheduling: conflicts');
  r = await create(tok.t1, { class_id: S.clsB.id, subject_name: 'Physics', title: 'overlap teacher', starts_at: iso(T0 + 30 * MIN), ends_at: iso(T0 + 90 * MIN) });
  check('same teacher overlapping (other class) → 409', r.status === 409 && r.body.conflicts?.length === 1, r.body);
  r = await create(tok.t2, { ...{ class_id: S.clsA.id, subject_name: 'Chemistry' }, title: 'overlap class', starts_at: iso(T0 + 30 * MIN), ends_at: iso(T0 + 90 * MIN) });
  check('same group overlapping (other teacher) → 409', r.status === 409, r.body);
  r = await create(tok.t2, { class_id: S.clsA.id, subject_name: 'Chemistry', title: 'back to back', starts_at: iso(T0 + HOUR), ends_at: iso(T0 + 2 * HOUR) });
  check('back-to-back (touching) is allowed → 201', r.status === 201, r.body);
  const sessChem = r.body;
  r = await create(tok.t1, { class_id: S.clsB.id, subject_name: 'Physics', title: 'other group, free time', starts_at: iso(T0 + 4 * HOUR), ends_at: iso(T0 + 5 * HOUR) });
  check('different group, different time → 201', r.status === 201, r.body);

  section('Notifications on scheduling');
  const notes = async (t) => (await call('GET', '/elearning/notifications', { token: t })).body;
  let n = await notes(tok.a1);
  check('enrolled student notified of new class', n.items.some(i => i.type === 'class_scheduled'), n);
  check('unread counter correct', n.unread === n.items.filter(i => !i.read_at).length && n.unread >= 2, n.unread);
  check('other-class student NOT notified of class A classes', !(await notes(tok.b1)).items.some(i => /Intro|back to back/.test(i.body || '')));
  check('inactive student NOT notified', (await notes(tok.inactive)).items.length === 0);
  check('teacher not notified of own scheduling', (await notes(tok.t1)).items.length === 0);
  await call('POST', '/elearning/notifications/read', { token: tok.b1, body: { ids: n.items.map(i => i.id) } });
  check("cannot mark another user's notifications read", (await notes(tok.a1)).unread === n.unread);
  await call('POST', '/elearning/notifications/read', { token: tok.a1, body: { ids: [n.items[0].id] } });
  check('mark one read', (await notes(tok.a1)).unread === n.unread - 1);
  await call('POST', '/elearning/notifications/read', { token: tok.a1, body: {} });
  check('mark all read', (await notes(tok.a1)).unread === 0);

  section('Edit / reschedule');
  r = await call('PUT', `/elearning/sessions/${sess1.id}`, { token: tok.t2, body: { title: 'hijack' } });
  check('other teacher cannot edit → 403', r.status === 403);
  r = await call('PUT', `/elearning/sessions/${sess1.id}`, { token: tok.t1, body: { title: 'Intro (updated)', description: 'bring notes' } });
  check('owner edits title/description → 200', r.status === 200 && r.body.title === 'Intro (updated)' && r.body.description === 'bring notes', r.body);
  check('title-only edit does not notify as reschedule', !(await notes(tok.a1)).items.some(i => i.type === 'class_rescheduled'));
  r = await call('PUT', `/elearning/sessions/${sess1.id}`, { token: tok.t1, body: { starts_at: iso(T0 + 30 * MIN + HOUR), ends_at: iso(T0 + 90 * MIN + HOUR) } });
  check('edit into a conflicting slot → 409', r.status === 409, r.body);
  r = await call('PUT', `/elearning/sessions/${sess1.id}`, { token: tok.t1, body: { starts_at: iso(5.5 * HOUR), ends_at: iso(6.5 * HOUR) } });
  check('reschedule to free slot → 200', r.status === 200, r.body);
  check('students notified of reschedule', (await notes(tok.a1)).items.some(i => i.type === 'class_rescheduled'));
  check('empty title rejected on edit', (await call('PUT', `/elearning/sessions/${sess1.id}`, { token: tok.t1, body: { title: ' ' } })).status === 422);

  section('Visibility');
  r = await call('GET', '/elearning/sessions', { token: tok.a1 });
  check('student A sees class A sessions only', r.body.length === 2 && r.body.every(s => s.class_id === S.clsA.id), r.body.map(s => s.title));
  r = await call('GET', '/elearning/sessions', { token: tok.b1 });
  check('student B sees only class B session', r.body.length === 1 && r.body[0].class_id === S.clsB.id);
  r = await call('GET', '/elearning/sessions', { token: tok.t2 });
  check('teacher 2 sees only own sessions', r.body.length === 1 && r.body[0].teacher_id === S.t2.id);
  check('admin sees all 3', (await call('GET', '/elearning/sessions', { token: tok.admin })).body.length === 3);
  check('student B cannot open class A session → 403', (await call('GET', `/elearning/sessions/${sess1.id}`, { token: tok.b1 })).status === 403);
  check('student A can open it', (await call('GET', `/elearning/sessions/${sess1.id}`, { token: tok.a1 })).status === 200);
  check('unknown session → 404', (await call('GET', `/elearning/sessions/${uuid()}`, { token: tok.a1 })).status === 404);
  check("other school's token cannot see this school's session → 404", (await call('GET', `/elearning/sessions/${sess1.id}`, { token: O.tok.t1 })).status === 404);
  check("other school's session list is empty", (await call('GET', '/elearning/sessions', { token: O.tok.admin })).body.length === 0);

  section('Start / join gating');
  r = await call('POST', `/elearning/sessions/${sess1.id}/start`, { token: tok.t1 });
  check('start too early (6h ahead) → 409', r.status === 409, r.body);
  r = await call('POST', `/elearning/sessions/${sess1.id}/join`, { token: tok.a1 });
  check('student join before start → 409 not_started', r.status === 409 && r.body.code === 'not_started', r.body);
  r = await call('POST', `/elearning/sessions/${sessChem.id}/start`, { token: tok.t1 });
  check('non-owner cannot start → 403', r.status === 403);
  r = await create(tok.t1, { ...MATH, title: 'Live soon', starts_at: iso(30 * MIN + 12 * HOUR), ends_at: iso(90 * MIN + 12 * HOUR) });
  const soon = r.body;
  // make it start in 10 min so it's inside the 15-min early window
  await db.elearningSession.update({ where: { id: soon.id }, data: { starts_at: new Date(Date.now() + 10 * MIN), ends_at: new Date(Date.now() + 70 * MIN) } });
  r = await call('POST', `/elearning/sessions/${soon.id}/start`, { token: tok.a1 });
  check('student cannot start → 403', r.status === 403);
  r = await call('POST', `/elearning/sessions/${soon.id}/start`, { token: tok.t1 });
  check('owner starts inside the 15-min window → live', r.status === 200 && r.body.status === 'live' && r.body.started_at, r.body);
  check('start is idempotent', (await call('POST', `/elearning/sessions/${soon.id}/start`, { token: tok.t1 })).body.status === 'live');
  check('students notified class is live', (await notes(tok.a1)).items.some(i => i.type === 'class_live'));
  check('live class cannot be edited → 409', (await call('PUT', `/elearning/sessions/${soon.id}`, { token: tok.t1, body: { title: 'x' } })).status === 409);
  check('live class cannot be cancelled → 409', (await call('POST', `/elearning/sessions/${soon.id}/cancel`, { token: tok.t1 })).status === 409);

  section('Joining: tokens & access control');
  r = await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.a1 });
  check('enrolled student joins → 200 with token', r.status === 200 && r.body.jwt && r.body.attendance_id, r.body);
  const aJoin = r.body;
  let claims = jwt.verify(aJoin.jwt, JITSI_SECRET, { audience: 'jitsi' });
  check('student token: right room, NOT moderator', claims.room === soon.room_name && claims.context.user.moderator === false, claims);
  check('student token: no screen-share/recording features', claims.context.features['screen-sharing'] === false && claims.context.features.recording === false);
  check('token is short-lived (≤ 4h) and bound to issuer/domain', claims.exp - claims.nbf <= 4 * 3600 + 20 && claims.iss === process.env.JITSI_APP_ID && claims.sub === process.env.JITSI_DOMAIN);
  check('script URL built from configured domain', aJoin.scriptUrl === `https://${process.env.JITSI_DOMAIN}/external_api.js`);
  check('server secret is not leaked in response', !JSON.stringify(aJoin).includes(JITSI_SECRET));
  r = await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.t1 });
  check('teacher joins as moderator', r.status === 200 && jwt.verify(r.body.jwt, JITSI_SECRET, { audience: 'jitsi' }).context.user.moderator === true, r.body);
  const tJoin = r.body;
  check('student of another class → 403', (await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.b1 })).status === 403);
  check('other teacher → 403', (await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.t2 })).status === 403);
  check('admin cannot join → 403', (await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.admin })).status === 403);
  check('inactive student → 403', (await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.inactive })).status === 403);
  check('other school → 404', (await call('POST', `/elearning/sessions/${soon.id}/join`, { token: O.tok.a1 })).status === 404);
  await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.a2 });

  section('Attendance (server-side)');
  r = await call('POST', `/elearning/sessions/${soon.id}/heartbeat`, { token: tok.a1, body: { attendance_id: aJoin.attendance_id } });
  check('heartbeat ok & reports status', r.status === 200 && r.body.status === 'live', r.body);
  check("cannot heartbeat someone else's attendance → 404", (await call('POST', `/elearning/sessions/${soon.id}/heartbeat`, { token: tok.a3, body: { attendance_id: aJoin.attendance_id } })).status === 404);
  check('bogus attendance id → 404', (await call('POST', `/elearning/sessions/${soon.id}/heartbeat`, { token: tok.a1, body: { attendance_id: 'nope' } })).status === 404);
  // back-date the join so duration is measurable
  await db.elearningSessionAttendance.update({ where: { id: aJoin.attendance_id }, data: { joined_at: new Date(Date.now() - 10 * MIN) } });
  await call('POST', `/elearning/sessions/${soon.id}/heartbeat`, { token: tok.a1, body: { attendance_id: aJoin.attendance_id } });
  check('students cannot read attendance → 403', (await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.a1 })).status === 403);
  check('other teacher cannot read attendance → 403', (await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.t2 })).status === 403);
  r = await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.t1 });
  const ann = r.body.attendees?.find(a => a.name === 'Ann');
  check('report: Ann present ~10 min, online', ann && ann.total_seconds >= 590 && ann.total_seconds <= 660 && ann.online === true, ann);
  check('report: enrolled count excludes inactive (3)', r.body.enrolled_count === 3, r.body.enrolled_count);
  check('report: absentees = Amy only', r.body.absent.length === 1 && r.body.absent[0].name === 'Amy Student', r.body.absent);
  check('report: student number exposed for matching', !!ann.student_number);
  check('report: teacher listed with role teacher', r.body.attendees.some(a => a.role === 'teacher'));
  r = await call('GET', `/elearning/sessions/${soon.id}/participants`, { token: tok.t1 });
  check('live roster shows 3 people in room', r.status === 200 && r.body.length === 3, r.body);
  await call('POST', `/elearning/sessions/${soon.id}/leave`, { token: tok.a1, body: { attendance_id: aJoin.attendance_id } });
  r = await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.t1 });
  const ann2 = r.body.attendees.find(a => a.name === 'Ann');
  check('after leave: offline, duration frozen', ann2.online === false && ann2.last_left_at && ann2.total_seconds >= 590 && ann2.total_seconds <= 660, ann2);
  check('leave is idempotent', (await call('POST', `/elearning/sessions/${soon.id}/leave`, { token: tok.a1, body: { attendance_id: aJoin.attendance_id } })).status === 200);
  r = await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.a1 });
  r = await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.admin });
  check('rejoin accumulates into ONE row with joins=2; admin may read', r.status === 200 && r.body.attendees.find(a => a.name === 'Ann').joins === 2, r.body.attendees);
  // stale client (tab crashed): no heartbeat for 5 min
  await db.elearningSessionAttendance.updateMany({ where: { user_id: S.users.a2.id }, data: { last_seen_at: new Date(Date.now() - 5 * MIN), joined_at: new Date(Date.now() - 8 * MIN) } });
  r = await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.t1 });
  const abe = r.body.attendees.find(a => a.name === 'Abe');
  check('stale client counted offline, time capped at last heartbeat (~3 min)', abe.online === false && abe.total_seconds >= 170 && abe.total_seconds <= 190, abe);
  check('live roster drops the stale client', (await call('GET', `/elearning/sessions/${soon.id}/participants`, { token: tok.t1 })).body.every(p => p.name !== 'Abe Student'));

  section('End class');
  check('student cannot end → 403', (await call('POST', `/elearning/sessions/${soon.id}/end`, { token: tok.a1 })).status === 403);
  check('other teacher cannot end → 403', (await call('POST', `/elearning/sessions/${soon.id}/end`, { token: tok.t2 })).status === 403);
  r = await call('POST', `/elearning/sessions/${soon.id}/end`, { token: tok.t1 });
  check('owner ends → ended', r.status === 200 && r.body.status === 'ended' && r.body.ended_at, r.body);
  const open = await db.elearningSessionAttendance.count({ where: { session_id: soon.id, left_at: null } });
  check('ending closes every open attendance record', open === 0, open);
  r = await call('POST', `/elearning/sessions/${soon.id}/join`, { token: tok.a3 });
  check('join after end → 409 ended', r.status === 409 && r.body.code === 'ended', r.body);
  const lastAtt = await db.elearningSessionAttendance.findFirst({ where: { user_id: S.users.a1.id, session_id: soon.id }, orderBy: { joined_at: 'desc' } });
  r = await call('POST', `/elearning/sessions/${soon.id}/heartbeat`, { token: tok.a1, body: { attendance_id: lastAtt.id } });
  check('heartbeat after the teacher ended the class still reports status=ended (client can react)', r.status === 200 && r.body.status === 'ended', r);
  const afterHb = await db.elearningSessionAttendance.findUnique({ where: { id: lastAtt.id } });
  check('...and does not reopen/extend the closed record', afterHb.left_at !== null);
  check('ended class cannot be re-ended / restarted', (await call('POST', `/elearning/sessions/${soon.id}/end`, { token: tok.t1 })).status === 409 && (await call('POST', `/elearning/sessions/${soon.id}/start`, { token: tok.t1 })).status === 409);
  r = await call('GET', `/elearning/sessions/${soon.id}/attendance`, { token: tok.t1 });
  check('attendance report still available after end', r.status === 200 && r.body.session.status === 'ended');

  section('Cancel');
  check('student cannot cancel → 403', (await call('POST', `/elearning/sessions/${sess1.id}/cancel`, { token: tok.a1 })).status === 403);
  check('other teacher cannot cancel → 403', (await call('POST', `/elearning/sessions/${sess1.id}/cancel`, { token: tok.t2 })).status === 403);
  r = await call('POST', `/elearning/sessions/${sess1.id}/cancel`, { token: tok.t1 });
  check('owner cancels scheduled class', r.status === 200 && r.body.status === 'cancelled', r.body);
  check('students notified of cancellation', (await notes(tok.a1)).items.some(i => i.type === 'class_cancelled'));
  check('cancelled class cannot be started', (await call('POST', `/elearning/sessions/${sess1.id}/start`, { token: tok.t1 })).status === 409);
  check('join cancelled → 409 cancelled', (await call('POST', `/elearning/sessions/${sess1.id}/join`, { token: tok.a1 })).body.code === 'cancelled');
  check('cancelled slot is free again (no conflict)', (await create(tok.t1, { ...MATH, title: 'reuse slot', starts_at: iso(5.5 * HOUR), ends_at: iso(6.5 * HOUR) })).status === 201);
  r = await call('POST', `/elearning/sessions/${sessChem.id}/cancel`, { token: tok.admin });
  check('admin can cancel a scheduled class', r.status === 200 && r.body.status === 'cancelled');

  section('Instant class & lifecycle sweeps');
  r = await create(tok.t1, { ...MATH, title: 'Instant', instant: true });
  check('instant class is live immediately', r.status === 201 && r.body.status === 'live' && r.body.started_at, r.body);
  check('student can join instant class', (await call('POST', `/elearning/sessions/${r.body.id}/join`, { token: tok.a1 })).status === 200);
  await call('POST', `/elearning/sessions/${r.body.id}/end`, { token: tok.t1 });
  const forgotten = await db.elearningSession.create({ data: { id: uuid(), class_id: S.clsA.id, subject_name: 'Math', teacher_id: S.t1.id, title: 'forgotten', starts_at: new Date(Date.now() - 8 * HOUR), ends_at: new Date(Date.now() - 7 * HOUR), status: 'live', room_name: `edutech-${uuid()}` } });
  r = await call('GET', `/elearning/sessions/${forgotten.id}`, { token: tok.t1 });
  check('live class abandoned >3h past its end is auto-closed', r.body.status === 'ended', r.body.status);
  const missed = await db.elearningSession.create({ data: { id: uuid(), class_id: S.clsA.id, subject_name: 'Math', teacher_id: S.t1.id, title: 'never started', starts_at: new Date(Date.now() - 3 * HOUR), ends_at: new Date(Date.now() - 2 * HOUR), room_name: `edutech-${uuid()}` } });
  check('never-started past class reported as "missed"', (await call('GET', `/elearning/sessions/${missed.id}`, { token: tok.t1 })).body.effective_status === 'missed');
  check('missed class cannot be started', (await call('POST', `/elearning/sessions/${missed.id}/start`, { token: tok.t1 })).status === 409);

  section('Reminders (15 min before class)');
  const mk = async (title, startMs) => (await create(tok.t2, { class_id: S.clsB.id, subject_name: 'Biology', title, starts_at: iso(startMs), ends_at: iso(startMs + 30 * MIN) })).body;
  const near = await mk('Reminder near', 10 * MIN + 24 * HOUR);
  const far = await mk('Reminder far', 60 * MIN + 24 * HOUR);
  await db.elearningSession.update({ where: { id: near.id }, data: { starts_at: new Date(Date.now() + 10 * MIN), ends_at: new Date(Date.now() + 40 * MIN) } });
  const before = (await notes(tok.b1)).items.length;
  const sent = await runOnce(db);
  check('reminder job sends for class starting in 10 min only', sent === 1, sent);
  const nb = await notes(tok.b1);
  check('student B got reminder', nb.items.some(i => i.type === 'class_reminder' && /Reminder near/.test(i.body)), nb.items.map(i => i.type));
  check('teacher got reminder too', (await notes(tok.t2)).items.some(i => i.type === 'class_reminder'));
  check('no reminder for the far class', !nb.items.some(i => /Reminder far/.test(i.body || '') && i.type === 'class_reminder'));
  check('job is idempotent (second run sends nothing)', (await runOnce(db)) === 0);
  await call('PUT', `/elearning/sessions/${far.id}`, { token: tok.t2, body: { starts_at: iso(5 * MIN + 24 * HOUR), ends_at: iso(35 * MIN + 24 * HOUR) } });
  await db.elearningSession.update({ where: { id: far.id }, data: { starts_at: new Date(Date.now() + 5 * MIN), ends_at: new Date(Date.now() + 35 * MIN) } });
  check('rescheduled class is reminded afresh', (await runOnce(db)) === 1);
  check('notification count grew only by reminders', (await notes(tok.b1)).items.length > before);

  section('Resources: upload & validation');
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const upload = (token, fields, file) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    if (file) f.append('file', new Blob([file.bytes]), file.name);
    return call('POST', '/elearning/resources', { token, form: f });
  };
  r = await upload(tok.t1, { ...MATH, title: 'Lecture 1', topic: 'Algebra' }, { bytes: pdfBytes, name: 'lecture 1 é.pdf' });
  check('teacher uploads PDF → 201', r.status === 201 && r.body.kind === 'file' && r.body.size_bytes === pdfBytes.length && r.body.original_name === 'lecture 1 é.pdf', r.body);
  const pdfRes = r.body;
  check('response exposes neither file bytes nor storage keys', !('file_key' in pdfRes) && !('file_data' in pdfRes));
  r = await upload(tok.t1, { ...MATH, title: 'Khan Academy', url: 'https://www.khanacademy.org/math' });
  check('teacher adds external link → 201', r.status === 201 && r.body.kind === 'link' && r.body.url.startsWith('https://'), r.body);
  const linkRes = r.body;
  check('javascript: link rejected → 422', (await upload(tok.t1, { ...MATH, title: 'x', url: 'javascript:alert(1)' })).status === 422);
  check('neither file nor link → 422', (await upload(tok.t1, { ...MATH, title: 'x' })).status === 422);
  check('missing title → 422', (await upload(tok.t1, { ...MATH, title: '' }, { bytes: pdfBytes, name: 'a.pdf' })).status === 422);
  r = await upload(tok.t1, { ...MATH, title: 'bad' }, { bytes: Buffer.from('MZ'), name: 'virus.exe' });
  check('.exe rejected → 422', r.status === 422, r.body);
  check('.html rejected (stored-XSS vector) → 422', (await upload(tok.t1, { ...MATH, title: 'bad' }, { bytes: Buffer.from('<script>'), name: 'x.html' })).status === 422);
  check('.svg rejected → 422', (await upload(tok.t1, { ...MATH, title: 'bad' }, { bytes: Buffer.from('<svg/>'), name: 'x.svg' })).status === 422);
  r = await upload(tok.t1, { ...MATH, title: 'huge' }, { bytes: Buffer.alloc(2 * 1024 * 1024, 1), name: 'big.pdf' });
  check('file over size limit → 413', r.status === 413, r);
  check('wrong-teacher upload → 403', (await upload(tok.t2, { ...MATH, title: 'x' }, { bytes: pdfBytes, name: 'a.pdf' })).status === 403);
  check('student upload → 403', (await upload(tok.a1, { ...MATH, title: 'x' }, { bytes: pdfBytes, name: 'a.pdf' })).status === 403);
  check('session from another course → 422', (await upload(tok.t1, { ...MATH, title: 'x', session_id: near.id }, { bytes: pdfBytes, name: 'a.pdf' })).status === 422);
  r = await upload(tok.t1, { ...MATH, title: 'Session notes', session_id: soon.id }, { bytes: pdfBytes, name: 'notes.pdf' });
  check('resource can be attached to the class session', r.status === 201 && r.body.session_id === soon.id, r.body);
  const sessRes = r.body;
  const fileRows = await db.elearningResource.findMany({ where: { kind: 'file' } });
  const stored = fileRows.find(x => x.id === pdfRes.id);
  check('rejected/oversized uploads leave nothing behind (only 2 file rows)', fileRows.length === 2, fileRows.length);
  check('file bytes are stored in the database, byte-for-byte', !!stored && Buffer.from(stored.file_data).equals(pdfBytes));
  check('nothing is written to local disk (Render disk is ephemeral)', !fs.existsSync(path.join(__dirname, '..', 'private-uploads')));
  check('students notified of new material', (await notes(tok.a1)).items.some(i => i.type === 'resource'));

  section('Resources: access control');
  r = await call('GET', '/elearning/resources', { token: tok.a1 });
  check('enrolled student sees class A materials (3)', r.status === 200 && r.body.length === 3, r.body.length);
  check('list responses never include file bytes', r.body.every(x => !('file_data' in x)) && JSON.stringify(r.body).length < 5000);
  check('student B sees none', (await call('GET', '/elearning/resources', { token: tok.b1 })).body.length === 0);
  check('teacher 2 sees none (not hers)', (await call('GET', '/elearning/resources', { token: tok.t2 })).body.length === 0);
  check('admin sees all', (await call('GET', '/elearning/resources', { token: tok.admin })).body.length === 3);
  check('filter by session', (await call('GET', `/elearning/resources?session_id=${soon.id}`, { token: tok.a1 })).body.length === 1);
  check("student cannot widen list with someone else's class_id", (await call('GET', `/elearning/resources?class_id=${S.clsB.id}`, { token: tok.b1 })).body.length === 0 && (await call('GET', `/elearning/resources?class_id=${S.clsA.id}`, { token: tok.b1 })).body.length === 0);
  const dl = (token, id, q = '') => call('GET', `/elearning/resources/${id}/file${q}`, { token, raw: true });
  let res = await dl(tok.a1, pdfRes.id);
  const body = Buffer.from(await res.arrayBuffer());
  check('enrolled student downloads exact bytes', res.status === 200 && body.equals(pdfBytes));
  check('download is attachment with UTF-8 filename', /attachment; filename\*=UTF-8''lecture%201%20%C3%A9\.pdf/.test(res.headers.get('content-disposition')), res.headers.get('content-disposition'));
  check('nosniff + sandbox CSP set', res.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(res.headers.get('content-security-policy')));
  res = await dl(tok.a1, pdfRes.id, '?inline=1'); await res.arrayBuffer();
  check('PDF can be previewed inline', /^inline/.test(res.headers.get('content-disposition')) && res.headers.get('content-type') === 'application/pdf');
  check('student of another class → 403', (await dl(tok.b1, pdfRes.id)).status === 403);
  check('other teacher → 403', (await dl(tok.t2, pdfRes.id)).status === 403);
  check('inactive student → 403', (await dl(tok.inactive, pdfRes.id)).status === 403);
  check('admin can download', (await dl(tok.admin, pdfRes.id)).status === 200);
  check('no token → 401', (await dl(undefined, pdfRes.id)).status === 401);
  check('other school → 404', (await dl(O.tok.a1, pdfRes.id)).status === 404);
  check('link resource has no file → 404', (await dl(tok.a1, linkRes.id)).status === 404);
  const storedKey = 'x.pdf';
  const direct = await fetch(`${BASE}/uploads/${S.schoolId}/elearning/${storedKey}`);
  check('file is NOT reachable through the public /uploads static route', direct.status === 404, direct.status);
  const docx = await upload(tok.t1, { ...MATH, title: 'Word' }, { bytes: Buffer.from('PK'), name: 'w.docx' });
  res = await dl(tok.a1, docx.body.id, '?inline=1'); await res.arrayBuffer();
  check('non-previewable types are forced to download even with inline=1', /^attachment/.test(res.headers.get('content-disposition')));
  check('student cannot delete → 403', (await call('DELETE', `/elearning/resources/${pdfRes.id}`, { token: tok.a1 })).status === 403);
  check('other teacher cannot delete → 403', (await call('DELETE', `/elearning/resources/${pdfRes.id}`, { token: tok.t2 })).status === 403);
  check('owner deletes → 204', (await call('DELETE', `/elearning/resources/${pdfRes.id}`, { token: tok.t1 })).status === 204);
  check('deleting removes the file bytes (notes.pdf + docx rows remain)', (await db.elearningResource.count({ where: { kind: 'file' } })) === 2);
  check('deleted resource → 404', (await dl(tok.a1, pdfRes.id)).status === 404);
  check('admin can delete', (await call('DELETE', `/elearning/resources/${linkRes.id}`, { token: tok.admin })).status === 204);
  check('delete unknown → 404', (await call('DELETE', `/elearning/resources/${uuid()}`, { token: tok.t1 })).status === 404);
  void sessRes;

  section('Cascade integrity');
  await db.class.delete({ where: { id: S.clsB.id } });
  check('deleting a class cascades its sessions', (await db.elearningSession.count({ where: { class_id: S.clsB.id } })) === 0);

  console.log(`\n${passes} passed, ${failures} failed`);
  await platformClient.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
