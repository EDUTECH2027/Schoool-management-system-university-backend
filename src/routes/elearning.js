// E-learning: live classes (Jitsi) for teachers, students and admins.
//
// A "course" is Class + subject_name + Teacher, derived from TeacherSchedule
// (there is no separate Course/Enrollment table): a student is enrolled in every
// session of the Class they belong to.
const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const jitsi = require('../utils/jitsi');
const { uploadSingle, TYPES, INLINE_OK, extOf } = require('../utils/elearningUploads');
const { notifyUsers, classStudentUserIds, teacherUserIds, safe } = require('../utils/notify');

const ADMIN_ROLES = ['super_admin', 'head_teacher'];
const START_EARLY_MS = 15 * 60 * 1000;      // teacher may open the room 15 min early
const STALE_AFTER_MS = 90 * 1000;           // no heartbeat for this long => user considered gone
const AUTO_END_AFTER_MS = 3 * 60 * 60 * 1000; // live session left open 3h past its end is closed
const JOIN_TOKEN_TTL_S = 4 * 60 * 60;
const MAX_DURATION_MS = 8 * 60 * 60 * 1000;

router.use(authenticate, authorize('teacher', 'student', 'super_admin', 'head_teacher'));

const isAdmin = req => ADMIN_ROLES.includes(req.user.role);
const isTeacher = req => req.user.role === 'teacher';
const isStudent = req => req.user.role === 'student';

const SESSION_INCLUDE = {
  class: { select: { id: true, name: true } },
  teacher: { select: { id: true, first_name: true, last_name: true } },
};

function shape(s, extra = {}) {
  const { class: cls, teacher, ...rest } = s;
  return {
    ...rest,
    class_name: cls?.name ?? null,
    teacher_name: teacher ? `${teacher.first_name} ${teacher.last_name}` : null,
    // 'scheduled' sessions whose window has passed without being started
    effective_status: rest.status === 'scheduled' && new Date(rest.ends_at) < new Date() ? 'missed' : rest.status,
    ...extra,
  };
}

const fmtWhen = d => new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const notifyClass = (db, s, type, title) => safe(async () => notifyUsers(db, await classStudentUserIds(db, s.class_id), { type, title, body: `${s.title} — ${s.subject_name}`, link: "/student/e-learning" }));

// Is this teacher assigned to teach `subject_name` to `class_id`?
async function teacherCoversCourse(db, teacherId, classId, subjectName) {
  const row = await db.teacherSchedule.findFirst({
    where: { teacher_id: teacherId, class_id: classId, subject_name: subjectName }, select: { id: true },
  });
  return !!row;
}

async function studentClassId(db, studentId) {
  if (!studentId) return null;
  const st = await db.student.findUnique({ where: { id: studentId }, select: { class_id: true, is_active: true } });
  return st && st.is_active ? st.class_id : null;
}

// Load a session and check the caller may see it. Returns null after sending the error response.
async function loadAuthorized(req, res, { ownTeacherOnly = false } = {}) {
  const s = await req.db.elearningSession.findUnique({ where: { id: req.params.id }, include: SESSION_INCLUDE });
  if (!s) { res.status(404).json({ error: 'Class not found' }); return null; }
  let ok = false;
  if (isAdmin(req)) ok = !ownTeacherOnly;
  else if (isTeacher(req)) ok = s.teacher_id === req.user.teacher_id;
  else if (isStudent(req)) ok = !ownTeacherOnly && (await studentClassId(req.db, req.user.student_id)) === s.class_id;
  if (!ok) { res.status(403).json({ error: 'You do not have access to this class' }); return null; }
  return s;
}

// Close live sessions that were never ended, and attendance rows whose client vanished.
async function sweep(db) {
  const now = new Date();
  await db.elearningSession.updateMany({
    where: { status: 'live', ends_at: { lt: new Date(now.getTime() - AUTO_END_AFTER_MS) } },
    data: { status: 'ended', ended_at: now, updated_at: now },
  });
}

async function closeOpenAttendance(db, where, at) {
  const open = await db.elearningSessionAttendance.findMany({ where: { ...where, left_at: null } });
  for (const a of open) {
    const left = new Date(Math.min(at.getTime(), a.last_seen_at.getTime() + STALE_AFTER_MS));
    await db.elearningSessionAttendance.update({
      where: { id: a.id },
      data: { left_at: left, duration_seconds: Math.max(0, Math.round((left - a.joined_at) / 1000)) },
    });
  }
}

function parseWindow(body) {
  const starts = new Date(body.starts_at);
  const ends = new Date(body.ends_at);
  if (isNaN(starts) || isNaN(ends)) return { error: 'Valid start and end date/time are required' };
  if (ends <= starts) return { error: 'End time must be after start time' };
  if (ends - starts > MAX_DURATION_MS) return { error: 'A class cannot be longer than 8 hours' };
  return { starts, ends };
}

async function findConflicts(db, { teacherId, classId, starts, ends, excludeId }) {
  return db.elearningSession.findMany({
    where: {
      status: { in: ['scheduled', 'live'] },
      starts_at: { lt: ends }, ends_at: { gt: starts },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ teacher_id: teacherId }, { class_id: classId }],
    },
    include: SESSION_INCLUDE,
  });
}

// ── Courses (what a user may hold / attend classes for) ────────────────────────
router.get('/courses', async (req, res) => {
  let where = {};
  if (isTeacher(req)) where = { teacher_id: req.user.teacher_id };
  else if (isStudent(req)) {
    const classId = await studentClassId(req.db, req.user.student_id);
    if (!classId) return res.json([]);
    where = { class_id: classId };
  }
  const rows = await req.db.teacherSchedule.findMany({
    where,
    include: { teacher: { select: { id: true, first_name: true, last_name: true } }, class: { select: { id: true, name: true } } },
  });
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.class_id}|${r.subject_name}|${r.teacher_id}`;
    if (!seen.has(key)) seen.set(key, {
      class_id: r.class_id, class_name: r.class?.name ?? r.class_name, subject_name: r.subject_name,
      teacher_id: r.teacher_id, teacher_name: r.teacher ? `${r.teacher.first_name} ${r.teacher.last_name}` : null,
    });
  }
  const out = [...seen.values()];
  if (isTeacher(req)) {
    const counts = await req.db.student.groupBy({
      by: ['class_id'], where: { is_active: true, class_id: { in: [...new Set(out.map(c => c.class_id))] } }, _count: { _all: true },
    });
    const byClass = Object.fromEntries(counts.map(c => [c.class_id, c._count._all]));
    out.forEach(c => { c.student_count = byClass[c.class_id] ?? 0; });
  }
  res.json(out.sort((a, b) => a.class_name.localeCompare(b.class_name) || a.subject_name.localeCompare(b.subject_name)));
});

// ── Sessions ───────────────────────────────────────────────────────────────
router.get('/sessions', async (req, res) => {
  await sweep(req.db);
  const where = {};
  if (isTeacher(req)) where.teacher_id = req.user.teacher_id;
  else if (isStudent(req)) {
    const classId = await studentClassId(req.db, req.user.student_id);
    if (!classId) return res.json([]);
    where.class_id = classId;
  }
  const { status, class_id, from, to } = req.query;
  if (status) where.status = status;
  if (class_id && isAdmin(req)) where.class_id = class_id;
  if (from || to) where.starts_at = { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) };
  const rows = await req.db.elearningSession.findMany({
    where, include: { ...SESSION_INCLUDE, _count: { select: { attendance: true } } },
    orderBy: { starts_at: 'desc' }, take: 300,
  });
  res.json(rows.map(r => { const { _count, ...s } = r; return shape(s, { attendance_count: _count.attendance }); }));
});

router.get('/sessions/:id', async (req, res) => {
  await sweep(req.db);
  const s = await loadAuthorized(req, res);
  if (!s) return;
  const fresh = await req.db.elearningSession.findUnique({ where: { id: s.id }, include: SESSION_INCLUDE });
  res.json(shape(fresh));
});

router.post('/sessions', authorize('teacher'), async (req, res) => {
  const { class_id, subject_name, title, description, instant } = req.body;
  if (!class_id || !subject_name || !title?.trim()) return res.status(422).json({ error: 'Course and title are required' });
  if (!(await teacherCoversCourse(req.db, req.user.teacher_id, class_id, subject_name))) {
    return res.status(403).json({ error: 'You are not assigned to teach this course' });
  }
  let starts, ends, status = 'scheduled';
  if (instant) {
    starts = new Date();
    ends = new Date(starts.getTime() + 60 * 60 * 1000);
    status = 'live';
  } else {
    const w = parseWindow(req.body);
    if (w.error) return res.status(422).json({ error: w.error });
    if (w.ends < new Date()) return res.status(422).json({ error: 'The class cannot be scheduled in the past' });
    ({ starts, ends } = w);
  }
  const conflicts = await findConflicts(req.db, { teacherId: req.user.teacher_id, classId: class_id, starts, ends });
  if (conflicts.length) {
    return res.status(409).json({ error: 'This time overlaps another class for you or this group', conflicts: conflicts.map(c => shape(c)) });
  }
  const now = new Date();
  const created = await req.db.elearningSession.create({
    data: {
      id: uuid(), class_id, subject_name, teacher_id: req.user.teacher_id,
      title: title.trim(), description: description?.trim() || null,
      starts_at: starts, ends_at: ends, status,
      room_name: `edutech-${crypto.randomBytes(12).toString('hex')}`,
      started_at: status === 'live' ? now : null,
    },
    include: SESSION_INCLUDE,
  });
  if (status === "live") await notifyClass(req.db, created, "class_live", "Class is live — join now");
  else await notifyClass(req.db, created, "class_scheduled", `New online class: ${fmtWhen(starts)}`);
  res.status(201).json(shape(created));
});

// Edit / reschedule — only while still scheduled
router.put('/sessions/:id', authorize('teacher'), async (req, res) => {
  const s = await loadAuthorized(req, res, { ownTeacherOnly: true });
  if (!s) return;
  if (s.status !== 'scheduled') return res.status(409).json({ error: `A ${s.status} class cannot be edited` });
  const data = { updated_at: new Date() };
  if (req.body.title !== undefined) {
    if (!req.body.title.trim()) return res.status(422).json({ error: 'Title is required' });
    data.title = req.body.title.trim();
  }
  if (req.body.description !== undefined) data.description = req.body.description?.trim() || null;
  let starts = s.starts_at, ends = s.ends_at;
  if (req.body.starts_at !== undefined || req.body.ends_at !== undefined) {
    const w = parseWindow({ starts_at: req.body.starts_at ?? s.starts_at, ends_at: req.body.ends_at ?? s.ends_at });
    if (w.error) return res.status(422).json({ error: w.error });
    if (w.ends < new Date()) return res.status(422).json({ error: 'The class cannot be scheduled in the past' });
    starts = w.starts; ends = w.ends;
    data.starts_at = starts; data.ends_at = ends; data.reminder_sent_at = null;
    const conflicts = await findConflicts(req.db, { teacherId: s.teacher_id, classId: s.class_id, starts, ends, excludeId: s.id });
    if (conflicts.length) return res.status(409).json({ error: 'This time overlaps another class for you or this group', conflicts: conflicts.map(c => shape(c)) });
  }
  const updated = await req.db.elearningSession.update({ where: { id: s.id }, data, include: SESSION_INCLUDE });
  const timeChanged = +starts !== +s.starts_at || +ends !== +s.ends_at;
  if (timeChanged) await notifyClass(req.db, updated, "class_rescheduled", `Class rescheduled: ${fmtWhen(updated.starts_at)}`);
  res.json(shape(updated));
});

router.post('/sessions/:id/cancel', authorize('teacher', 'super_admin', 'head_teacher'), async (req, res) => {
  const s = await loadAuthorized(req, res, { ownTeacherOnly: isTeacher(req) });
  if (!s) return;
  if (s.status !== 'scheduled') return res.status(409).json({ error: 'Only a scheduled class can be cancelled — end a live class instead' });
  const updated = await req.db.elearningSession.update({
    where: { id: s.id }, data: { status: 'cancelled', updated_at: new Date() }, include: SESSION_INCLUDE,
  });
  await notifyClass(req.db, updated, 'class_cancelled', 'Class cancelled');
  res.json(shape(updated));
});

router.post('/sessions/:id/start', authorize('teacher'), async (req, res) => {
  const s = await loadAuthorized(req, res, { ownTeacherOnly: true });
  if (!s) return;
  if (s.status === 'live') return res.json(shape(s));
  if (s.status !== 'scheduled') return res.status(409).json({ error: `A ${s.status} class cannot be started` });
  const now = Date.now();
  if (now < s.starts_at.getTime() - START_EARLY_MS) return res.status(409).json({ error: 'It is too early to start this class (you can start 15 minutes before)' });
  if (now > s.ends_at.getTime()) return res.status(409).json({ error: 'This class time has passed — reschedule it first' });
  const updated = await req.db.elearningSession.update({
    where: { id: s.id }, data: { status: 'live', started_at: new Date(), updated_at: new Date() }, include: SESSION_INCLUDE,
  });
  await notifyClass(req.db, updated, 'class_live', 'Class is live — join now');
  res.json(shape(updated));
});

router.post('/sessions/:id/end', authorize('teacher'), async (req, res) => {
  const s = await loadAuthorized(req, res, { ownTeacherOnly: true });
  if (!s) return;
  if (s.status !== 'live') return res.status(409).json({ error: 'Only a live class can be ended' });
  const now = new Date();
  await closeOpenAttendance(req.db, { session_id: s.id }, now);
  const updated = await req.db.elearningSession.update({
    where: { id: s.id }, data: { status: 'ended', ended_at: now, updated_at: now }, include: SESSION_INCLUDE,
  });
  res.json(shape(updated));
});

// ── Joining + attendance (the server is the source of truth) ───────────────────
router.post('/sessions/:id/join', authorize('teacher', 'student'), async (req, res) => {
  await sweep(req.db);
  const s = await loadAuthorized(req, res);
  if (!s) return;
  if (s.status === 'scheduled') return res.status(409).json({ error: 'The teacher has not started this class yet', code: 'not_started' });
  if (s.status === 'ended') return res.status(409).json({ error: 'This class has ended', code: 'ended' });
  if (s.status === 'cancelled') return res.status(409).json({ error: 'This class was cancelled', code: 'cancelled' });
  if (!jitsi.isConfigured()) {
    return res.status(503).json({ error: 'Video conferencing is not configured on the server. Ask your administrator to set the JITSI_* environment variables.', code: 'not_configured' });
  }
  const moderator = isTeacher(req);
  const access = jitsi.buildAccess({
    roomName: s.room_name, moderator, ttlSeconds: JOIN_TOKEN_TTL_S,
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
  });

  const now = new Date();
  await closeOpenAttendance(req.db, { session_id: s.id, user_id: req.user.id }, now);
  const att = await req.db.elearningSessionAttendance.create({
    data: {
      id: uuid(), session_id: s.id, user_id: req.user.id, user_name: req.user.name,
      role: moderator ? 'teacher' : 'student',
      student_id: req.user.student_id || null, teacher_id: req.user.teacher_id || null,
      joined_at: now, last_seen_at: now,
    },
  });
  res.json({ ...access, attendance_id: att.id, moderator, session: shape(s) });
});

async function ownAttendance(req) {
  const a = await req.db.elearningSessionAttendance.findFirst({
    where: { id: req.body.attendance_id || '', session_id: req.params.id, user_id: req.user.id },
  });
  return a;
}

router.post('/sessions/:id/heartbeat', authorize('teacher', 'student'), async (req, res) => {
  const a = await ownAttendance(req);
  if (!a) return res.status(404).json({ error: 'No attendance record' });
  const s = await req.db.elearningSession.findUnique({ where: { id: req.params.id }, select: { status: true } });
  const status = s?.status ?? 'ended';
  // A record closed by "End class" must still learn the class is over, so only live ones are touched.
  if (!a.left_at) {
    const now = new Date();
    await req.db.elearningSessionAttendance.update({
      where: { id: a.id }, data: { last_seen_at: now, duration_seconds: Math.round((now - a.joined_at) / 1000) },
    });
  }
  res.json({ status, closed: !!a.left_at });   // lets clients notice the teacher ended the class
});

router.post('/sessions/:id/leave', authorize('teacher', 'student'), async (req, res) => {
  const a = await ownAttendance(req);
  if (a && !a.left_at) {
    const now = new Date();
    await req.db.elearningSessionAttendance.update({
      where: { id: a.id }, data: { left_at: now, last_seen_at: now, duration_seconds: Math.round((now - a.joined_at) / 1000) },
    });
  }
  res.json({ ok: true });
});

// Attendance report: one row per person, summed across rejoins. For students of the
// class who never joined, status is 'absent'.
router.get('/sessions/:id/attendance', authorize('teacher', 'super_admin', 'head_teacher'), async (req, res) => {
  const s = await loadAuthorized(req, res, { ownTeacherOnly: isTeacher(req) });
  if (!s) return;
  const rows = await req.db.elearningSessionAttendance.findMany({ where: { session_id: s.id }, orderBy: { joined_at: 'asc' } });
  const now = Date.now();
  const people = new Map();
  for (const r of rows) {
    const open = !r.left_at;
    const stale = open && now - r.last_seen_at.getTime() > STALE_AFTER_MS;
    const end = r.left_at ?? r.last_seen_at;
    const secs = Math.max(0, Math.round((end - r.joined_at) / 1000));
    const p = people.get(r.user_id) ?? {
      user_id: r.user_id, name: r.user_name, role: r.role, student_id: r.student_id,
      first_joined_at: r.joined_at, last_left_at: null, total_seconds: 0, online: false, joins: 0,
    };
    p.total_seconds += secs; p.joins += 1;
    p.online = p.online || (open && !stale);
    p.last_left_at = open && !stale ? null : end;
    people.set(r.user_id, p);
  }
  const students = await req.db.student.findMany({
    where: { class_id: s.class_id, is_active: true },
    select: { id: true, first_name: true, last_name: true, student_number: true },
    orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }],
  });
  const attendees = [...people.values()];
  const presentStudentIds = new Set(attendees.filter(a => a.role === 'student').map(a => a.student_id));
  const absent = students.filter(st => !presentStudentIds.has(st.id))
    .map(st => ({ student_id: st.id, name: `${st.first_name} ${st.last_name}`, student_number: st.student_number }));
  const numbers = Object.fromEntries(students.map(st => [st.id, st.student_number]));
  res.json({
    session: shape(s),
    attendees: attendees.map(a => ({ ...a, student_number: a.student_id ? numbers[a.student_id] ?? null : null })),
    absent,
    enrolled_count: students.length,
  });
});

// Teacher's live roster (who is in the room right now) — based on server heartbeats.
router.get('/sessions/:id/participants', authorize('teacher', 'super_admin', 'head_teacher'), async (req, res) => {
  const s = await loadAuthorized(req, res, { ownTeacherOnly: isTeacher(req) });
  if (!s) return;
  const since = new Date(Date.now() - STALE_AFTER_MS);
  const rows = await req.db.elearningSessionAttendance.findMany({
    where: { session_id: s.id, left_at: null, last_seen_at: { gte: since } }, orderBy: { joined_at: 'asc' },
  });
  res.json(rows.map(r => ({ user_id: r.user_id, name: r.user_name, role: r.role, joined_at: r.joined_at })));
});

// ── Course resources ────────────────────────────────────────────────────────────
async function resourceVisible(req, r) {
  if (isAdmin(req)) return true;
  if (isTeacher(req)) return r.teacher_id === req.user.teacher_id;
  if (isStudent(req)) return (await studentClassId(req.db, req.user.student_id)) === r.class_id;
  return false;
}

const resourceDto = r => ({
  id: r.id, class_id: r.class_id, subject_name: r.subject_name, teacher_id: r.teacher_id, session_id: r.session_id,
  topic: r.topic, kind: r.kind, title: r.title, url: r.url, original_name: r.original_name,
  mime_type: r.mime_type, size_bytes: r.size_bytes, created_at: r.created_at,
  teacher_name: r.teacher ? `${r.teacher.first_name} ${r.teacher.last_name}` : undefined,
  class_name: r.class?.name,
});

router.get('/resources', async (req, res) => {
  const where = {};
  if (isTeacher(req)) where.teacher_id = req.user.teacher_id;
  else if (isStudent(req)) {
    const classId = await studentClassId(req.db, req.user.student_id);
    if (!classId) return res.json([]);
    where.class_id = classId;
  }
  const { class_id, subject_name, session_id } = req.query;
  if (class_id && !isStudent(req)) where.class_id = class_id;
  if (subject_name) where.subject_name = subject_name;
  if (session_id) where.session_id = session_id;
  const rows = await req.db.elearningResource.findMany({
    where, orderBy: { created_at: 'desc' }, take: 500, omit: { file_data: true },
    include: { teacher: { select: { first_name: true, last_name: true } }, class: { select: { name: true } } },
  });
  res.json(rows.map(resourceDto));
});

router.post('/resources', authorize('teacher'), uploadSingle('file'), async (req, res) => {
  const { class_id, subject_name, title, topic, session_id } = req.body;
  const kind = req.file ? 'file' : 'link';
  {
    if (!class_id || !subject_name || !title?.trim()) { return res.status(422).json({ error: 'Course and title are required' }); }
    if (!(await teacherCoversCourse(req.db, req.user.teacher_id, class_id, subject_name))) {
      return res.status(403).json({ error: 'You are not assigned to teach this course' });
    }
    let url = null;
    if (kind === 'link') {
      try { const u = new URL(req.body.url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); url = u.toString(); }
      catch { return res.status(422).json({ error: 'Provide a file or a valid http(s) link' }); }
    }
    if (session_id) {
      const sess = await req.db.elearningSession.findUnique({ where: { id: session_id }, select: { class_id: true, teacher_id: true, subject_name: true } });
      if (!sess || sess.teacher_id !== req.user.teacher_id || sess.class_id !== class_id || sess.subject_name !== subject_name) {
        return res.status(422).json({ error: 'That class session does not belong to this course' });
      }
    }
    const ext = req.file ? extOf(req.file.originalname) : null;
    const created = await req.db.elearningResource.create({
      data: {
        id: uuid(), class_id, subject_name, teacher_id: req.user.teacher_id, session_id: session_id || null,
        topic: topic?.trim() || null, kind, title: title.trim(), url,
        file_data: req.file ? req.file.buffer : null,
        original_name: req.file ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : null,
        mime_type: ext ? TYPES[ext] : null, size_bytes: req.file?.size ?? null,
      },
    });
    await safe(async () => notifyUsers(req.db, await classStudentUserIds(req.db, class_id),
      { type: 'resource', title: 'New course material', body: `${created.title} — ${subject_name}`, link: '/student/e-learning' }));
    res.status(201).json(resourceDto(created));
  }
});

router.delete('/resources/:id', authorize('teacher', 'super_admin', 'head_teacher'), async (req, res) => {
  const r = await req.db.elearningResource.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Resource not found' });
  if (isTeacher(req) && r.teacher_id !== req.user.teacher_id) return res.status(403).json({ error: 'You can only delete your own materials' });
  await req.db.elearningResource.delete({ where: { id: r.id } });
  res.status(204).end();
});

// Authorised download / preview. ?inline=1 renders safe types in the browser.
router.get('/resources/:id/file', async (req, res) => {
  const r = await req.db.elearningResource.findUnique({ where: { id: req.params.id } });
  if (!r || r.kind !== 'file' || !r.file_data) return res.status(404).json({ error: 'File not found' });
  if (!(await resourceVisible(req, r))) return res.status(403).json({ error: 'You do not have access to this material' });
  const ext = extOf(r.original_name || '');
  const inline = req.query.inline === '1' && INLINE_OK.has(ext);
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.original_name || r.title)}`);
  res.setHeader('Content-Length', r.file_data.length);
  res.end(Buffer.from(r.file_data));
});

// ── Notifications (in-app) ────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  const [items, unread] = await Promise.all([
    req.db.notification.findMany({ where: { user_id: req.user.id }, orderBy: { created_at: 'desc' }, take: 30 }),
    req.db.notification.count({ where: { user_id: req.user.id, read_at: null } }),
  ]);
  res.json({ items, unread });
});

router.post('/notifications/read', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  await req.db.notification.updateMany({
    where: { user_id: req.user.id, read_at: null, ...(ids ? { id: { in: ids } } : {}) }, data: { read_at: new Date() },
  });
  res.json({ ok: true });
});

module.exports = router;
