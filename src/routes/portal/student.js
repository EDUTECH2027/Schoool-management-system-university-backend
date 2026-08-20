const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/authorize');
const { sortByDay } = require('../../utils/dayOrder');
const { getLiveGpaSummary } = require('../../utils/transcriptMath');
const { upload, UPLOADS_ROOT } = require('../../utils/studentUploads');

const guard = [authenticate, authorize('student')];
const sid = req => req.user.student_id;

// GET /api/portal/student/profile
router.get('/profile', ...guard, async (req, res) => {
  const s = await req.db.student.findUnique({
    where: { id: sid(req) },
    include: { documents: { orderBy: { created_at: 'desc' } } },
  });
  if (!s) return res.status(404).json({ error: 'Student profile not found' });
  res.json(s);
});

// POST /api/portal/student/documents — self-service upload, kept on the
// student's own record permanently until they delete it themselves.
router.post('/documents', ...guard, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'file is required' });
  const title = (req.body.title || req.file.originalname).trim();
  const url = `/uploads/${req.user.school_id}/students/${req.file.filename}`;
  const created = await req.db.studentDocument.create({
    data: { id: uuid(), student_id: sid(req), title, file_url: url },
  });
  res.status(201).json(created);
});

// DELETE /api/portal/student/documents/:id — only ever their own document.
router.delete('/documents/:id', ...guard, async (req, res) => {
  const doc = await req.db.studentDocument.findUnique({ where: { id: req.params.id } });
  if (!doc || doc.student_id !== sid(req)) return res.status(404).json({ error: 'Document not found' });

  await req.db.studentDocument.delete({ where: { id: doc.id } });

  // Best-effort cleanup of the on-disk file.
  const filePath = path.join(UPLOADS_ROOT, doc.file_url.replace('/uploads/', ''));
  fs.unlink(filePath, () => {});

  res.status(204).end();
});

// GET /api/portal/student/marks?termId=
router.get('/marks', ...guard, async (req, res) => {
  const { termId } = req.query;
  const where = { student_id: sid(req) };
  if (termId) where.term_id = termId;
  res.json(await req.db.mark.findMany({ where, orderBy: { subject_name: 'asc' } }));
});

// GET /api/portal/student/attendance?from=&to=
router.get('/attendance', ...guard, async (req, res) => {
  const { from, to } = req.query;
  const where = { student_id: sid(req) };
  if (from || to) where.date = { ...(from && { gte: from }), ...(to && { lte: to }) };
  res.json(await req.db.attendanceRecord.findMany({ where, orderBy: { date: 'desc' } }));
});

// GET /api/portal/student/timetable
router.get('/timetable', ...guard, async (req, res) => {
  const student = await req.db.student.findUnique({ where: { id: sid(req) }, select: { class_id: true } });
  if (!student || !student.class_id) return res.json([]);
  const rows = await req.db.teacherSchedule.findMany({
    where: { class_id: student.class_id },
    include: { teacher: { select: { first_name: true, last_name: true } } },
  });
  res.json(sortByDay(rows, 'day', 'period_key').map(({ teacher, ...rest }) => ({
    ...rest, teacher_name: teacher ? `${teacher.first_name} ${teacher.last_name}` : null,
  })));
});

// GET /api/portal/student/transcript — the official document, gated behind
// the admin having generated + published it.
router.get('/transcript', ...guard, async (req, res) => {
  const t = await req.db.transcript.findFirst({
    where: { student_id: sid(req), status: { in: ['published', 'printed'] } },
    include: { entries: { orderBy: [{ term_id: 'asc' }, { subject_name: 'asc' }] } },
  });
  if (!t) return res.status(404).json({ error: 'Transcript not yet published' });
  res.json(t);
});

// GET /api/portal/student/gpa-summary — always live, computed directly from
// current marks/credit-hours regardless of whether a Transcript document has
// been generated or published yet.
router.get('/gpa-summary', ...guard, async (req, res) => {
  res.json(await getLiveGpaSummary(req.db, { studentId: sid(req) }));
});

// GET /api/portal/student/fees
router.get('/fees', ...guard, async (req, res) => {
  const fees = await req.db.feeRecord.findMany({
    where: { student_id: sid(req) },
    include: { payments: { select: { amount: true, method: true, payment_date: true } } },
    orderBy: { created_at: 'desc' },
  });
  res.json(fees.map(({ payments, ...rest }) => ({
    ...rest,
    payments: payments.map(p => ({ amount: p.amount, method: p.method, date: p.payment_date })),
  })));
});

// GET /api/portal/student/behavior
router.get('/behavior', ...guard, async (req, res) => {
  const rows = await req.db.studentBehavior.findMany({
    where: { student_id: sid(req) },
    include: { teacher: { select: { first_name: true, last_name: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(rows.map(({ teacher, ...rest }) => ({ ...rest, teacher_name: teacher ? `${teacher.first_name} ${teacher.last_name}` : null })));
});

module.exports = router;
