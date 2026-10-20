const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getScheme } = require('../academics/gradingScheme');
const { saveMark, saveMarks, ResultsError } = require('../academics/results');

// Direct mark entry/edit is for academic administrators (lecturers use the teacher portal, whose entries are
// drafts that must be submitted and approved). Reading is limited to staff: students and parents get
// their PUBLISHED marks only, through the portal endpoints.
const approvers = [authenticate, authorize('super_admin', 'academic_officer')];
const staff = [authenticate, authorize('super_admin', 'academic_officer', 'teacher')];

// GET /api/marks?termId=t1&classId=c4&studentId=st6&subjectId=sub1&status=published
router.get('/', ...staff, async (req, res) => {
  const { termId, classId, studentId, subjectId, status } = req.query;
  const where = {};
  if (termId) where.term_id = termId;
  if (classId) where.class_id = classId;
  if (studentId) where.student_id = studentId;
  if (subjectId) where.subject_id = subjectId;
  if (status) where.status = status;
  res.json(await req.db.mark.findMany({ where }));
});

// POST /api/marks  — bulk upsert (administrator entries are authoritative → published, with history)
router.post('/', ...approvers, async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records)) return res.status(422).json({ error: 'Body must be an array' });
  if (records.length === 0) return res.status(201).json({ saved: 0 });

  // Validate that the referenced term and subject exist before starting inserts.
  // This gives a clear error instead of a cryptic FK constraint message.
  const firstRecord = records.find(r => r.termId && r.subjectId);
  if (firstRecord) {
    const termExists = await req.db.term.findUnique({ where: { id: firstRecord.termId } });
    const subjectExists = await req.db.subject.findUnique({ where: { id: firstRecord.subjectId } });
    if (!termExists) return res.status(422).json({ error: `Semester not found: ${firstRecord.termId}` });
    if (!subjectExists) return res.status(422).json({ error: `Course not found: ${firstRecord.subjectId}` });
  }

  const scheme = await getScheme(req.db);
  const { saved, errors } = await saveMarks(req.db, scheme, records, req.user);
  if (saved === 0 && errors.length > 0) return res.status(500).json({ error: errors[0].error, details: errors });
  res.status(201).json({ saved, ...(errors.length > 0 && { skipped: errors }) });
});

// PUT /api/marks/:id
router.put('/:id', ...approvers, async (req, res) => {
  const existing = await req.db.mark.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Mark not found' });
  const { caScore, examScore, grade, remark, resitScore, examAbsent, reason } = req.body;
  try {
    const scheme = await getScheme(req.db);
    const { mark } = await saveMark(req.db, scheme, {
      studentId: existing.student_id, subjectId: existing.subject_id, termId: existing.term_id, classId: existing.class_id,
      caScore, examScore, grade, remark, resitScore, examAbsent: examAbsent ?? existing.exam_absent,
    }, req.user, { reason });
    res.json(mark);
  } catch (e) { if (e instanceof ResultsError) return res.status(e.status).json({ error: e.message }); throw e; }
});

module.exports = router;
