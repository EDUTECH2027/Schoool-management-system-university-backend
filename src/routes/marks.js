const router = require('express').Router();
const authenticate = require('../middleware/auth');
const { v4: uuid } = require('uuid');
const { gradeFor, totalFor, clampScore } = require('../utils/grading');

// A resit is optional — most students never take one, so an absent/empty
// value means "no resit", not "resit score 0". Only a genuine number counts.
const resitFieldsFor = (resitScore) => {
  if (resitScore === undefined || resitScore === null || resitScore === '') {
    return { resit_score: null, resit_grade: null };
  }
  const score = clampScore(resitScore);
  return { resit_score: score, resit_grade: gradeFor(score).grade };
};

// GET /api/marks?termId=t1&classId=c4&studentId=st6&subjectId=sub1
router.get('/', authenticate, async (req, res) => {
  const { termId, classId, studentId, subjectId } = req.query;
  const where = {};
  if (termId) where.term_id = termId;
  if (classId) where.class_id = classId;
  if (studentId) where.student_id = studentId;
  if (subjectId) where.subject_id = subjectId;
  res.json(await req.db.mark.findMany({ where }));
});

// POST /api/marks  — bulk upsert
router.post('/', authenticate, async (req, res) => {
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

  let saved = 0;
  const errors = [];
  for (const r of records) {
    if (!r.studentId || !r.subjectId || !r.termId) continue;
    try {
      const ca = clampScore(r.caScore);
      const exam = clampScore(r.examScore);
      const total = totalFor(ca, exam);
      const { grade, remark } = gradeFor(total);
      const resitFields = resitFieldsFor(r.resitScore);
      await req.db.mark.upsert({
        where: { marks_student_subject_term: { student_id: r.studentId, subject_id: r.subjectId, term_id: r.termId } },
        update: { ca_score: ca, exam_score: exam, total_score: total, grade: r.grade || grade, remark: r.remark || remark, ...resitFields, updated_at: new Date() },
        create: {
          id: r.id || uuid(), student_id: r.studentId, student_name: r.studentName || null, student_number: r.studentNumber || null,
          subject_id: r.subjectId, subject_name: r.subjectName || null, term_id: r.termId, class_id: r.classId || null,
          ca_score: ca, exam_score: exam, total_score: total, grade: r.grade || grade, remark: r.remark || remark,
          ...resitFields,
        },
      });
      saved++;
    } catch (err) {
      console.error(`[POST /api/marks] record skipped (${r.studentId}/${r.subjectId}):`, err.message);
      errors.push({ studentId: r.studentId, subjectId: r.subjectId, error: err.message });
    }
  }

  if (saved === 0 && errors.length > 0) {
    return res.status(500).json({ error: errors[0].error, details: errors });
  }
  res.status(201).json({ saved, ...(errors.length > 0 && { skipped: errors }) });
});

// PUT /api/marks/:id
router.put('/:id', authenticate, async (req, res) => {
  const { caScore, examScore, grade, remark, resitScore } = req.body;
  const ca = clampScore(caScore);
  const exam = clampScore(examScore);
  const total = totalFor(ca, exam);
  const auto = gradeFor(total);
  const updated = await req.db.mark.update({
    where: { id: req.params.id },
    data: {
      ca_score: ca, exam_score: exam, total_score: total,
      grade: grade || auto.grade, remark: remark || auto.remark,
      ...resitFieldsFor(resitScore), updated_at: new Date(),
    },
  });
  res.json(updated);
});

module.exports = router;
