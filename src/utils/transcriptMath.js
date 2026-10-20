// Single source of truth for GPA math, shared by the transcript-generation
// route and the always-live portal GPA-summary endpoints. Operates on plain
// data (marks + a credit-hours lookup), not Prisma models directly, so the
// same functions work whether the caller is about to persist the result
// (generate route) or just wants a live number for a dashboard widget.
//
// GPA = Σ(grade_points × credit_hours) / Σ(credit_hours)

// Mirrors the letter grades gradeFor() in routes/marks.js produces (A+, A, B,
// C, D, F) — that computation is untouched; this is a points layer on top.
const { getScheme } = require('../academics/gradingScheme');
const GRADE_POINTS = { 'A+': 4.0, 'A': 4.0, 'B': 3.0, 'C': 2.0, 'D': 1.0, 'F': 0.0 };
function pointsForGrade(grade) {
  return GRADE_POINTS[grade] ?? 0;
}

const round2 = (n) => Math.round(n * 100) / 100;

// rows: [{ credit_hours, grade_points }]
function computeGpa(rows) {
  const totalCreditHours = rows.reduce((sum, r) => sum + r.credit_hours, 0);
  if (totalCreditHours <= 0) return { gpa: 0, totalCreditHours: 0, totalQualityPoints: 0 };
  const totalQualityPoints = rows.reduce((sum, r) => sum + r.grade_points * r.credit_hours, 0);
  return {
    gpa: round2(totalQualityPoints / totalCreditHours),
    totalCreditHours: round2(totalCreditHours),
    totalQualityPoints: round2(totalQualityPoints),
  };
}

// marks: raw Mark rows for one student, any number of terms/years.
// creditHoursBySubjectId: { [subjectId]: number } — current Subject.credit_hours.
// termsById: { [termId]: { name, academic_year_label, start_date } } — built by
// the caller (joining Term + AcademicYear); not a schema shape.
function buildTranscript(marks, creditHoursBySubjectId, termsById, pointsFor = pointsForGrade) {
  const rows = marks.map(m => ({
    ...m,
    credit_hours: creditHoursBySubjectId[m.subject_id] ?? 3,
    grade_points: pointsFor(m.grade),
  }));

  const groups = new Map();
  rows.forEach(r => {
    if (!groups.has(r.term_id)) groups.set(r.term_id, []);
    groups.get(r.term_id).push(r);
  });

  const byTerm = [...groups.entries()]
    .map(([termId, termRows]) => {
      const term = termsById[termId] || {};
      const { gpa, totalCreditHours, totalQualityPoints } = computeGpa(termRows);
      return {
        termId,
        termName: term.name ?? null,
        academicYear: term.academic_year_label ?? null,
        startDate: term.start_date ?? '',
        courses: termRows,
        termGpa: gpa,
        termCreditHours: totalCreditHours,
        termQualityPoints: totalQualityPoints,
      };
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const cumulative = { ...computeGpa(rows), courseCount: rows.length };
  return { byTerm, cumulative };
}

// Live (never-persisted) GPA summary for a student, computed directly from
// current Marks + current Subject.credit_hours — used by the portal
// dashboard widgets so they're never stale even if no Transcript has been
// generated/published yet.
async function getLiveGpaSummary(db, { studentId }) {
  // Only PUBLISHED marks count: a draft or unapproved mark must never move someone's GPA.
  const marks = await db.mark.findMany({ where: { student_id: studentId, status: 'published' } });
  const scheme = await getScheme(db);
  if (marks.length === 0) return { byTerm: [], cumulative: { gpa: 0, totalCreditHours: 0, totalQualityPoints: 0, courseCount: 0 } };

  const subjectIds = [...new Set(marks.map(m => m.subject_id))];
  const termIds = [...new Set(marks.map(m => m.term_id))];

  const [subjects, terms] = await Promise.all([
    db.subject.findMany({ where: { id: { in: subjectIds } } }),
    db.term.findMany({ where: { id: { in: termIds } }, include: { academic_year: true } }),
  ]);

  const creditHoursBySubjectId = Object.fromEntries(subjects.map(s => [s.id, s.credit_hours]));
  const termsById = Object.fromEntries(terms.map(t => [t.id, {
    name: t.name, academic_year_label: t.academic_year?.label ?? null, start_date: t.start_date,
  }]));

  return buildTranscript(marks, creditHoursBySubjectId, termsById, scheme.pointsFor);
}

module.exports = { pointsForGrade, computeGpa, buildTranscript, getLiveGpaSummary, GRADE_POINTS };
