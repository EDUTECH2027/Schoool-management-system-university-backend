// Builds a student matricule from the school's configured nomenclature
// (Settings → Matricule Format), instead of a hardcoded template — see
// prisma/tenant/migrations/20260904165455_add_matricule_nomenclature.
// `school` may be null/partial; every field falls back to the same defaults
// the DB column defaults use, so callers never need to null-check first.
function buildMatricule(school, seq) {
  const prefix      = school?.matricule_prefix || 'BSPS';
  const includeYear = school?.matricule_include_year ?? true;
  const digits      = Math.min(6, Math.max(1, Number(school?.matricule_digits) || 3));
  const separator   = school?.matricule_separator ?? '-';

  const parts = [prefix];
  if (includeYear) parts.push(String(new Date().getFullYear()));
  parts.push(String(seq).padStart(digits, '0'));
  return parts.join(separator);
}

// Derives a student's synthetic portal-login email from their matricule. Strips
// everything but letters/digits (not just '-') so login stays forgiving no matter
// which separator a school's nomenclature (Settings) uses — e.g. "ZTEST_07",
// "ZTEST-07" and "ztest07" must all resolve to the same stored login. Every call
// site that reads or writes this email (routes/auth.js, routes/students.js,
// routes/migrate.js) must go through this function so they never drift apart.
function loginEmailFor(studentNumber) {
  return `${String(studentNumber).toLowerCase().replace(/[^a-z0-9]/g, '')}@school.local`;
}

module.exports = { buildMatricule, loginEmailFor };
