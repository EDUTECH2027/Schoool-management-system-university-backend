// E-learning assessments: assignments, quizzes, gradebook — attached to a CourseOffering. See docs/ASSESSMENTS.md.
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const C = require('../assessments/common');
const GB = require('../assessments/gradebook');
const { AErr } = C;

router.use(authenticate);

// Offerings the caller can work with: lecturer = own, staff = all (optional ?termId), student = registered ones.
router.get('/offerings', async (req, res) => {
  const where = {};
  if (req.query.termId) where.term_id = String(req.query.termId);
  if (req.user.role === 'teacher') { if (!req.user.teacher_id) throw new AErr('Forbidden', 403); where.teacher_id = req.user.teacher_id; }
  else if (req.user.role === 'student') where.id = { in: await C.offeringIdsOfStudent(req.db, req.user.student_id) };
  else if (!C.isStaff(req.user)) throw new AErr('Forbidden', 403);
  const rows = await req.db.courseOffering.findMany({ where, include: { ...C.offeringInclude, _count: { select: { assignments: true, quizzes: true } } }, orderBy: [{ term: { start_date: 'desc' } }, { subject: { name: 'asc' } }] });
  res.json(rows.map(o => ({ ...C.offeringInfo(o), assignments: o._count.assignments, quizzes: o._count.quizzes })));
});

// ── gradebook ──────────────────────────────────────────────────────────────────────
router.get('/gradebook/me', async (req, res) => {
  if (req.user.role !== 'student' || !req.user.student_id) throw new AErr('Only students have a personal gradebook', 403);
  const ids = await C.offeringIdsOfStudent(req.db, req.user.student_id);
  const offerings = await req.db.courseOffering.findMany({ where: { id: { in: ids } }, include: C.offeringInclude });
  const out = [];
  for (const o of offerings) {
    const g = await GB.build(req.db, o.id, { onlyStudentId: req.user.student_id });
    if (g.columns.length) out.push({ offering: C.offeringInfo(o), columns: g.columns, line: g.students[0] ?? null });
  }
  res.json(out);
});

router.get('/gradebook/:offeringId', async (req, res) => {
  const o = await C.getOffering(req.db, req.params.offeringId);
  if (req.user.role === 'student') {
    if (!(await C.onRoster(req.db, req.user.student_id, o.id))) throw new AErr('You are not registered for this course', 403);
    const g = await GB.build(req.db, o.id, { onlyStudentId: req.user.student_id });
    return res.json({ offering: C.offeringInfo(o), columns: g.columns, students: g.students });
  }
  C.manageAccess(req.user, o);
  res.json({ offering: C.offeringInfo(o), ...(await GB.build(req.db, o.id)) });
});

// Preview (dry_run) is open to the lecturer and staff; the real write is the offering's lecturer only
// (an approver going through saveMark would publish the mark directly, which this endpoint must never do).
router.post('/gradebook/:offeringId/export-ca', async (req, res) => {
  const o = await C.getOffering(req.db, req.params.offeringId);
  const dry = req.body?.dry_run !== false;   // safe default: nothing is written unless dry_run is explicitly false
  C.manageAccess(req.user, o, { staffOk: dry });
  if (!dry) {
    const now = new Date();
    if (!(await req.db.marksSession.findFirst({ where: { start_at: { lte: now }, end_at: { gte: now } } }))) throw new AErr('Marks filling is currently closed. Ask an administrator to open a marks session.', 403, 'marks_closed');
  }
  if (req.body?.student_ids !== undefined && !Array.isArray(req.body.student_ids)) throw new AErr('student_ids must be an array');
  const out = await GB.exportCA(req.db, o, req.user, C.actorOf(req.user), { dry, studentIds: req.body?.student_ids });
  res.json(out);
});

router.use('/assignments', require('../assessments/assignments'));
router.use('/quizzes', require('../assessments/quizzes'));
router.use(C.errorHandler);

module.exports = router;
