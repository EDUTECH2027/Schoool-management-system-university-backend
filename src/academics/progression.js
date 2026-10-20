// Configurable academic progression. The thresholds live in academic_settings.progression (edited by the
// university); `defaults()` are only the starting values. Decisions are computed from PUBLISHED results,
// stored as proposals, and only take effect when a reviewer approves and applies them.
const { v4: uuid } = require('uuid');
const { getScheme } = require('./gradingScheme');

const defaults = () => ({
  promote_min_gpa: 2.0,           // year GPA needed to be promoted
  max_carryover_courses: 2,       // failed courses a student may carry into the next level
  probation_gpa_below: 1.5,       // year GPA under this → academic probation
  graduation_min_gpa: 2.0,        // cumulative GPA needed to graduate
  graduation_max_outstanding: 0,  // failed/unpassed courses allowed at graduation
  resit_min_total: 40,            // a failed course with a total ≥ this is resit-eligible
});

function validate(input) {
  if (input === null) return { value: null };
  if (typeof input !== 'object') return { error: 'progression must be an object' };
  const d = defaults(), out = {};
  for (const k of Object.keys(d)) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < 0) return { error: `${k} must be a non-negative number` };
    if (/gpa|below/.test(k) && n > 10) return { error: `${k} looks too large for a GPA` };
    if (k === 'resit_min_total' && n > 100) return { error: 'resit_min_total must be 0–100' };
    out[k] = n;
  }
  const unknown = Object.keys(input).filter(k => !(k in d));
  if (unknown.length) return { error: `Unknown rule(s): ${unknown.join(', ')}` };
  return { value: out };
}

const round2 = n => Math.round(n * 100) / 100;

/** Pure decision from metrics + rules. Returns { outcome, reasons[] }. */
function decide(metrics, rules, { isFinalLevel, creditsRequired }) {
  const reasons = [];
  if (isFinalLevel) {
    const credOk = creditsRequired == null || metrics.cumulative_earned >= creditsRequired;
    const gpaOk = metrics.cumulative_gpa >= rules.graduation_min_gpa;
    const outOk = metrics.outstanding_courses <= rules.graduation_max_outstanding;
    if (credOk && gpaOk && outOk) return { outcome: 'eligible_graduation', reasons: ['All graduation requirements are met.'] };
    if (!credOk) reasons.push(`Needs ${creditsRequired} credits; has ${metrics.cumulative_earned}.`);
    if (!gpaOk) reasons.push(`Cumulative GPA ${metrics.cumulative_gpa} is below ${rules.graduation_min_gpa}.`);
    if (!outOk) reasons.push(`${metrics.outstanding_courses} course(s) not yet passed (maximum ${rules.graduation_max_outstanding}).`);
  }
  if (metrics.attempted_credits === 0) return { outcome: 'repeat', reasons: ['No published results for this year.'] };
  if (metrics.year_gpa < rules.probation_gpa_below) return { outcome: 'probation', reasons: [...reasons, `Year GPA ${metrics.year_gpa} is below ${rules.probation_gpa_below}.`] };
  if (isFinalLevel) return { outcome: metrics.outstanding_courses > 0 ? 'carryover' : 'repeat', reasons: reasons.length ? reasons : ['Final-level requirements not met.'] };
  if (metrics.year_gpa >= rules.promote_min_gpa && metrics.failed_courses === 0) return { outcome: 'promoted', reasons: ['All courses passed.'] };
  if (metrics.year_gpa >= rules.promote_min_gpa && metrics.outstanding_courses <= rules.max_carryover_courses) return { outcome: 'carryover', reasons: [`Promoted with ${metrics.outstanding_courses} course(s) to carry over (maximum ${rules.max_carryover_courses}).`] };
  return { outcome: 'repeat', reasons: [metrics.year_gpa < rules.promote_min_gpa ? `Year GPA ${metrics.year_gpa} is below ${rules.promote_min_gpa}.` : `${metrics.outstanding_courses} course(s) to carry over exceeds ${rules.max_carryover_courses}.`] };
}

async function loadRules(db) {
  const row = await db.academicSettings.findUnique({ where: { id: 'main' } });
  return { ...defaults(), ...(row?.progression ?? {}) };
}

/** Compute proposals for every active student in scope. Never overwrites an approved/applied decision. */
async function run(db, { academicYearId, programmeId, classId }) {
  const year = await db.academicYear.findUnique({ where: { id: academicYearId }, include: { terms: true } });
  if (!year) return { error: 'Unknown academic year', status: 404 };
  const [rules, scheme] = await Promise.all([loadRules(db), getScheme(db)]);
  const where = { is_active: true, academic_status: 'active', class_id: { not: null }, ...(classId && { class_id: classId }), ...(programmeId && { class: { programme_id: programmeId } }) };
  const students = await db.student.findMany({ where, include: { class: { include: { grade_level: true, programme: true } } } });
  const marks = await db.mark.findMany({ where: { student_id: { in: students.map(s => s.id) }, status: 'published' } });
  const subjects = await db.subject.findMany({ where: { id: { in: [...new Set(marks.map(m => m.subject_id))] } } });
  const credit = Object.fromEntries(subjects.map(s => [s.id, s.credit_hours]));
  const termIds = new Set(year.terms.map(t => t.id));
  const existing = await db.progressionDecision.findMany({ where: { academic_year_id: year.id, student_id: { in: students.map(s => s.id) } } });
  const exBy = Object.fromEntries(existing.map(e => [e.student_id, e]));
  const counts = { proposed: 0, skipped: 0 }; const results = [];
  for (const s of students) {
    const mine = marks.filter(m => m.student_id === s.id);
    const yearMarks = mine.filter(m => termIds.has(m.term_id));
    const passedAnywhere = new Set(mine.filter(m => scheme.markPassed(m)).map(m => m.subject_id));
    const attempted = yearMarks.reduce((x, m) => x + (credit[m.subject_id] ?? 0), 0);
    const quality = yearMarks.reduce((x, m) => x + scheme.pointsFor(m.grade) * (credit[m.subject_id] ?? 0), 0);
    const failedSubjects = new Set(yearMarks.filter(m => !scheme.markPassed(m)).map(m => m.subject_id));
    const allAttempted = mine.reduce((x, m) => x + (credit[m.subject_id] ?? 0), 0), allQuality = mine.reduce((x, m) => x + scheme.pointsFor(m.grade) * (credit[m.subject_id] ?? 0), 0);
    const earnedSubjects = new Set(mine.filter(m => scheme.markPassed(m)).map(m => m.subject_id));
    const metrics = {
      attempted_credits: round2(attempted), earned_credits: round2(yearMarks.filter(m => scheme.markPassed(m)).reduce((x, m) => x + (credit[m.subject_id] ?? 0), 0)),
      year_gpa: attempted ? round2(quality / attempted) : 0, failed_courses: failedSubjects.size,
      outstanding_courses: [...failedSubjects].filter(id => !passedAnywhere.has(id)).length,
      cumulative_gpa: allAttempted ? round2(allQuality / allAttempted) : 0, cumulative_earned: round2([...earnedSubjects].reduce((x, id) => x + (credit[id] ?? 0), 0)),
      resit_eligible: yearMarks.filter(m => !scheme.markPassed(m) && m.total_score >= rules.resit_min_total).length,
    };
    const prog = s.class?.programme;
    const level = s.class?.grade_level;
    const isFinalLevel = !!(prog && level && level.sort_order >= prog.duration_years);
    const { outcome, reasons } = decide(metrics, rules, { isFinalLevel, creditsRequired: prog?.credits_required ?? null });
    const ex = exBy[s.id];
    if (ex && ['approved', 'applied'].includes(ex.status)) { counts.skipped++; continue; }
    const data = { programme_id: s.class?.programme_id ?? null, level_id: s.class?.grade_level_id ?? null, outcome, metrics: { ...metrics, reasons, is_final_level: isFinalLevel }, status: 'proposed', decided_by: null, decided_at: null, note: null, target_class_id: null };
    const row = ex ? await db.progressionDecision.update({ where: { id: ex.id }, data }) : await db.progressionDecision.create({ data: { id: uuid(), student_id: s.id, academic_year_id: year.id, ...data } });
    counts.proposed++; results.push(row);
  }
  return { counts, rules };
}

module.exports = { defaults, validate, decide, run, loadRules };
