// Gradebook & continuous-assessment (CA) maths.
//
// POLICY (documented in docs/ASSESSMENTS.md and covered by tests):
//   • Only PUBLISHED or CLOSED assessments are columns (drafts never count).
//   • An item COUNTS for a student only when it is graded: a graded/returned assignment, or at least one finished quiz
//     attempt (best attempt = highest percentage). Submitted-but-not-yet-graded work is 'pending', no submission is 'missing'.
//   • CA (0–100) = Σ(pct_i × weight_i) / Σ(weight_i)   over the student's COUNTED items only, rounded to 2 decimals.
//     Missing/pending items are NOT treated as zero; they are reported (counted/pending/missing) so the lecturer can decide
//     before exporting. A student with no counted item has CA = null and is never exported.
const { v4: uuid } = require('uuid');
const { AErr, round2, sName } = require('./common');
const { getScheme } = require('../academics/gradingScheme');
const { saveMark, ResultsError, LOCKED } = require('../academics/results');
const { audit } = require('../academics/registration');

async function build(db, offeringId, { onlyStudentId } = {}) {
  const [assignments, quizzes, enr] = await Promise.all([
    db.assignment.findMany({ where: { offering_id: offeringId, status: { in: ['published', 'closed'] } }, orderBy: { created_at: 'asc' } }),
    db.quiz.findMany({ where: { offering_id: offeringId, status: { in: ['published', 'closed'] } }, orderBy: { created_at: 'asc' } }),
    db.courseEnrollment.findMany({ where: { offering_id: offeringId, status: 'registered', ...(onlyStudentId && { student_id: onlyStudentId }) }, include: { student: true }, orderBy: [{ student: { last_name: 'asc' } }, { student: { first_name: 'asc' } }] }),
  ]);
  const ids = enr.map(e => e.student_id);
  const [subs, atts] = await Promise.all([
    assignments.length && ids.length ? db.assignmentSubmission.findMany({ where: { assignment_id: { in: assignments.map(a => a.id) }, student_id: { in: ids } }, select: { assignment_id: true, student_id: true, status: true, score: true, is_late: true } }) : [],
    quizzes.length && ids.length ? db.quizAttempt.findMany({ where: { quiz_id: { in: quizzes.map(q => q.id) }, student_id: { in: ids }, status: { not: 'in_progress' } }, select: { quiz_id: true, student_id: true, score: true, max_score: true } }) : [],
  ]);
  const subBy = new Map(subs.map(s => [`${s.assignment_id}:${s.student_id}`, s]));
  const bestBy = new Map();
  for (const a of atts) {
    if (!(a.max_score > 0)) continue;
    const k = `${a.quiz_id}:${a.student_id}`, pct = a.score / a.max_score;
    const cur = bestBy.get(k);
    if (!cur || pct > cur.score / cur.max_score) bestBy.set(k, a);
  }
  const columns = [
    ...assignments.map(a => ({ key: `a:${a.id}`, kind: 'assignment', id: a.id, title: a.title, max_score: a.max_score, weight: a.weight, status: a.status, due_at: a.due_at })),
    ...quizzes.map(q => ({ key: `q:${q.id}`, kind: 'quiz', id: q.id, title: q.title, max_score: null, weight: q.weight, status: q.status, due_at: q.closes_at })),
  ];
  const rows = enr.map(e => {
    const items = {}; let num = 0, den = 0, counted = 0, pending = 0, missing = 0;
    for (const c of columns) {
      let it;
      if (c.kind === 'assignment') {
        const s = subBy.get(`${c.id}:${e.student_id}`);
        if (!s) it = { state: 'missing' };
        else if ((s.status === 'graded' || s.status === 'returned') && s.score != null) it = { state: 'graded', score: s.score, max: c.max_score, pct: round2(s.score / c.max_score * 100), late: s.is_late };
        else it = { state: 'pending', late: s.is_late };
      } else {
        const b = bestBy.get(`${c.id}:${e.student_id}`);
        it = b ? { state: 'graded', score: b.score, max: b.max_score, pct: round2(b.score / b.max_score * 100) } : { state: 'missing' };
      }
      items[c.key] = it;
      if (it.state === 'graded') { num += it.pct * c.weight; den += c.weight; counted++; } else if (it.state === 'pending') pending++; else missing++;
    }
    return { student_id: e.student_id, name: sName(e.student), matricule: e.student.student_number, items, ca: { value: den > 0 ? round2(num / den) : null, counted, pending, missing, total: columns.length } };
  });
  for (const c of columns) if (c.kind === 'quiz') { const any = [...bestBy.entries()].find(([k]) => k.startsWith(`${c.id}:`)); c.max_score = any ? any[1].max_score : null; }
  return { columns, students: rows };
}

/** Preview (dry) or perform the export of CA into draft marks. Caller has already checked who may do it. */
async function exportCA(db, offering, user, actor, { dry, studentIds }) {
  const { students } = await build(db, offering.id);
  const wanted = Array.isArray(studentIds) ? new Set(studentIds) : null;
  const marks = await db.mark.findMany({ where: { subject_id: offering.subject_id, term_id: offering.term_id, student_id: { in: students.map(s => s.student_id) } } });
  const markBy = new Map(marks.map(m => [m.student_id, m]));
  const scheme = await getScheme(db);
  const subject = await db.subject.findUnique({ where: { id: offering.subject_id }, select: { name: true } });
  const stu = Object.fromEntries((await db.student.findMany({ where: { id: { in: students.map(s => s.student_id) } } })).map(s => [s.id, s]));
  const plan = students.map(s => {
    const m = markBy.get(s.student_id);
    const base = { student_id: s.student_id, name: s.name, matricule: s.matricule, ca: s.ca.value, counted: s.ca.counted, missing: s.ca.missing, pending: s.ca.pending, current: m ? { ca_score: m.ca_score, exam_score: m.exam_score, status: m.status } : null };
    if (wanted && !wanted.has(s.student_id)) return { ...base, action: 'skip', reason: 'not_selected' };
    if (s.ca.value === null) return { ...base, action: 'skip', reason: 'no_graded_items' };
    if (m && LOCKED.has(m.status)) return { ...base, action: 'skip', reason: 'locked', locked_status: m.status };
    return { ...base, action: 'write', after: { ca_score: s.ca.value, exam_score: m?.exam_score ?? 0 } };
  });
  if (dry) return { dry_run: true, will_write: plan.filter(p => p.action === 'write').length, skipped: plan.filter(p => p.action === 'skip').length, students: plan };
  let written = 0;
  for (const p of plan) {
    if (p.action !== 'write') continue;
    const m = markBy.get(p.student_id), st = stu[p.student_id];
    try {
      // saveMark keeps drafts as drafts for a lecturer; the existing exam score/absence/resit are passed back unchanged.
      const r = await saveMark(db, scheme, {
        studentId: p.student_id, subjectId: offering.subject_id, termId: offering.term_id, classId: st.class_id, offeringId: offering.id,
        studentName: sName(st), studentNumber: st.student_number, subjectName: subject?.name,
        caScore: p.ca, examScore: m?.exam_score ?? 0, examAbsent: m?.exam_absent ?? false, resitScore: m?.resit_score ?? null,
      }, user, { reason: 'Continuous assessment exported from the gradebook' });
      p.action = r.changed ? 'written' : 'unchanged'; if (r.changed) written++;
    } catch (e) {
      if (!(e instanceof ResultsError)) throw e;
      p.action = 'skip'; p.reason = e.code === 'locked' ? 'locked' : 'error'; p.error = e.message;
    }
  }
  await audit(db, actor, 'assessments.export_ca', 'course_offering', offering.id, { after: { written, skipped: plan.filter(p => p.action === 'skip').map(p => ({ student_id: p.student_id, reason: p.reason })) } });
  return { dry_run: false, written, unchanged: plan.filter(p => p.action === 'unchanged').length, skipped: plan.filter(p => p.action === 'skip').length, students: plan };
}

module.exports = { build, exportCA, uuid, AErr };
