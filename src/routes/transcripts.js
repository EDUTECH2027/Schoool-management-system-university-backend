const router = require('express').Router();
const authenticate = require('../middleware/auth');
const { v4: uuid } = require('uuid');
const { buildTranscript, computeGpa, pointsForGrade } = require('../utils/transcriptMath');
const { getScheme } = require('../academics/gradingScheme');

const ENTRIES_INCLUDE = { entries: { orderBy: [{ term_id: 'asc' }, { subject_name: 'asc' }] } };

// POST /api/transcripts/generate — cumulative transcript per active student in
// a class, built from ALL of that student's marks across every term/year on
// record (not scoped to one term — a transcript is a whole academic career).
// Must be defined before /:id to avoid route collision.
router.post('/generate', authenticate, async (req, res) => {
  const { classId } = req.body;
  if (!classId) return res.status(422).json({ error: 'classId required' });

  const students = await req.db.student.findMany({
    where: { class_id: classId, is_active: true },
    orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }],
  });
  if (students.length === 0) return res.status(422).json({ error: 'No active students in this speciality' });

  const studentIds = students.map(s => s.id);
  const scheme = await getScheme(req.db);
  // published marks only — a transcript is an official document built from validated results
  const allMarks = await req.db.mark.findMany({ where: { student_id: { in: studentIds }, status: 'published' } });

  const subjectIds = [...new Set(allMarks.map(m => m.subject_id))];
  const termIds = [...new Set(allMarks.map(m => m.term_id))];
  const [subjectRows, termRows] = await Promise.all([
    subjectIds.length ? req.db.subject.findMany({ where: { id: { in: subjectIds } } }) : [],
    termIds.length ? req.db.term.findMany({ where: { id: { in: termIds } }, include: { academic_year: true } }) : [],
  ]);
  // Credit hours/term labels as of *now* — snapshotted onto each entry below so
  // a later edit doesn't retroactively change an already-generated transcript.
  const creditHoursBySubjectId = Object.fromEntries(subjectRows.map(s => [s.id, s.credit_hours]));
  const termsById = Object.fromEntries(termRows.map(t => [t.id, {
    name: t.name, academic_year_label: t.academic_year?.label ?? null, start_date: t.start_date,
  }]));

  const marksByStudent = {};
  allMarks.forEach(m => {
    if (!marksByStudent[m.student_id]) marksByStudent[m.student_id] = [];
    marksByStudent[m.student_id].push(m);
  });

  let generated = 0;
  try {
    await req.db.$transaction(async (tx) => {
      for (const student of students) {
        const studentMarks = marksByStudent[student.id] || [];
        const { byTerm, cumulative } = buildTranscript(studentMarks, creditHoursBySubjectId, termsById, scheme.pointsFor);
        const rows = byTerm.flatMap(t => t.courses);

        const existing = await tx.transcript.findUnique({ where: { student_id: student.id } });
        let transcriptId;
        const shared = {
          student_name: `${student.first_name} ${student.last_name}`,
          student_number: student.student_number,
          class_name: student.class_name, grade_level_name: student.grade_level_name,
          cumulative_gpa: cumulative.gpa, total_credit_hours: cumulative.totalCreditHours,
          total_quality_points: cumulative.totalQualityPoints, terms_included: byTerm.length,
          generated_at: new Date(),
        };
        if (existing) {
          transcriptId = existing.id;
          await tx.transcript.update({ where: { id: transcriptId }, data: { ...shared, updated_at: new Date() } });
        } else {
          transcriptId = uuid();
          await tx.transcript.create({ data: { id: transcriptId, student_id: student.id, status: 'draft', ...shared } });
        }

        await tx.transcriptEntry.deleteMany({ where: { transcript_id: transcriptId } });
        if (rows.length > 0) {
          await tx.transcriptEntry.createMany({
            data: rows.map(r => ({
              id: uuid(), transcript_id: transcriptId,
              term_id: r.term_id, term_name: termsById[r.term_id]?.name || null,
              academic_year: termsById[r.term_id]?.academic_year_label || null,
              subject_id: r.subject_id, subject_name: r.subject_name,
              ca_score: r.ca_score, exam_score: r.exam_score, total_score: r.total_score,
              credit_hours: r.credit_hours, grade: r.grade || null, grade_points: r.grade_points,
              remark: r.remark || null,
            })),
          });
        }
        generated++;
      }
    });
  } catch (err) {
    console.error('[generate transcripts]', err.message);
    return res.status(500).json({ error: err.message });
  }

  res.status(201).json({ generated });
});

// GET /api/transcripts?classId=c4&studentId=st6&status=published
router.get('/', authenticate, async (req, res) => {
  const { classId, studentId, status } = req.query;
  const where = {};
  if (classId) where.student = { class_id: classId };
  if (studentId) where.student_id = studentId;
  if (status) where.status = status;
  try {
    const rows = await req.db.transcript.findMany({
      where, include: ENTRIES_INCLUDE,
      orderBy: [{ student_name: 'asc' }],
    });
    res.json(rows);
  } catch (err) {
    console.error('[GET /transcripts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transcripts/:id
router.get('/:id', authenticate, async (req, res) => {
  const row = await req.db.transcript.findUnique({ where: { id: req.params.id }, include: ENTRIES_INCLUDE });
  if (!row) return res.status(404).json({ error: 'Transcript not found' });
  res.json(row);
});

// Looks up the current credit hours for each subject referenced by a set of
// client-supplied entries (never trust a client-supplied credit-hours value).
async function creditHoursFor(db, entries) {
  if (entries.length === 0) return {};
  const subjectIds = [...new Set(entries.map(e => e.subjectId))];
  const rows = await db.subject.findMany({ where: { id: { in: subjectIds } } });
  return Object.fromEntries(rows.map(s => [s.id, s.credit_hours]));
}

// POST /api/transcripts — manual create (edge cases outside the batch-generate flow)
router.post('/', authenticate, async (req, res) => {
  const { studentId, entries = [] } = req.body;
  if (!studentId) return res.status(422).json({ error: 'studentId required' });

  const student = await req.db.student.findUnique({ where: { id: studentId } });
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const creditHoursById = await creditHoursFor(req.db, entries);
  const rows = entries.map(e => ({
    credit_hours: creditHoursById[e.subjectId] ?? 3,
    grade_points: e.gradePoints ?? pointsForGrade(e.grade),
  }));
  const { gpa, totalCreditHours, totalQualityPoints } = computeGpa(rows);

  const id = uuid();
  try {
    await req.db.transcript.create({
      data: {
        id, student_id: studentId, student_name: `${student.first_name} ${student.last_name}`,
        student_number: student.student_number, class_name: student.class_name, grade_level_name: student.grade_level_name,
        cumulative_gpa: gpa, total_credit_hours: totalCreditHours, total_quality_points: totalQualityPoints,
        terms_included: new Set(entries.map(e => e.termId)).size, status: 'draft', generated_at: new Date(),
      },
    });

    if (entries.length > 0) {
      await req.db.transcriptEntry.createMany({
        data: entries.map(e => ({
          id: uuid(), transcript_id: id, term_id: e.termId, term_name: e.termName || null, academic_year: e.academicYear || null,
          subject_id: e.subjectId, subject_name: e.subjectName || null,
          ca_score: e.caScore || 0, exam_score: e.examScore || 0, total_score: e.totalScore || 0,
          credit_hours: creditHoursById[e.subjectId] ?? 3,
          grade: e.grade || null, grade_points: e.gradePoints ?? pointsForGrade(e.grade), remark: e.remark || null,
        })),
      });
    }
  } catch (err) {
    console.error('[POST /transcripts]', err.message);
    return res.status(500).json({ error: err.message });
  }

  const created = await req.db.transcript.findUnique({ where: { id }, include: ENTRIES_INCLUDE });
  res.status(201).json(created);
});

// PUT /api/transcripts/:id
router.put('/:id', authenticate, async (req, res) => {
  const { status, entries } = req.body;
  try {
    const creditHoursById = Array.isArray(entries) ? await creditHoursFor(req.db, entries) : {};
    const rollup = Array.isArray(entries)
      ? computeGpa(entries.map(e => ({
          credit_hours: creditHoursById[e.subjectId] ?? 3,
          grade_points: e.gradePoints ?? pointsForGrade(e.grade),
        })))
      : null;

    await req.db.transcript.update({
      where: { id: req.params.id },
      data: {
        status: status || 'draft', updated_at: new Date(),
        ...(rollup && {
          cumulative_gpa: rollup.gpa, total_credit_hours: rollup.totalCreditHours, total_quality_points: rollup.totalQualityPoints,
          terms_included: new Set(entries.map(e => e.termId)).size,
        }),
      },
    });

    if (Array.isArray(entries)) {
      await req.db.transcriptEntry.deleteMany({ where: { transcript_id: req.params.id } });
      if (entries.length > 0) {
        await req.db.transcriptEntry.createMany({
          data: entries.map(e => ({
            id: uuid(), transcript_id: req.params.id, term_id: e.termId, term_name: e.termName || null, academic_year: e.academicYear || null,
            subject_id: e.subjectId, subject_name: e.subjectName || null,
            ca_score: e.caScore || 0, exam_score: e.examScore || 0, total_score: e.totalScore || 0,
            credit_hours: creditHoursById[e.subjectId] ?? 3,
            grade: e.grade || null, grade_points: e.gradePoints ?? pointsForGrade(e.grade), remark: e.remark || null,
          })),
        });
      }
    }
  } catch (err) {
    console.error('[PUT /transcripts]', err.message);
    return res.status(500).json({ error: err.message });
  }

  const updated = await req.db.transcript.findUnique({ where: { id: req.params.id }, include: ENTRIES_INCLUDE });
  res.json(updated);
});

// PATCH /api/transcripts/:id/status
router.patch('/:id/status', authenticate, async (req, res) => {
  const { status } = req.body;
  const valid = ['draft', 'finalized', 'published', 'printed'];
  if (!valid.includes(status)) return res.status(422).json({ error: `status must be one of: ${valid.join(', ')}` });
  const updated = await req.db.transcript.update({ where: { id: req.params.id }, data: { status, updated_at: new Date() } });
  res.json(updated);
});

module.exports = router;
