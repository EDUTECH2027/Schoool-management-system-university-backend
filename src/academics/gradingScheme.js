// Configurable grading. The university's rules live in the database (grading_schemes + grade_bands);
// nothing about weights, pass mark, letter bands or grade points is assumed here beyond a built-in
// FALLBACK that reproduces the rules this platform used before they became configurable
// (CA 40 % / exam 60 %, pass 50, A+…F on a 4-point scale) so a school with no scheme behaves as before.
//
//   const scheme = await getScheme(db);
//   scheme.totalFor(ca, exam)  → rounded weighted total
//   scheme.gradeFor(total)     → { grade, remark, points, is_pass }
//   scheme.pointsFor('B')      → grade points
//   scheme.passed(total)       → boolean

const FALLBACK = {
  id: null, name: 'Built-in default', ca_weight: 40, exam_weight: 60, pass_mark: 50, resit_cap: null,
  bands: [
    { min_score: 90, grade: 'A+', points: 4, remark: 'Excellent', is_pass: true },
    { min_score: 80, grade: 'A', points: 4, remark: 'Very Good', is_pass: true },
    { min_score: 70, grade: 'B', points: 3, remark: 'Good', is_pass: true },
    { min_score: 60, grade: 'C', points: 2, remark: 'Average', is_pass: true },
    { min_score: 50, grade: 'D', points: 1, remark: 'Below Average', is_pass: true },
    { min_score: 0, grade: 'F', points: 0, remark: 'Fail', is_pass: false },
  ],
};

const clampScore = n => Math.min(100, Math.max(0, Number(n) || 0));

function build(raw) {
  const bands = [...raw.bands].sort((a, b) => b.min_score - a.min_score);
  const caW = Number(raw.ca_weight), exW = Number(raw.exam_weight);
  const sum = caW + exW > 0 ? caW + exW : 100;
  const byGrade = Object.fromEntries(bands.map(b => [b.grade, b]));
  const lowest = bands[bands.length - 1];
  const scheme = {
    id: raw.id, name: raw.name, ca_weight: caW, exam_weight: exW, pass_mark: Number(raw.pass_mark), resit_cap: raw.resit_cap ?? null, bands,
    totalFor: (ca, exam) => Math.round((clampScore(ca) * caW + clampScore(exam) * exW) / sum),
    bandFor: score => bands.find(b => score >= b.min_score) ?? lowest,
    gradeFor(score) { const b = scheme.bandFor(score); return { grade: b.grade, remark: b.remark ?? '', points: b.points, is_pass: b.is_pass }; },
    pointsFor: grade => byGrade[grade]?.points ?? 0,
    passed: total => Number(total) >= Number(raw.pass_mark),
    // A course counts as passed on the first sit, or on the resit if that cleared the pass mark.
    markPassed: m => scheme.passed(m.total_score) || (m.resit_score != null && scheme.passed(scheme.resitTotal(m.resit_score))),
    resitTotal: score => (raw.resit_cap != null ? Math.min(clampScore(score), Number(raw.resit_cap)) : clampScore(score)),
  };
  return scheme;
}

const cache = new WeakMap();   // PrismaClient (one per school) → { scheme, at }
const TTL_MS = 30_000;

async function getScheme(db) {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.scheme;
  const row = await db.gradingScheme.findFirst({ where: { is_active: true }, include: { bands: true } });
  const scheme = build(row && row.bands.length ? row : FALLBACK);
  cache.set(db, { scheme, at: Date.now() });
  return scheme;
}
const invalidate = db => cache.delete(db);

module.exports = { getScheme, invalidate, clampScore, FALLBACK, build };
