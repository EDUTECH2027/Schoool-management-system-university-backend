// Lecturer workspace: my course offerings, their rosters (driven by registrations), mark entry (drafts) and
// submission for validation. A lecturer only ever sees/edits offerings assigned to them.
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getScheme } = require('../academics/gradingScheme');
const { saveMarks, transition, actorOf } = require('../academics/results');
const reg = require('../academics/registration');

router.use(authenticate, authorize('teacher'));

const tid = req => req.user.teacher_id;
async function ownOffering(req, res) {
  const o = await req.db.courseOffering.findUnique({ where: { id: req.params.id }, include: { subject: true, term: { include: { academic_year: true } } } });
  if (!o || o.teacher_id !== tid(req)) { res.status(o ? 403 : 404).json({ error: o ? 'This is not your course' : 'Offering not found' }); return null; }
  return o;
}
async function rosterWithMarks(db, o) {
  const enrollments = await db.courseEnrollment.findMany({ where: { offering_id: o.id, status: 'registered' }, include: { student: { include: { class: true } } }, orderBy: [{ student: { last_name: 'asc' } }, { student: { first_name: 'asc' } }] });
  const studentIds = enrollments.map(e => e.student_id);
  const [marks, cands] = await Promise.all([
    db.mark.findMany({ where: { subject_id: o.subject_id, term_id: o.term_id, student_id: { in: studentIds } } }),
    db.examCandidate.findMany({ where: { student_id: { in: studentIds }, exam: { subject_id: o.subject_id, term_id: o.term_id, status: { not: 'cancelled' } } }, include: { exam: { select: { kind: true } } } }),
  ]);
  const markBy = Object.fromEntries(marks.map(m => [m.student_id, m]));
  const candBy = {}; for (const c of cands) (candBy[c.student_id] ??= []).push(c);
  return enrollments.map(e => {
    const m = markBy[e.student_id], c = candBy[e.student_id] ?? [];
    return {
      student_id: e.student_id, name: `${e.student.first_name} ${e.student.last_name}`, matricule: e.student.student_number, class_id: e.student.class_id,
      mark: m ? { id: m.id, ca_score: m.ca_score, exam_score: m.exam_score, total_score: m.total_score, grade: m.grade, remark: m.remark, status: m.status, exam_absent: m.exam_absent } : null,
      exam_eligible: c.length ? c.every(x => x.eligible) : null, exam_attendance: c.find(x => x.attendance)?.attendance ?? null,
    };
  });
}

// GET /api/lecturer/offerings?termId=
router.get('/offerings', async (req, res) => {
  const where = { teacher_id: tid(req) };
  if (req.query.termId) where.term_id = String(req.query.termId);
  const rows = await req.db.courseOffering.findMany({
    where, include: { subject: true, term: { include: { academic_year: true } }, slots: true, _count: { select: { enrollments: { where: { status: 'registered' } } } } },
    orderBy: [{ term: { start_date: 'desc' } }, { subject: { name: 'asc' } }],
  });
  const markStats = await req.db.mark.groupBy({ by: ['subject_id', 'term_id', 'status'], where: { OR: rows.map(r => ({ subject_id: r.subject_id, term_id: r.term_id })) }, _count: { _all: true } });
  res.json(rows.map(o => ({
    id: o.id, course: o.subject.name, code: o.subject.code, credits: o.subject.credit_hours, section: o.section, term_id: o.term_id, term: o.term.name, academic_year: o.term.academic_year.label,
    capacity: o.capacity, registered: o._count.enrollments, slots: o.slots.map(s => ({ day: s.day, period: s.period_key, room: s.room })),
    marks: Object.fromEntries(['draft', 'submitted', 'approved', 'published'].map(st => [st, markStats.filter(m => m.subject_id === o.subject_id && m.term_id === o.term_id && m.status === st).reduce((x, m) => x + m._count._all, 0)])),
  })));
});

router.get('/offerings/:id/roster', async (req, res) => {
  const o = await ownOffering(req, res); if (!o) return;
  res.json({ offering: { id: o.id, course: o.subject.name, code: o.subject.code, section: o.section, term_id: o.term_id, term: o.term.name, academic_year: o.term.academic_year.label }, students: await rosterWithMarks(req.db, o) });
});

// POST /api/lecturer/offerings/:id/marks  { marks: [{ student_id, ca_score, exam_score, exam_absent }] }  → DRAFTS
router.post('/offerings/:id/marks', async (req, res) => {
  const o = await ownOffering(req, res); if (!o) return;
  if (!Array.isArray(req.body.marks)) return res.status(422).json({ error: 'marks[] required' });
  const now = new Date();
  if (!(await req.db.marksSession.findFirst({ where: { start_at: { lte: now }, end_at: { gte: now } } }))) {
    return res.status(403).json({ error: 'Marks filling is currently closed. Ask an administrator to open a marks session.' });
  }
  const enrolled = await req.db.courseEnrollment.findMany({ where: { offering_id: o.id, status: 'registered' }, include: { student: true } });
  const by = Object.fromEntries(enrolled.map(e => [e.student_id, e.student]));
  const records = [], rejected = [];
  for (const m of req.body.marks) {
    const st = by[m.student_id];
    if (!st) { rejected.push({ studentId: m.student_id, error: 'Student is not registered for this course', code: 'not_enrolled' }); continue; }
    records.push({ studentId: st.id, subjectId: o.subject_id, termId: o.term_id, classId: st.class_id, offeringId: o.id, studentName: `${st.first_name} ${st.last_name}`, studentNumber: st.student_number, subjectName: o.subject.name, caScore: m.ca_score, examScore: m.exam_score, examAbsent: m.exam_absent });
  }
  const scheme = await getScheme(req.db);
  const { saved, errors } = await saveMarks(req.db, scheme, records, req.user);
  res.json({ saved, skipped: [...rejected, ...errors] });
});

// POST /api/lecturer/offerings/:id/submit  — send all my drafts for validation
router.post('/offerings/:id/submit', async (req, res) => {
  const o = await ownOffering(req, res); if (!o) return;
  const ids = (await req.db.courseEnrollment.findMany({ where: { offering_id: o.id, status: 'registered' }, select: { student_id: true } })).map(e => e.student_id);
  const marks = await req.db.mark.findMany({ where: { subject_id: o.subject_id, term_id: o.term_id, student_id: { in: ids } }, select: { id: true, status: true } });
  if (!marks.length) return res.status(422).json({ error: 'There are no marks to submit yet.' });
  const missing = ids.length - marks.length;
  const r = await transition(req.db, 'submit', { markIds: marks.map(m => m.id) }, req.user, { ownsMark: async () => true });
  res.json({ ...r, students_without_marks: missing });
});

module.exports = router;
module.exports.rosterWithMarks = rosterWithMarks;
void actorOf; void reg;
