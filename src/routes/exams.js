// Examination management: sessions, invigilators, conflict detection, candidate lists with configurable
// eligibility, attendance, and the student's exam timetable.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const { actorOf } = require('../academics/results');
const { notifyUsers, safe } = require('../utils/notify');

const approvers = [authenticate, authorize('super_admin', 'academic_officer')];
const staffRead = [authenticate, authorize('super_admin', 'academic_officer', 'teacher')];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const overlap = (a, b) => a.date === b.date && mins(a.start_time) < mins(b.end_time) && mins(b.start_time) < mins(a.end_time);
const KINDS = ['final', 'midterm', 'resit'];

const EXAM_INCLUDE = { subject: { select: { id: true, name: true, code: true } }, term: { include: { academic_year: true } }, invigilators: { include: { teacher: { select: { id: true, first_name: true, last_name: true } } } }, _count: { select: { candidates: true } } };
const dto = ({ _count, term, invigilators, subject, ...e }) => ({ ...e, course: subject.name, code: subject.code, term_name: term.name, academic_year: term.academic_year.label, candidates: _count.candidates, invigilators: invigilators.map(i => ({ id: i.teacher.id, name: `${i.teacher.first_name} ${i.teacher.last_name}` })) });

async function registeredStudentIds(db, exam) {
  const where = { term_id: exam.term_id, status: 'registered', offering: { subject_id: exam.subject_id, ...(exam.offering_id && { id: exam.offering_id }) } };
  return (await db.courseEnrollment.findMany({ where, select: { student_id: true } })).map(e => e.student_id);
}

/** Configurable eligibility. Returns { eligible, reasons[] } — every rule that fails is listed. */
async function eligibility(db, student, exam, settings, term) {
  const reasons = [];
  if (settings.exam_min_attendance_pct != null) {
    const recs = await db.attendanceRecord.findMany({ where: { student_id: student.id, date: { gte: term.start_date, lte: term.end_date } }, select: { status: true } });
    if (recs.length) {
      const rate = recs.filter(r => r.status === 'present' || r.status === 'late' || r.status === 'excused').length / recs.length * 100;
      if (rate < settings.exam_min_attendance_pct) reasons.push({ code: 'attendance', message: `Attendance ${Math.round(rate)}% is below the required ${settings.exam_min_attendance_pct}%.` });
    }
  }
  if (settings.exam_fee_rule && settings.exam_fee_rule !== 'none') {
    const fees = await db.feeRecord.findMany({ where: { student_id: student.id, status: { not: 'waived' } } });
    const today = new Date().toISOString().slice(0, 10);
    if (settings.exam_fee_rule === 'no_overdue' && fees.some(f => f.balance > 0 && f.due_date && f.due_date < today)) reasons.push({ code: 'fees_overdue', message: 'Overdue fees must be settled.' });
    if (settings.exam_fee_rule === 'min_paid_pct' && fees.length) {
      const due = fees.reduce((x, f) => x + f.amount_due, 0), paid = fees.reduce((x, f) => x + f.amount_paid, 0);
      const pct = due ? paid / due * 100 : 100;
      if (pct < settings.exam_min_paid_pct) reasons.push({ code: 'fees_paid_pct', message: `Only ${Math.round(pct)}% of fees paid; ${settings.exam_min_paid_pct}% required.` });
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

async function conflictsFor(db, e, { excludeId } = {}) {
  const same = await db.examSession.findMany({ where: { date: e.date, status: { not: 'cancelled' }, ...(excludeId && { id: { not: excludeId } }) }, include: { invigilators: true, subject: { select: { name: true } } } });
  const clashing = same.filter(o => overlap(e, o));
  const out = [];
  for (const o of clashing) {
    if (e.room && o.room && e.room.trim().toLowerCase() === o.room.trim().toLowerCase()) out.push({ type: 'room', message: `Room ${o.room} is already used by ${o.subject.name} (${o.start_time}–${o.end_time}).` });
    for (const inv of e.invigilator_ids ?? []) if (o.invigilators.some(x => x.teacher_id === inv)) out.push({ type: 'invigilator', message: `An invigilator is already assigned to ${o.subject.name} at that time.` });
  }
  // students registered for both courses
  if (clashing.length) {
    const mine = new Set(await registeredStudentIds(db, e));
    for (const o of clashing) {
      const theirs = await registeredStudentIds(db, o);
      const both = theirs.filter(id => mine.has(id));
      if (both.length) out.push({ type: 'students', message: `${both.length} student(s) are registered for both this exam and ${o.subject.name} at that time.`, count: both.length });
    }
  }
  return out;
}

function parseExam(b, current = {}) {
  const e = { ...current, ...b };
  if (!DATE_RE.test(e.date ?? '')) return { error: 'date must be YYYY-MM-DD' };
  if (!TIME_RE.test(e.start_time ?? '') || !TIME_RE.test(e.end_time ?? '')) return { error: 'start_time and end_time must be HH:MM' };
  if (mins(e.end_time) <= mins(e.start_time)) return { error: 'The exam must end after it starts' };
  if (!KINDS.includes(e.kind ?? 'final')) return { error: `kind must be one of ${KINDS.join(', ')}` };
  return { e };
}

router.get('/', ...staffRead, async (req, res) => {
  const where = {};
  if (req.query.termId) where.term_id = String(req.query.termId);
  if (req.query.date) where.date = String(req.query.date);
  if (req.query.status) where.status = String(req.query.status);
  if (req.user.role === 'teacher') where.OR = [{ invigilators: { some: { teacher_id: req.user.teacher_id } } }, { subject: { offerings: { some: { teacher_id: req.user.teacher_id } } } }];
  const rows = await req.db.examSession.findMany({ where, include: EXAM_INCLUDE, orderBy: [{ date: 'asc' }, { start_time: 'asc' }], take: 500 });
  res.json(rows.map(dto));
});

router.post('/', ...approvers, async (req, res) => {
  const b = req.body;
  if (!b.subject_id || !b.term_id || !b.title?.trim()) return res.status(422).json({ error: 'subject_id, term_id and title are required' });
  const p = parseExam(b, { kind: 'final' }); if (p.error) return res.status(422).json({ error: p.error });
  const [subject, term] = await Promise.all([req.db.subject.findUnique({ where: { id: b.subject_id } }), req.db.term.findUnique({ where: { id: b.term_id } })]);
  if (!subject) return res.status(422).json({ error: 'Unknown course' }); if (!term) return res.status(422).json({ error: 'Unknown semester' });
  const inv = [...new Set(b.invigilator_ids ?? [])];
  if (inv.length && (await req.db.teacher.count({ where: { id: { in: inv } } })) !== inv.length) return res.status(422).json({ error: 'Unknown invigilator' });
  const conflicts = await conflictsFor(req.db, { ...p.e, invigilator_ids: inv });
  if (conflicts.length && !(b.override && b.override_reason?.trim())) return res.status(409).json({ error: conflicts.map(c => c.message).join(' '), code: 'exam_conflict', conflicts });
  const id = uuid();
  await req.db.examSession.create({ data: { id, subject_id: b.subject_id, term_id: b.term_id, offering_id: b.offering_id || null, title: b.title.trim(), kind: p.e.kind ?? 'final', date: p.e.date, start_time: p.e.start_time, end_time: p.e.end_time, room: b.room || null, created_by: req.user.id, invigilators: inv.length ? { create: inv.map(t => ({ teacher_id: t })) } : undefined } });
  await audit(req.db, actorOf(req.user), conflicts.length ? 'exam.create_override' : 'exam.create', 'exam_session', id, { reason: conflicts.length ? b.override_reason : undefined, after: { course: subject.code, date: p.e.date } });
  res.status(201).json({ ...dto(await req.db.examSession.findUnique({ where: { id }, include: EXAM_INCLUDE })), conflicts });
});

router.put('/:id', ...approvers, async (req, res) => {
  const cur = await req.db.examSession.findUnique({ where: { id: req.params.id }, include: { invigilators: true } });
  if (!cur) return res.status(404).json({ error: 'Exam not found' });
  if (cur.status !== 'scheduled') return res.status(409).json({ error: `A ${cur.status} exam cannot be edited.` });
  const b = req.body, p = parseExam(b, cur); if (p.error) return res.status(422).json({ error: p.error });
  const inv = b.invigilator_ids ? [...new Set(b.invigilator_ids)] : cur.invigilators.map(i => i.teacher_id);
  if (b.invigilator_ids && inv.length && (await req.db.teacher.count({ where: { id: { in: inv } } })) !== inv.length) return res.status(422).json({ error: 'Unknown invigilator' });
  const conflicts = await conflictsFor(req.db, { ...p.e, subject_id: cur.subject_id, term_id: cur.term_id, offering_id: cur.offering_id, invigilator_ids: inv }, { excludeId: cur.id });
  if (conflicts.length && !(b.override && b.override_reason?.trim())) return res.status(409).json({ error: conflicts.map(c => c.message).join(' '), code: 'exam_conflict', conflicts });
  await req.db.$transaction([
    req.db.examSession.update({ where: { id: cur.id }, data: { title: b.title?.trim() || cur.title, kind: p.e.kind, date: p.e.date, start_time: p.e.start_time, end_time: p.e.end_time, room: b.room === undefined ? cur.room : b.room || null } }),
    ...(b.invigilator_ids ? [req.db.examInvigilator.deleteMany({ where: { exam_id: cur.id } }), req.db.examInvigilator.createMany({ data: inv.map(t => ({ exam_id: cur.id, teacher_id: t })) })] : []),
  ]);
  await audit(req.db, actorOf(req.user), conflicts.length ? 'exam.update_override' : 'exam.update', 'exam_session', cur.id, { reason: conflicts.length ? b.override_reason : undefined, before: { date: cur.date, start_time: cur.start_time, room: cur.room }, after: { date: p.e.date, start_time: p.e.start_time, room: b.room ?? cur.room } });
  // schedule change → tell the registered students
  if (cur.date !== p.e.date || cur.start_time !== p.e.start_time || cur.end_time !== p.e.end_time || (b.room !== undefined && (b.room || null) !== cur.room)) {
    await safe(async () => {
      const ids = await registeredStudentIds(req.db, cur);
      const users = await req.db.user.findMany({ where: { student_id: { in: ids } }, select: { id: true } });
      await notifyUsers(req.db, users.map(u => u.id), { type: 'exam_rescheduled', title: 'Exam schedule changed', body: `${cur.title}: now ${p.e.date} ${p.e.start_time}–${p.e.end_time}${(b.room ?? cur.room) ? ` · ${b.room ?? cur.room}` : ''}`, link: '/student/exams' });
    });
  }
  res.json({ ...dto(await req.db.examSession.findUnique({ where: { id: cur.id }, include: EXAM_INCLUDE })), conflicts });
});

router.post('/:id/cancel', ...approvers, async (req, res) => {
  if (!req.body.reason?.trim()) return res.status(422).json({ error: 'A reason is required.' });
  const e = await req.db.examSession.findUnique({ where: { id: req.params.id } });
  if (!e) return res.status(404).json({ error: 'Exam not found' });
  if (e.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled' });
  await req.db.examSession.update({ where: { id: e.id }, data: { status: 'cancelled' } });
  await audit(req.db, actorOf(req.user), 'exam.cancel', 'exam_session', e.id, { reason: req.body.reason });
  res.json({ ok: true });
});

router.post('/:id/complete', ...approvers, async (req, res) => {
  const e = await req.db.examSession.findUnique({ where: { id: req.params.id } });
  if (!e) return res.status(404).json({ error: 'Exam not found' });
  if (e.status !== 'scheduled') return res.status(409).json({ error: `This exam is ${e.status}.` });
  await req.db.examSession.update({ where: { id: e.id }, data: { status: 'held' } });
  await audit(req.db, actorOf(req.user), 'exam.held', 'exam_session', e.id);
  res.json({ ok: true });
});

// ── Candidates ────────────────────────────────────────────────────────────────
async function canSeeExam(req, e) {
  if (['super_admin', 'academic_officer', 'head_teacher'].includes(req.user.role)) return true;
  if (req.user.role !== 'teacher') return false;
  if (await req.db.examInvigilator.findUnique({ where: { exam_id_teacher_id: { exam_id: e.id, teacher_id: req.user.teacher_id } } })) return true;
  return !!(await req.db.courseOffering.findFirst({ where: { subject_id: e.subject_id, term_id: e.term_id, teacher_id: req.user.teacher_id } }));
}

router.post('/:id/candidates/generate', ...approvers, async (req, res) => {
  const exam = await req.db.examSession.findUnique({ where: { id: req.params.id }, include: { term: true } });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.status === 'cancelled') return res.status(409).json({ error: 'This exam is cancelled.' });
  const settings = (await req.db.academicSettings.findUnique({ where: { id: 'main' } })) ?? {};
  const ids = await registeredStudentIds(req.db, exam);
  const students = await req.db.student.findMany({ where: { id: { in: ids } } });
  const existing = Object.fromEntries((await req.db.examCandidate.findMany({ where: { exam_id: exam.id } })).map(c => [c.student_id, c]));
  const same = (await req.db.examSession.findMany({ where: { date: exam.date, status: { not: 'cancelled' }, id: { not: exam.id } } })).filter(o => overlap(exam, o));
  let created = 0, updated = 0, ineligible = 0; const clashes = [];
  for (const s of students) {
    const ev = await eligibility(req.db, s, exam, settings, exam.term);
    const ex = existing[s.id];
    if (ex?.override_by) { updated++; continue; }   // a reviewer's override is never recomputed away
    const data = { eligible: ev.eligible, ineligible_reasons: ev.eligible ? null : ev.reasons };
    if (ex) { await req.db.examCandidate.update({ where: { id: ex.id }, data }); updated++; }
    else { await req.db.examCandidate.create({ data: { id: uuid(), exam_id: exam.id, student_id: s.id, ...data } }); created++; }
    if (!ev.eligible) ineligible++;
    for (const o of same) if ((await registeredStudentIds(req.db, o)).includes(s.id)) clashes.push({ student_id: s.id, with_exam: o.id });
  }
  // students who are no longer registered drop off the list (unless attendance was already recorded)
  await req.db.examCandidate.deleteMany({ where: { exam_id: exam.id, student_id: { notIn: ids }, attendance: null } });
  await audit(req.db, actorOf(req.user), 'exam.candidates_generated', 'exam_session', exam.id, { after: { created, updated, ineligible } });
  res.json({ created, updated, ineligible, clashes });
});

router.get('/:id/candidates', ...staffRead, async (req, res) => {
  const exam = await req.db.examSession.findUnique({ where: { id: req.params.id }, include: EXAM_INCLUDE });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (!(await canSeeExam(req, exam))) return res.status(403).json({ error: 'You are not assigned to this exam' });
  const rows = await req.db.examCandidate.findMany({ where: { exam_id: exam.id }, include: { student: { select: { first_name: true, last_name: true, student_number: true, class_name: true } } }, orderBy: [{ student: { last_name: 'asc' } }, { student: { first_name: 'asc' } }] });
  res.json({ exam: dto(exam), candidates: rows.map(c => ({ id: c.id, student_id: c.student_id, name: `${c.student.first_name} ${c.student.last_name}`, matricule: c.student.student_number, class_name: c.student.class_name, eligible: c.eligible, reasons: c.ineligible_reasons, override_reason: c.override_reason, attendance: c.attendance })) });
});

router.post('/:id/candidates/:studentId/override', ...approvers, async (req, res) => {
  if (!req.body.reason?.trim()) return res.status(422).json({ error: 'A reason is required to override ineligibility.' });
  const c = await req.db.examCandidate.findUnique({ where: { exam_id_student_id: { exam_id: req.params.id, student_id: req.params.studentId } } });
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  await req.db.examCandidate.update({ where: { id: c.id }, data: { eligible: true, override_by: req.user.id, override_reason: req.body.reason.trim() } });
  await audit(req.db, actorOf(req.user), 'exam.eligibility_override', 'exam_candidate', c.id, { reason: req.body.reason, before: { eligible: c.eligible, reasons: c.ineligible_reasons } });
  res.json({ ok: true });
});

router.post('/:id/attendance', ...staffRead, async (req, res) => {
  const exam = await req.db.examSession.findUnique({ where: { id: req.params.id } });
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const isApprover = ['super_admin', 'academic_officer', 'head_teacher'].includes(req.user.role);
  if (!isApprover && !(await req.db.examInvigilator.findUnique({ where: { exam_id_teacher_id: { exam_id: exam.id, teacher_id: req.user.teacher_id } } }))) return res.status(403).json({ error: 'Only the invigilators of this exam can record attendance.' });
  if (exam.status === 'cancelled') return res.status(409).json({ error: 'This exam is cancelled.' });
  const records = Array.isArray(req.body.records) ? req.body.records : null;
  if (!records) return res.status(422).json({ error: 'records[] required' });
  let saved = 0; const skipped = [];
  for (const r of records) {
    if (!['present', 'absent'].includes(r.attendance)) { skipped.push({ student_id: r.student_id, error: 'attendance must be present or absent' }); continue; }
    const c = await req.db.examCandidate.findUnique({ where: { exam_id_student_id: { exam_id: exam.id, student_id: r.student_id } } });
    if (!c) { skipped.push({ student_id: r.student_id, error: 'Not a candidate of this exam' }); continue; }
    if (!c.eligible && r.attendance === 'present') { skipped.push({ student_id: r.student_id, error: 'Not eligible to sit this exam (a reviewer must override first)' }); continue; }
    await req.db.examCandidate.update({ where: { id: c.id }, data: { attendance: r.attendance, recorded_by: req.user.id, recorded_at: new Date() } });
    saved++;
  }
  res.json({ saved, skipped });
});

// ── Student timetable ───────────────────────────────────────────────────────────
router.get('/me/timetable', authenticate, authorize('student'), async (req, res) => {
  const sid = req.user.student_id;
  const enrol = await req.db.courseEnrollment.findMany({ where: { student_id: sid, status: 'registered' }, include: { offering: true } });
  const keys = enrol.map(e => ({ subject_id: e.offering.subject_id, term_id: e.term_id }));
  if (!keys.length) return res.json([]);
  const exams = await req.db.examSession.findMany({ where: { OR: keys, status: { not: 'cancelled' } }, include: { subject: { select: { name: true, code: true } }, term: { include: { academic_year: true } }, candidates: { where: { student_id: sid } } }, orderBy: [{ date: 'asc' }, { start_time: 'asc' }] });
  res.json(exams.map(e => ({ id: e.id, title: e.title, kind: e.kind, course: e.subject.name, code: e.subject.code, date: e.date, start_time: e.start_time, end_time: e.end_time, room: e.room, status: e.status, term: e.term.name, academic_year: e.term.academic_year.label, eligible: e.candidates[0]?.eligible ?? null, reasons: e.candidates[0] && !e.candidates[0].eligible ? e.candidates[0].ineligible_reasons : null })));
});

module.exports = router;
