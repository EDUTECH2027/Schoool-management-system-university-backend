// Executive analytics: every number comes from a handful of set-based SQL aggregates (no per-student loops, no N+1).
// Academic figures use PUBLISHED marks only. Money figures come from fee_records / payments / payment_transactions.
//
// Filters (all optional): academic_year_id, term_id, programme_id.
//   term_id            → that semester; else academic_year_id → all semesters of that year; else all time.
//   programme_id       → students whose cohort (class) belongs to that programme (marks use the class recorded on the mark).
const { Prisma } = require('../../node_modules/.prisma/tenant-client');
const { getScheme } = require('../academics/gradingScheme');

const { sql, join, raw } = Prisma;
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : null);
const where = conds => { const c = conds.filter(Boolean); return c.length ? join(c, ' AND ') : sql`TRUE`; };

class FilterError extends Error { constructor(m) { super(m); this.status = 422; } }

/** Validates the filters against the database and resolves them to concrete term ids. */
async function resolveFilters(db, q) {
  const f = { academic_year_id: q.academic_year_id || null, term_id: q.term_id || null, programme_id: q.programme_id || null };
  let year = null, term = null, programme = null, termIds = null;
  if (f.term_id) {
    term = await db.term.findUnique({ where: { id: String(f.term_id) }, include: { academic_year: true } });
    if (!term) throw new FilterError('Unknown term_id');
    if (f.academic_year_id && f.academic_year_id !== term.academic_year_id) throw new FilterError('term_id does not belong to academic_year_id');
    year = term.academic_year; termIds = [term.id];
  } else if (f.academic_year_id) {
    year = await db.academicYear.findUnique({ where: { id: String(f.academic_year_id) }, include: { terms: true } });
    if (!year) throw new FilterError('Unknown academic_year_id');
    termIds = year.terms.map(t => t.id);
  }
  if (f.programme_id) {
    programme = await db.programme.findUnique({ where: { id: String(f.programme_id) } });
    if (!programme) throw new FilterError('Unknown programme_id');
  }
  let range = null;   // date range (YYYY-MM-DD strings) covered by the selected semesters
  if (termIds) {
    const terms = await db.term.findMany({ where: { id: { in: termIds } }, select: { start_date: true, end_date: true } });
    range = terms.length ? { from: terms.map(t => t.start_date).sort()[0], to: terms.map(t => t.end_date).sort().reverse()[0] } : { from: '9999-12-31', to: '0000-01-01' };
  }
  return {
    termIds, programmeId: programme?.id ?? null, yearLabel: year?.label ?? null, range,
    echo: { academic_year_id: year?.id ?? null, academic_year: year?.label ?? null, term_id: term?.id ?? null, term: term?.name ?? null, programme_id: programme?.id ?? null, programme: programme?.name ?? null },
  };
}

const termCond = (f, col) => (f.termIds ? (f.termIds.length ? sql`${raw(col)} IN (${join(f.termIds)})` : sql`FALSE`) : null);
const progCond = (f, col) => (f.programmeId ? sql`${raw(col)} = ${f.programmeId}` : null);

// ── marks ────────────────────────────────────────────────────────────────────────────────
// m = marks, sub = subjects, s = students, c = cohort the mark was earned in (falls back to the student's current cohort)
const MARK_FROM = sql`marks m JOIN subjects sub ON sub.id = m.subject_id JOIN students s ON s.id = m.student_id LEFT JOIN classes c ON c.id = COALESCE(m.class_id, s.class_id)`;
const markWhere = f => where([sql`m.status = 'published'`, termCond(f, 'm.term_id'), progCond(f, 'c.programme_id')]);
const passExpr = scheme => sql`(m.total_score >= ${scheme.pass_mark}::float8 OR (m.resit_score IS NOT NULL AND LEAST(m.resit_score, ${scheme.resit_cap ?? 1000}::float8) >= ${scheme.pass_mark}::float8))`;
const pointsCte = scheme => sql`pts(grade, points) AS (VALUES ${join(scheme.bands.map(b => sql`(${b.grade}::text, ${Number(b.points)}::float8)`))})`;

// ── academics ────────────────────────────────────────────────────────────────────────────
async function academics(db, f, opts = {}) {
  const scheme = await getScheme(db);
  const pass = passExpr(scheme), W = markWhere(f);
  const minSample = Math.min(1000, Math.max(1, parseInt(opts.min_sample, 10) || 5));
  const maxPts = Math.max(...scheme.bands.map(b => Number(b.points)), 0) || 4;
  // One scan of the marks builds a (course, semester, programme, grade) cube; every table below is rolled up from it in memory.
  const [cube, subjects, termRows, programmes, gpas, appeals, progression] = await Promise.all([
    db.$queryRaw`SELECT m.subject_id, m.term_id, c.programme_id, COALESCE(m.grade, '—') AS grade, COUNT(*)::int AS n, SUM(CASE WHEN ${pass} THEN 1 ELSE 0 END)::int AS passed, SUM(m.total_score)::float8 AS sum_score
      FROM ${MARK_FROM} WHERE ${W} GROUP BY 1, 2, 3, 4`,
    db.subject.findMany({ select: { id: true, code: true, name: true } }),
    db.term.findMany({ select: { id: true, name: true, start_date: true, academic_year: { select: { label: true } } } }),
    db.programme.findMany({ select: { id: true, name: true } }),
    db.$queryRaw`WITH ${pointsCte(scheme)}
      SELECT (SUM(COALESCE(pts.points, 0) * sub.credit_hours) / NULLIF(SUM(sub.credit_hours), 0))::float8 AS gpa
      FROM ${MARK_FROM} LEFT JOIN pts ON pts.grade = m.grade WHERE ${W} GROUP BY m.student_id HAVING SUM(sub.credit_hours) > 0`,
    db.$queryRaw`SELECT a.status, COUNT(*)::int AS n FROM grade_appeals a JOIN marks m ON m.id = a.mark_id JOIN students s ON s.id = m.student_id LEFT JOIN classes c ON c.id = COALESCE(m.class_id, s.class_id)
      WHERE ${where([termCond(f, 'm.term_id'), progCond(f, 'c.programme_id')])} GROUP BY a.status`,
    db.$queryRaw`SELECT outcome, status, COUNT(*)::int AS n FROM progression_decisions pd
      WHERE ${where([f.termIds ? sql`pd.academic_year_id IN (SELECT academic_year_id FROM terms WHERE id IN (${join(f.termIds.length ? f.termIds : ['-'])}))` : null, progCond(f, 'pd.programme_id')])} GROUP BY outcome, status`,
  ]);
  const rollup = keyOf => { const m = new Map(); for (const r of cube) { const k = keyOf(r); const a = m.get(k) ?? { n: 0, passed: 0, sum: 0 }; a.n += r.n; a.passed += r.passed; a.sum += r.sum_score; m.set(k, a); } return m; };
  const row = (a, extra) => ({ ...extra, n: a.n, passed: a.passed, avg_score: a.n ? a.sum / a.n : null });
  const subById = Object.fromEntries(subjects.map(x => [x.id, x])), termById = Object.fromEntries(termRows.map(x => [x.id, x])), progById = Object.fromEntries(programmes.map(x => [x.id, x]));
  const byCourse = [...rollup(r => r.subject_id)].map(([id, a]) => row(a, { subject_id: id, code: subById[id]?.code ?? '?', name: subById[id]?.name ?? '?' })).sort((x, y) => x.code.localeCompare(y.code)).slice(0, 1000);
  const byTerm = [...rollup(r => r.term_id)].map(([id, a]) => row(a, { term_id: id, academic_year: termById[id]?.academic_year?.label ?? null, term: termById[id]?.name ?? null, start_date: termById[id]?.start_date ?? '' })).sort((x, y) => x.start_date.localeCompare(y.start_date));
  const byProgramme = [...rollup(r => r.programme_id ?? '')].map(([id, a]) => row(a, { programme_id: id || null, programme: id ? progById[id]?.name ?? '?' : 'Unassigned' })).sort((x, y) => x.programme.localeCompare(y.programme));
  const grades = [...rollup(r => r.grade)].map(([grade, a]) => ({ grade, n: a.n }));
  const withRate = r => ({ ...r, avg_score: round1(r.avg_score), pass_rate: pct(r.passed, r.n) });
  const courses = byCourse.map(withRate);
  const ranked = courses.filter(c => c.n >= minSample);
  const hardest = [...ranked].sort((a, b) => a.pass_rate - b.pass_rate || a.avg_score - b.avg_score || a.code.localeCompare(b.code)).slice(0, 5);
  const easiest = [...ranked].sort((a, b) => b.pass_rate - a.pass_rate || b.avg_score - a.avg_score || a.code.localeCompare(b.code)).slice(0, 5);
  const order = Object.fromEntries(scheme.bands.map((b, i) => [b.grade, i]));
  const total = grades.reduce((x, g) => x + g.n, 0);
  const gradeDistribution = grades.map(g => ({ grade: g.grade, n: g.n, share: pct(g.n, total) })).sort((a, b) => (order[a.grade] ?? 99) - (order[b.grade] ?? 99));
  // GPA histogram: bins of 0.5 grade points from 0 to the scheme maximum (the last bin includes the maximum).
  const width = 0.5, nb = Math.max(1, Math.ceil(maxPts / width));
  const bins = Array.from({ length: nb }, (_, i) => ({ from: i * width, to: Math.min(maxPts, (i + 1) * width), n: 0 }));
  const values = gpas.map(g => g.gpa).filter(v => v != null).sort((a, b) => a - b);
  for (const v of values) bins[Math.min(nb - 1, Math.floor(v / width + 1e-9))].n++;
  const median = values.length ? (values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : null;
  const sumN = rows => rows.reduce((x, r) => x + r.n, 0), sumP = rows => rows.reduce((x, r) => x + r.passed, 0);
  const appealMap = Object.fromEntries(appeals.map(a => [a.status, a.n]));
  return {
    pass_mark: scheme.pass_mark, min_sample: minSample,
    summary: { marks: sumN(byCourse), passed: sumP(byCourse), pass_rate: pct(sumP(byCourse), sumN(byCourse)), students_with_gpa: values.length, mean_gpa: values.length ? round2(values.reduce((x, y) => x + y, 0) / values.length) : null, median_gpa: round2(median) },
    pass_by_course: courses, pass_by_term: byTerm.map(withRate), pass_by_programme: byProgramme.map(withRate),
    grade_distribution: gradeDistribution,
    gpa_histogram: bins.map(b => ({ ...b, label: `${b.from.toFixed(1)}–${b.to.toFixed(1)}` })),
    hardest_courses: hardest, easiest_courses: easiest,
    appeals: { total: sumN(appeals), by_status: appealMap, upheld: appealMap.upheld ?? 0, rejected: appealMap.rejected ?? 0, open: (appealMap.submitted ?? 0) + (appealMap.under_review ?? 0), upheld_rate: pct(appealMap.upheld ?? 0, (appealMap.upheld ?? 0) + (appealMap.rejected ?? 0)) },
    progression: { total: sumN(progression), by_outcome: Object.entries(progression.reduce((o, r) => ({ ...o, [r.outcome]: (o[r.outcome] ?? 0) + r.n }), {})).map(([outcome, n]) => ({ outcome, n })), by_status: Object.entries(progression.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] ?? 0) + r.n }), {})).map(([status, n]) => ({ status, n })) },
  };
}

// ── overview ─────────────────────────────────────────────────────────────────────────────
async function overview(db, f) {
  const SW = where([progCond(f, 'c.programme_id')]);
  const SFROM = sql`students s LEFT JOIN classes c ON c.id = s.class_id`;
  const ACTIVE = sql`s.academic_status = 'active' AND s.is_active`;
  const enrolFrom = sql`course_enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN classes c ON c.id = s.class_id`;
  const [status, byProgramme, byLevel, byGender, teachers, offerings, regs, pending, marks, services, appeals] = await Promise.all([
    db.$queryRaw`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${ACTIVE})::int AS active, COUNT(*) FILTER (WHERE s.academic_status = 'graduated')::int AS graduated,
      COUNT(*) FILTER (WHERE s.academic_status = 'withdrawn')::int AS withdrawn, COUNT(*) FILTER (WHERE s.academic_status = 'suspended')::int AS suspended FROM ${SFROM} WHERE ${SW}`,
    db.$queryRaw`SELECT COALESCE(p.name, 'Unassigned') AS label, COUNT(*)::int AS n FROM ${SFROM} LEFT JOIN programmes p ON p.id = c.programme_id WHERE ${SW} AND ${ACTIVE} GROUP BY 1 ORDER BY n DESC, label`,
    db.$queryRaw`SELECT COALESCE(g.name, c.grade_level_name, s.grade_level_name, 'Unassigned') AS label, MIN(COALESCE(g.sort_order, 99))::int AS sort, COUNT(*)::int AS n FROM ${SFROM} LEFT JOIN grade_levels g ON g.id = c.grade_level_id WHERE ${SW} AND ${ACTIVE} GROUP BY 1 ORDER BY sort, label`,
    db.$queryRaw`SELECT COALESCE(s.gender::text, 'unspecified') AS label, COUNT(*)::int AS n FROM ${SFROM} WHERE ${SW} AND ${ACTIVE} GROUP BY 1 ORDER BY n DESC`,
    db.$queryRaw`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active FROM teachers`,
    db.$queryRaw`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE o.is_open)::int AS open FROM course_offerings o WHERE ${where([termCond(f, 'o.term_id'), f.programmeId ? sql`o.subject_id IN (SELECT subject_id FROM programme_courses WHERE programme_id = ${f.programmeId})` : null])}`,
    db.$queryRaw`SELECT t.id AS term_id, ay.label AS academic_year, t.name AS term, t.start_date, COUNT(*)::int AS registrations, COUNT(DISTINCT e.student_id)::int AS students, COALESCE(SUM(e.credits), 0)::float8 AS credits
      FROM ${enrolFrom} JOIN terms t ON t.id = e.term_id JOIN academic_years ay ON ay.id = t.academic_year_id WHERE e.status = 'registered' AND ${where([termCond(f, 'e.term_id'), progCond(f, 'c.programme_id')])}
      GROUP BY t.id, ay.label, t.name, t.start_date ORDER BY t.start_date`,
    db.$queryRaw`SELECT COUNT(*)::int AS n FROM ${enrolFrom} WHERE e.status = 'pending_approval' AND ${where([termCond(f, 'e.term_id'), progCond(f, 'c.programme_id')])}`,
    db.$queryRaw`SELECT COUNT(*) FILTER (WHERE m.status = 'submitted')::int AS submitted, COUNT(*) FILTER (WHERE m.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE m.status = 'draft')::int AS draft
      FROM ${MARK_FROM} WHERE ${where([termCond(f, 'm.term_id'), progCond(f, 'c.programme_id')])}`,
    db.$queryRaw`SELECT COUNT(*)::int AS n FROM service_requests sr JOIN students s ON s.id = sr.student_id LEFT JOIN classes c ON c.id = s.class_id WHERE sr.status IN ('submitted','in_review','awaiting_info') AND ${SW}`,
    db.$queryRaw`SELECT COUNT(*)::int AS n FROM grade_appeals a JOIN students s ON s.id = a.student_id LEFT JOIN classes c ON c.id = s.class_id WHERE a.status IN ('submitted','under_review') AND ${SW}`,
  ]);
  const st = status[0];
  return {
    students: { ...st, by_programme: byProgramme, by_level: byLevel.map(({ label, n }) => ({ label, n })), by_gender: byGender },
    lecturers: teachers[0], courses_offered: offerings[0],
    registrations: regs.map(r => ({ ...r, avg_credits: r.students ? round1(r.credits / r.students) : null })),
    pending_exception_requests: pending[0].n,
    results_awaiting_validation: { submitted: marks[0].submitted, approved_not_published: marks[0].approved, draft: marks[0].draft },
    open_service_requests: services[0].n, open_grade_appeals: appeals[0].n,
  };
}

// ── attendance ───────────────────────────────────────────────────────────────────────────
// rate = (present + late) / all records — the same definition as the student profile (excused days count in the total).
async function attendance(db, f, opts = {}) {
  const threshold = Math.min(100, Math.max(1, Number(opts.threshold) || 75));
  const minRecords = Math.min(1000, Math.max(1, parseInt(opts.min_records, 10) || 5));
  const W = where([f.range ? sql`a.date BETWEEN ${f.range.from} AND ${f.range.to}` : null, progCond(f, 'c.programme_id')]);
  // One scan of the records, grouped per (student, class); every table is rolled up from those rows in memory.
  const [rows, classes, programmes] = await Promise.all([
    db.$queryRaw`SELECT a.student_id, a.class_id, COUNT(*)::int AS records, COUNT(*) FILTER (WHERE a.status = 'present')::int AS present, COUNT(*) FILTER (WHERE a.status = 'late')::int AS late,
      COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent, COUNT(*) FILTER (WHERE a.status = 'excused')::int AS excused
      FROM attendance_records a JOIN classes c ON c.id = a.class_id WHERE ${W} GROUP BY a.student_id, a.class_id`,
    db.class.findMany({ select: { id: true, name: true, programme_id: true } }),
    db.programme.findMany({ select: { id: true, name: true } }),
  ]);
  const clsById = Object.fromEntries(classes.map(c => [c.id, c])), progName = Object.fromEntries(programmes.map(p => [p.id, p.name]));
  const add = (m, k, r) => { const a = m.get(k) ?? { records: 0, ok: 0, students: new Set() }; a.records += r.records; a.ok += r.present + r.late; a.students.add(r.student_id); m.set(k, a); };
  const byClassM = new Map(), byProgM = new Map(), byStudent = new Map();
  const o = { records: 0, present: 0, absent: 0, late: 0, excused: 0 };
  for (const r of rows) {
    for (const k of ['records', 'present', 'absent', 'late', 'excused']) o[k] += r[k];
    add(byClassM, r.class_id, r); add(byProgM, clsById[r.class_id]?.programme_id ?? '', r);
    const st = byStudent.get(r.student_id) ?? { records: 0, ok: 0 }; st.records += r.records; st.ok += r.present + r.late; byStudent.set(r.student_id, st);
  }
  const pname = id => (id ? progName[id] ?? '?' : 'Unassigned');
  const byClass = [...byClassM].map(([id, a]) => ({ class_id: id, class_name: clsById[id]?.name ?? '?', programme: pname(clsById[id]?.programme_id), records: a.records, rate: pct(a.ok, a.records) })).sort((x, y) => x.rate - y.rate || x.class_name.localeCompare(y.class_name));
  const byProgramme = [...byProgM].map(([id, a]) => ({ programme_id: id || null, programme: pname(id), records: a.records, students: a.students.size, rate: pct(a.ok, a.records) })).sort((x, y) => x.rate - y.rate || x.programme.localeCompare(y.programme));
  const lowAll = [...byStudent].filter(([, a]) => a.records >= minRecords && (a.ok / a.records) * 100 < threshold).map(([id, a]) => ({ student_id: id, records: a.records, rate: pct(a.ok, a.records) }));
  const lowIds = lowAll.slice().sort((x, y) => x.rate - y.rate).slice(0, 600).map(x => x.student_id);
  const names = lowIds.length ? await db.student.findMany({ where: { id: { in: lowIds } }, select: { id: true, first_name: true, last_name: true, student_number: true, class_name: true } }) : [];
  const nameById = Object.fromEntries(names.map(n => [n.id, n]));
  const low = lowAll.map(x => ({ student_id: x.student_id, name: nameById[x.student_id] ? `${nameById[x.student_id].first_name} ${nameById[x.student_id].last_name}` : '?', matricule: nameById[x.student_id]?.student_number ?? null, class_name: nameById[x.student_id]?.class_name ?? null, records: x.records, rate: x.rate }))
    .filter(x => x.name !== '?').sort((x, y) => x.rate - y.rate || x.name.localeCompare(y.name)).slice(0, 200);
  return {
    threshold, min_records: minRecords,
    overall: { ...o, students: byStudent.size, rate: pct(o.present + o.late, o.records) },
    by_class: byClass, by_programme: byProgramme,
    below_threshold: { count: lowAll.length, students: low },
  };
}

// ── exams ────────────────────────────────────────────────────────────────────────────────
async function exams(db, f) {
  const W = where([termCond(f, 'es.term_id'), progCond(f, 'c.programme_id')]);
  const FROM = sql`exam_candidates ec JOIN exam_sessions es ON es.id = ec.exam_id JOIN subjects sub ON sub.id = es.subject_id JOIN students s ON s.id = ec.student_id LEFT JOIN classes c ON c.id = s.class_id`;
  const [sessions, totals, reasons] = await Promise.all([
    db.$queryRaw`SELECT es.id AS exam_id, es.title, sub.code, sub.name AS course, es.kind, es.date, es.status, COUNT(*)::int AS candidates, COUNT(*) FILTER (WHERE ec.eligible)::int AS eligible,
      COUNT(*) FILTER (WHERE NOT ec.eligible)::int AS ineligible, COUNT(*) FILTER (WHERE ec.attendance = 'present')::int AS present, COUNT(*) FILTER (WHERE ec.attendance = 'absent')::int AS absent
      FROM ${FROM} WHERE ${W} GROUP BY es.id, es.title, sub.code, sub.name, es.kind, es.date, es.status ORDER BY es.date, sub.code LIMIT 500`,
    db.$queryRaw`SELECT COUNT(DISTINCT es.id)::int AS sessions, COUNT(*)::int AS candidates, COUNT(DISTINCT ec.student_id)::int AS students, COUNT(*) FILTER (WHERE ec.eligible)::int AS eligible, COUNT(*) FILTER (WHERE NOT ec.eligible)::int AS ineligible,
      COUNT(*) FILTER (WHERE ec.eligible AND ec.override_by IS NOT NULL)::int AS overridden, COUNT(*) FILTER (WHERE ec.attendance = 'present')::int AS present, COUNT(*) FILTER (WHERE ec.attendance = 'absent')::int AS absent FROM ${FROM} WHERE ${W}`,
    db.$queryRaw`SELECT COALESCE(r.value->>'code', 'unspecified') AS code, MIN(r.value->>'message') AS message, COUNT(*)::int AS n
      FROM ${FROM} CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ec.ineligible_reasons) = 'array' THEN ec.ineligible_reasons ELSE '[]'::jsonb END) AS r(value)
      WHERE ${W} AND NOT ec.eligible GROUP BY 1 ORDER BY n DESC`,
  ]);
  const t = totals[0];
  return { totals: { ...t, ineligible_rate: pct(t.ineligible, t.candidates) }, ineligible_by_reason: reasons, sessions };
}

// ── finance ──────────────────────────────────────────────────────────────────────────────
async function finance(db, f) {
  const today = new Date().toISOString().slice(0, 10);
  const FR = sql`fee_records fr LEFT JOIN students s ON s.id = fr.student_id LEFT JOIN classes c ON c.id = COALESCE(fr.class_id, s.class_id)`;
  const W = where([sql`fr.status <> 'waived'`, f.yearLabel ? sql`fr.academic_year = ${f.yearLabel}` : null, progCond(f, 'c.programme_id')]);
  const overdue = sql`(fr.status = 'overdue' OR (fr.balance > 0 AND fr.due_date IS NOT NULL AND fr.due_date < ${today} AND fr.status NOT IN ('paid','waived')))`;
  const [tot, byMonth, byProgramme, cash, tx, manual] = await Promise.all([
    db.$queryRaw`SELECT COALESCE(SUM(fr.amount_due), 0)::float8 AS due, COALESCE(SUM(fr.amount_paid), 0)::float8 AS collected, COALESCE(SUM(fr.balance), 0)::float8 AS outstanding,
      COALESCE(SUM(CASE WHEN ${overdue} THEN fr.balance ELSE 0 END), 0)::float8 AS overdue, COUNT(*)::int AS fee_records, COUNT(DISTINCT fr.student_id) FILTER (WHERE fr.balance > 0)::int AS students_with_balance FROM ${FR} WHERE ${W}`,
    db.$queryRaw`SELECT COALESCE(substr(fr.due_date, 1, 7), 'undated') AS month, COALESCE(SUM(fr.amount_due), 0)::float8 AS due, COALESCE(SUM(fr.amount_paid), 0)::float8 AS collected, COALESCE(SUM(fr.balance), 0)::float8 AS outstanding,
      COALESCE(SUM(CASE WHEN ${overdue} THEN fr.balance ELSE 0 END), 0)::float8 AS overdue FROM ${FR} WHERE ${W} GROUP BY 1 ORDER BY 1`,
    db.$queryRaw`SELECT p.id AS programme_id, COALESCE(p.name, 'Unassigned') AS programme, COALESCE(SUM(fr.amount_due), 0)::float8 AS due, COALESCE(SUM(fr.amount_paid), 0)::float8 AS collected, COALESCE(SUM(fr.balance), 0)::float8 AS outstanding,
      COALESCE(SUM(CASE WHEN ${overdue} THEN fr.balance ELSE 0 END), 0)::float8 AS overdue FROM ${FR} LEFT JOIN programmes p ON p.id = c.programme_id WHERE ${W} GROUP BY p.id, p.name ORDER BY due DESC`,
    db.$queryRaw`SELECT COALESCE(substr(COALESCE(py.payment_date, to_char(py.created_at, 'YYYY-MM-DD')), 1, 7), 'undated') AS month, COALESCE(SUM(py.amount), 0)::float8 AS received
      FROM payments py JOIN fee_records fr ON fr.id = py.fee_record_id LEFT JOIN students s ON s.id = fr.student_id LEFT JOIN classes c ON c.id = COALESCE(fr.class_id, s.class_id) WHERE ${W} GROUP BY 1 ORDER BY 1`,
    db.$queryRaw`SELECT pt.provider AS method, COUNT(*)::int AS n, COALESCE(SUM(pt.amount), 0)::float8 AS amount FROM payment_transactions pt JOIN fee_records fr ON fr.id = pt.fee_record_id LEFT JOIN students s ON s.id = fr.student_id LEFT JOIN classes c ON c.id = COALESCE(fr.class_id, s.class_id)
      WHERE pt.status = 'successful' AND ${W} GROUP BY pt.provider ORDER BY amount DESC`,
    db.$queryRaw`SELECT COALESCE(NULLIF(py.method, ''), 'unspecified') AS method, COUNT(*)::int AS n, COALESCE(SUM(py.amount), 0)::float8 AS amount FROM payments py JOIN fee_records fr ON fr.id = py.fee_record_id LEFT JOIN students s ON s.id = fr.student_id LEFT JOIN classes c ON c.id = COALESCE(fr.class_id, s.class_id)
      WHERE py.transaction_id IS NULL AND py.amount > 0 AND ${W} GROUP BY 1 ORDER BY amount DESC`,
  ]);
  const t = tot[0];
  const rate = r => ({ ...r, collection_rate: pct(r.collected, r.due) });
  const txTotal = tx.reduce((x, r) => x + r.amount, 0);
  return {
    currency: 'XAF',
    totals: { ...t, collection_rate: pct(t.collected, t.due) },
    by_month: byMonth.map(rate), by_programme: byProgramme.map(rate),
    cash_received_by_month: cash,
    payment_methods: tx.map(r => ({ ...r, share: pct(r.amount, txTotal) })),
    manual_payment_methods: manual,
  };
}

// ── trends (semester over semester) ──────────────────────────────────────────────────────
async function trends(db, f) {
  const scheme = await getScheme(db), pass = passExpr(scheme);
  const yearCond = f.yearLabel ? sql`t.academic_year_id = (SELECT id FROM academic_years WHERE label = ${f.yearLabel} LIMIT 1)` : null;
  const termsW = where([yearCond]);
  const mW = where([sql`m.status = 'published'`, progCond(f, 'c.programme_id')]);
  const [terms, perStudent, regs, att] = await Promise.all([
    db.$queryRaw`SELECT t.id, t.name AS term, t.start_date, t.end_date, ay.label AS academic_year FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id WHERE ${termsW} ORDER BY t.start_date`,
    // one scan of the marks: per (semester, student) pass counts and quality points
    db.$queryRaw`WITH ${pointsCte(scheme)}
      SELECT m.term_id, m.student_id, COUNT(*)::int AS n, SUM(CASE WHEN ${pass} THEN 1 ELSE 0 END)::int AS passed, SUM(m.total_score)::float8 AS sum_score,
        SUM(COALESCE(pts.points, 0) * sub.credit_hours)::float8 AS qp, SUM(sub.credit_hours)::float8 AS cr
      FROM ${MARK_FROM} LEFT JOIN pts ON pts.grade = m.grade WHERE ${mW} GROUP BY m.term_id, m.student_id`,
    db.$queryRaw`SELECT e.term_id, COUNT(DISTINCT e.student_id)::int AS students, COUNT(*)::int AS registrations, COALESCE(SUM(e.credits), 0)::float8 AS credits
      FROM course_enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN classes c ON c.id = s.class_id WHERE e.status = 'registered' AND ${where([progCond(f, 'c.programme_id')])} GROUP BY e.term_id`,
    db.$queryRaw`SELECT t.id AS term_id, COUNT(*)::int AS records, COUNT(*) FILTER (WHERE a.status IN ('present','late'))::int AS ok
      FROM attendance_records a JOIN terms t ON a.date BETWEEN t.start_date AND t.end_date JOIN classes c ON c.id = a.class_id WHERE ${where([yearCond, progCond(f, 'c.programme_id')])} GROUP BY t.id`,
  ]);
  const M = {}, G = {};
  for (const r of perStudent) {
    const m = (M[r.term_id] ??= { term_id: r.term_id, n: 0, passed: 0, sum: 0 }); m.n += r.n; m.passed += r.passed; m.sum += r.sum_score;
    if (r.cr > 0) { const g = (G[r.term_id] ??= { sum: 0, students: 0 }); g.sum += r.qp / r.cr; g.students++; }
  }
  for (const k of Object.keys(M)) M[k].avg_score = M[k].n ? M[k].sum / M[k].n : null;
  for (const k of Object.keys(G)) G[k].mean_gpa = G[k].sum / G[k].students;
  const by = rows => Object.fromEntries(rows.map(r => [r.term_id, r]));
  const R = by(regs), A = by(att);
  const series = terms.map(t => ({
    term_id: t.id, label: `${t.academic_year} · ${t.term}`, academic_year: t.academic_year, term: t.term,
    registered_students: R[t.id]?.students ?? 0, avg_credits: R[t.id]?.students ? round1(R[t.id].credits / R[t.id].students) : null,
    marks: M[t.id]?.n ?? 0, pass_rate: M[t.id] ? pct(M[t.id].passed, M[t.id].n) : null, avg_score: M[t.id] ? round1(M[t.id].avg_score) : null,
    mean_gpa: G[t.id] ? round2(G[t.id].mean_gpa) : null, attendance_rate: A[t.id] ? pct(A[t.id].ok, A[t.id].records) : null,
  }));
  const delta = (a, b) => (a == null || b == null ? null : round2(a - b));
  series.forEach((s, i) => {
    const p = series[i - 1];
    s.change = p ? { registered_students: delta(s.registered_students, p.registered_students), pass_rate: delta(s.pass_rate, p.pass_rate), mean_gpa: delta(s.mean_gpa, p.mean_gpa), attendance_rate: delta(s.attendance_rate, p.attendance_rate) } : null;
  });
  return { series };
}

// ── option lists for the filter bar ──────────────────────────────────────────────────────
async function filterOptions(db) {
  const [years, programmes] = await Promise.all([
    db.academicYear.findMany({ include: { terms: { orderBy: { start_date: 'asc' } } }, orderBy: { start_date: 'desc' } }),
    db.programme.findMany({ select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
  ]);
  return { years: years.map(y => ({ id: y.id, label: y.label, is_current: y.is_current, terms: y.terms.map(t => ({ id: t.id, name: t.name, is_current: t.is_current })) })), programmes };
}

// ── CSV tables per endpoint ──────────────────────────────────────────────────────────────
const TABLES = {
  overview: { by_programme: d => d.students.by_programme, by_level: d => d.students.by_level, by_gender: d => d.students.by_gender, registrations: d => d.registrations },
  academics: { pass_by_course: d => d.pass_by_course, pass_by_term: d => d.pass_by_term, pass_by_programme: d => d.pass_by_programme, grade_distribution: d => d.grade_distribution, gpa_histogram: d => d.gpa_histogram, hardest_courses: d => d.hardest_courses, easiest_courses: d => d.easiest_courses },
  attendance: { by_class: d => d.by_class, by_programme: d => d.by_programme, below_threshold: d => d.below_threshold.students },
  exams: { sessions: d => d.sessions, ineligible_by_reason: d => d.ineligible_by_reason },
  finance: { by_month: d => d.by_month, by_programme: d => d.by_programme, payment_methods: d => d.payment_methods, cash_received_by_month: d => d.cash_received_by_month },
  trends: { series: d => d.series.map(({ change, ...r }) => ({ ...r, ...Object.fromEntries(['registered_students', 'pass_rate', 'mean_gpa', 'attendance_rate'].map(k => [`change_${k}`, change ? change[k] : null])) })) },
};

module.exports = { resolveFilters, FilterError, academics, overview, attendance, exams, finance, trends, filterOptions, TABLES };
