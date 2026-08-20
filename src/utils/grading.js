// Single source of truth for turning a CA/exam pair into a total score and
// letter grade — shared by the admin marks route and the teacher portal's
// own marks route, so a score submitted through either always grades the
// same way.

const gradeFor = (score) => {
  if (score >= 90) return { grade: 'A+', remark: 'Excellent' };
  if (score >= 80) return { grade: 'A',  remark: 'Very Good' };
  if (score >= 70) return { grade: 'B',  remark: 'Good' };
  if (score >= 60) return { grade: 'C',  remark: 'Average' };
  if (score >= 50) return { grade: 'D',  remark: 'Below Average' };
  return { grade: 'F', remark: 'Fail' };
};

// A score field is always 0-100 — clamp rather than trust the caller, since
// this runs on every write path (bulk save, single edit, teacher portal) and
// the client-side input clamp is only a UX nicety, not a guarantee.
const clampScore = (score) => Math.min(100, Math.max(0, Number(score) || 0));

// CA is worth 40% of the total, the exam 60% (both entered out of 100).
const totalFor = (caScore, examScore) => Math.round(clampScore(caScore) * 0.4 + clampScore(examScore) * 0.6);

module.exports = { gradeFor, totalFor, clampScore };
