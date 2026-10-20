// Official documents are built ONLY from validated data (published marks, active registrations) and stored as an
// immutable snapshot with a public verification code, so a printed document can be checked years later even if
// the live data changes.
const crypto = require('crypto');
const { getScheme } = require('./gradingScheme');
const { buildTranscript } = require('../utils/transcriptMath');
const { loadStudent, studentView, overview } = require('./registration');

const TYPES = ['transcript', 'statement_of_results', 'enrolment_certificate', 'registration_summary'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// UMS-<first 8 hex of the school id>-<8 random chars>: the prefix lets the public verifier find the right school.
function newCode(schoolId) {
  const prefix = String(schoolId).replace(/-/g, '').slice(0, 8).toUpperCase();
  let s = ''; for (const b of crypto.randomBytes(8)) s += ALPHABET[b % ALPHABET.length];
  return `UMS-${prefix}-${s}`;
}
const parseCode = code => { const m = /^UMS-([0-9A-F]{8})-([A-HJ-NP-Z2-9]{8})$/.exec(String(code || '').toUpperCase()); return m ? { prefix: m[1].toLowerCase(), code: m[0] } : null; };

async function publishedMarkRows(db, studentId, scheme, filter = {}) {
  const marks = await db.mark.findMany({ where: { student_id: studentId, status: 'published', ...filter } });
  const [subjects, terms] = await Promise.all([
    db.subject.findMany({ where: { id: { in: [...new Set(marks.map(m => m.subject_id))] } } }),
    db.term.findMany({ where: { id: { in: [...new Set(marks.map(m => m.term_id))] } }, include: { academic_year: true } }),
  ]);
  const credit = Object.fromEntries(subjects.map(s => [s.id, s.credit_hours])), code = Object.fromEntries(subjects.map(s => [s.id, s.code])), name = Object.fromEntries(subjects.map(s => [s.id, s.name]));
  const termsById = Object.fromEntries(terms.map(t => [t.id, { name: t.name, academic_year_label: t.academic_year?.label ?? null, start_date: t.start_date }]));
  const { byTerm, cumulative } = buildTranscript(marks, credit, termsById, scheme.pointsFor);
  return {
    terms: byTerm.map(t => ({ term: t.termName, academic_year: t.academicYear, gpa: t.termGpa, credits: t.termCreditHours, courses: t.courses.map(c => ({ code: code[c.subject_id], course: name[c.subject_id] ?? c.subject_name, credits: c.credit_hours, ca: c.ca_score, exam: c.exam_score, total: c.total_score, grade: c.grade, points: c.grade_points, passed: scheme.markPassed(c), resit: c.resit_score != null ? { score: c.resit_score, grade: c.resit_grade } : null })) })),
    cumulative: { gpa: cumulative.gpa, credits: cumulative.totalCreditHours, courses: cumulative.courseCount },
    earned_credits: byTerm.flatMap(t => t.courses).filter((c, i, a) => scheme.markPassed(c) && a.findIndex(x => x.subject_id === c.subject_id && scheme.markPassed(x)) === i).reduce((x, c) => x + c.credit_hours, 0),
  };
}

async function buildPayload(db, type, student, { termId, academicYearId } = {}) {
  const [scheme, school] = await Promise.all([getScheme(db), db.school.findFirst()]);
  const base = { school: { name: school?.name ?? '', address: school?.address ?? null, phone: school?.phone ?? null, email: school?.email ?? null }, student: studentView(student) };
  if (type === 'transcript') {
    const r = await publishedMarkRows(db, student.id, scheme);
    if (!r.terms.length) return { error: 'This student has no published results yet.' };
    return { ...base, ...r, grading: { pass_mark: scheme.pass_mark, bands: scheme.bands.map(b => ({ grade: b.grade, min: b.min_score, points: b.points })) } };
  }
  if (type === 'statement_of_results') {
    if (!termId && !academicYearId) return { error: 'Choose a semester or an academic year.' };
    let termIds = [];
    if (termId) termIds = [termId]; else termIds = (await db.term.findMany({ where: { academic_year_id: academicYearId }, select: { id: true } })).map(t => t.id);
    const r = await publishedMarkRows(db, student.id, scheme, { term_id: { in: termIds } });
    if (!r.terms.length) return { error: 'No published results for that period.' };
    return { ...base, ...r, grading: { pass_mark: scheme.pass_mark } };
  }
  if (type === 'enrolment_certificate') {
    if (!student.is_active || student.academic_status !== 'active') return { error: `A certificate of enrolment cannot be issued: the student is ${student.academic_status}.` };
    const year = academicYearId ? await db.academicYear.findUnique({ where: { id: academicYearId } }) : await db.academicYear.findFirst({ where: { is_current: true } });
    return { ...base, academic_year: year?.label ?? null, admission_date: student.admission_date ?? null, certifies: 'is regularly enrolled' };
  }
  if (type === 'registration_summary') {
    if (!termId) return { error: 'Choose a semester.' };
    const o = await overview(db, student, termId);
    return { ...base, term: o.term, courses: o.registered.filter(r => r.status === 'registered'), credits: o.credits };
  }
  return { error: 'Unknown document type' };
}

module.exports = { TYPES, newCode, parseCode, buildPayload, publishedMarkRows, loadStudent };
