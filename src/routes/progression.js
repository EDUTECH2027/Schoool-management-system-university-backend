// Academic progression: compute proposals from published results (configurable rules), review them, and
// apply the approved ones. Applying never rewrites results — it moves the student's cohort and appends to
// their enrolment history.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { run } = require('../academics/progression');
const { audit } = require('../academics/registration');
const { actorOf } = require('../academics/results');
const { notifyUsers, safe } = require('../utils/notify');

const approvers = [authenticate, authorize('super_admin', 'academic_officer')];

router.post('/run', ...approvers, async (req, res) => {
  const { academic_year_id, programme_id, class_id } = req.body;
  if (!academic_year_id) return res.status(422).json({ error: 'academic_year_id is required' });
  const r = await run(req.db, { academicYearId: academic_year_id, programmeId: programme_id, classId: class_id });
  if (r.error) return res.status(r.status ?? 422).json({ error: r.error });
  await audit(req.db, actorOf(req.user), 'progression.run', 'academic_year', academic_year_id, { after: r.counts });
  res.json(r);
});

router.get('/', ...approvers, async (req, res) => {
  const { academicYearId, status, outcome, programmeId, q } = req.query;
  const where = {};
  if (academicYearId) where.academic_year_id = String(academicYearId);
  if (status) where.status = String(status);
  if (outcome) where.outcome = String(outcome);
  if (programmeId) where.programme_id = String(programmeId);
  if (q) where.student = { OR: [{ first_name: { contains: String(q), mode: 'insensitive' } }, { last_name: { contains: String(q), mode: 'insensitive' } }, { student_number: { contains: String(q), mode: 'insensitive' } }] };
  const rows = await req.db.progressionDecision.findMany({ where, orderBy: [{ outcome: 'asc' }, { student: { last_name: 'asc' } }], take: 500, include: { student: { select: { first_name: true, last_name: true, student_number: true, class_name: true } } } });
  const classes = await req.db.class.findMany({ where: { id: { in: rows.map(r => r.target_class_id).filter(Boolean) } }, select: { id: true, name: true } });
  const cn = Object.fromEntries(classes.map(c => [c.id, c.name]));
  res.json(rows.map(r => ({ id: r.id, student_id: r.student_id, name: `${r.student.first_name} ${r.student.last_name}`, matricule: r.student.student_number, class_name: r.student.class_name, outcome: r.outcome, status: r.status, metrics: r.metrics, target_class_id: r.target_class_id, target_class: cn[r.target_class_id] ?? null, note: r.note, decided_at: r.decided_at })));
});

router.post('/:id/decision', ...approvers, async (req, res) => {
  const { decision, target_class_id, note } = req.body;
  const d = await req.db.progressionDecision.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Decision not found' });
  if (!['proposed', 'rejected', 'approved'].includes(d.status)) return res.status(409).json({ error: `This decision is already ${d.status}.` });
  if (!['approve', 'reject'].includes(decision)) return res.status(422).json({ error: 'decision must be approve or reject' });
  if (decision === 'reject' && !note?.trim()) return res.status(422).json({ error: 'A reason is required to reject.' });
  if (target_class_id && !(await req.db.class.findUnique({ where: { id: target_class_id } }))) return res.status(422).json({ error: 'Unknown target class' });
  const row = await req.db.progressionDecision.update({ where: { id: d.id }, data: { status: decision === 'approve' ? 'approved' : 'rejected', target_class_id: target_class_id || d.target_class_id, note: note?.trim() || null, decided_by: req.user.id, decided_at: new Date() } });
  await audit(req.db, actorOf(req.user), `progression.${decision}`, 'progression_decision', d.id, { reason: note, before: { status: d.status, outcome: d.outcome }, after: { target_class_id: row.target_class_id } });
  res.json(row);
});

async function recountClass(db, classId) {
  if (!classId) return;
  const n = await db.student.count({ where: { class_id: classId, is_active: true } });
  await db.class.update({ where: { id: classId }, data: { enrolled: n } });
}

router.post('/:id/apply', ...approvers, async (req, res) => {
  const d = await req.db.progressionDecision.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Decision not found' });
  if (d.status !== 'approved') return res.status(409).json({ error: d.status === 'applied' ? 'Already applied.' : 'Approve this decision before applying it.' });
  const student = await req.db.student.findUnique({ where: { id: d.student_id }, include: { class: { include: { programme: true, grade_level: true } } } });
  const moves = ['promoted', 'carryover'].includes(d.outcome);
  if (moves && !d.target_class_id) return res.status(422).json({ error: 'Choose the class the student is promoted to (set it when approving).' });
  const target = d.target_class_id ? await req.db.class.findUnique({ where: { id: d.target_class_id }, include: { programme: true, grade_level: true } }) : null;
  const now = new Date();
  await req.db.$transaction(async tx => {
    const reasonText = { promoted: 'Promoted', carryover: 'Promoted with carry-over courses', repeat: 'Repeats the level', probation: 'Academic probation', eligible_graduation: 'Graduated' }[d.outcome] ?? d.outcome;
    // Students created after the academic module went live have no history yet: record where they were before this change.
    if (!(await tx.studentEnrollmentHistory.count({ where: { student_id: student.id } })) && student.class) {
      await tx.studentEnrollmentHistory.create({ data: { id: uuid(), student_id: student.id, class_id: student.class_id, class_name: student.class.name, programme_id: student.class.programme_id ?? null, programme_name: student.class.programme?.name ?? null, level_name: student.class.grade_level?.name ?? null, reason: 'Enrolment', started_at: student.created_at ?? now, ended_at: now } });
    }
    await tx.studentEnrollmentHistory.updateMany({ where: { student_id: student.id, ended_at: null }, data: { ended_at: now } });
    if (d.outcome === 'eligible_graduation') {
      await tx.student.update({ where: { id: student.id }, data: { academic_status: 'graduated', updated_at: now } });
      await tx.studentEnrollmentHistory.create({ data: { id: uuid(), student_id: student.id, academic_year_id: d.academic_year_id, class_id: student.class_id, class_name: student.class?.name ?? null, programme_id: student.class?.programme_id ?? null, programme_name: student.class?.programme?.name ?? null, level_name: student.class?.grade_level?.name ?? null, reason: reasonText, started_at: now } });
    } else {
      const cls = (moves || target) ? target : student.class;
      if (cls && cls.id !== student.class_id) await tx.student.update({ where: { id: student.id }, data: { class_id: cls.id, class_name: cls.name, grade_level_name: cls.grade_level?.name ?? null, updated_at: now } });
      await tx.studentEnrollmentHistory.create({ data: { id: uuid(), student_id: student.id, academic_year_id: d.academic_year_id, class_id: cls?.id ?? null, class_name: cls?.name ?? null, programme_id: cls?.programme_id ?? null, programme_name: cls?.programme?.name ?? null, level_name: cls?.grade_level?.name ?? null, reason: reasonText, started_at: now } });
    }
    await tx.progressionDecision.update({ where: { id: d.id }, data: { status: 'applied' } });
    await audit(tx, actorOf(req.user), 'progression.apply', 'progression_decision', d.id, { after: { outcome: d.outcome, student_id: student.id, to_class: target?.id ?? null } });
  });
  await recountClass(req.db, student.class_id); if (target) await recountClass(req.db, target.id);
  await safe(async () => {
    const users = await req.db.user.findMany({ where: { student_id: student.id }, select: { id: true } });
    await notifyUsers(req.db, users.map(u => u.id), { type: 'progression', title: 'Your academic progression was recorded', body: { promoted: 'You have been promoted.', carryover: 'You have been promoted with carry-over courses.', repeat: 'You will repeat the level.', probation: 'You are on academic probation.', eligible_graduation: 'Congratulations — you are eligible to graduate.' }[d.outcome], link: '/student/dashboard' });
  });
  res.json({ ok: true });
});

// What a student may see: only decisions that were approved or applied
router.get('/me', authenticate, authorize('student'), async (req, res) => {
  const rows = await req.db.progressionDecision.findMany({ where: { student_id: req.user.student_id, status: { in: ['approved', 'applied'] } }, orderBy: { created_at: 'desc' } });
  const years = await req.db.academicYear.findMany({ where: { id: { in: rows.map(r => r.academic_year_id) } } });
  const yb = Object.fromEntries(years.map(y => [y.id, y.label]));
  res.json(rows.map(r => ({ id: r.id, academic_year: yb[r.academic_year_id], outcome: r.outcome, status: r.status, note: r.note, metrics: { year_gpa: r.metrics.year_gpa, cumulative_gpa: r.metrics.cumulative_gpa, earned_credits: r.metrics.earned_credits } })));
});

module.exports = router;
