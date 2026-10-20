// Results administration: validation queue, approve / publish / reject / reopen, history, grading scheme,
// academic rules, and what students see (published results only) plus grade appeals.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getScheme, invalidate } = require('../academics/gradingScheme');
const { saveMark, transition, actorOf, ResultsError } = require('../academics/results');
const { audit } = require('../academics/registration');
const { notifyUsers, safe } = require('../utils/notify');

const approvers = [authenticate, authorize('super_admin', 'academic_officer')];
const fail = (res, e) => { if (e instanceof ResultsError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; };

// ── Validation queue ────────────────────────────────────────────────────────────
// One row per (course, semester) with how many marks sit in each status.
router.get('/batches', ...approvers, async (req, res) => {
  const where = {};
  if (req.query.termId) where.term_id = String(req.query.termId);
  const groups = await req.db.mark.groupBy({ by: ['subject_id', 'term_id', 'status'], where, _count: { _all: true } });
  const keys = new Map();
  for (const g of groups) {
    const k = `${g.subject_id}|${g.term_id}`;
    const row = keys.get(k) ?? { subject_id: g.subject_id, term_id: g.term_id, draft: 0, submitted: 0, approved: 0, published: 0 };
    row[g.status] = g._count._all; keys.set(k, row);
  }
  let rows = [...keys.values()];
  if (req.query.status) rows = rows.filter(r => r[String(req.query.status)] > 0);
  const [subjects, terms] = await Promise.all([
    req.db.subject.findMany({ where: { id: { in: [...new Set(rows.map(r => r.subject_id))] } }, select: { id: true, name: true, code: true } }),
    req.db.term.findMany({ where: { id: { in: [...new Set(rows.map(r => r.term_id))] } }, include: { academic_year: true } }),
  ]);
  const sb = Object.fromEntries(subjects.map(s => [s.id, s])), tb = Object.fromEntries(terms.map(t => [t.id, t]));
  const offerings = await req.db.courseOffering.findMany({ where: { OR: rows.map(r => ({ subject_id: r.subject_id, term_id: r.term_id })) }, include: { teacher: { select: { first_name: true, last_name: true } } } });
  res.json(rows.map(r => ({
    ...r, course: sb[r.subject_id]?.name, code: sb[r.subject_id]?.code, term: tb[r.term_id]?.name, academic_year: tb[r.term_id]?.academic_year?.label,
    lecturers: [...new Set(offerings.filter(o => o.subject_id === r.subject_id && o.term_id === r.term_id && o.teacher).map(o => `${o.teacher.first_name} ${o.teacher.last_name}`))],
  })).sort((a, b) => b.submitted - a.submitted || String(a.course).localeCompare(String(b.course))));
});

router.get('/marks', ...approvers, async (req, res) => {
  const { subjectId, termId, status } = req.query;
  if (!subjectId || !termId) return res.status(422).json({ error: 'subjectId and termId are required' });
  const rows = await req.db.mark.findMany({ where: { subject_id: String(subjectId), term_id: String(termId), ...(status && { status: String(status) }) }, orderBy: { student_name: 'asc' } });
  res.json(rows);
});

router.get('/marks/:id/history', ...approvers, async (req, res) => {
  res.json(await req.db.markHistory.findMany({ where: { mark_id: req.params.id }, orderBy: { created_at: 'asc' } }));
});

// POST /api/results/transition { action, subject_id, term_id, mark_ids?, reason }
router.post('/transition', ...approvers, async (req, res) => {
  const { action, subject_id, term_id, mark_ids, reason } = req.body;
  try {
    const r = await transition(req.db, action, mark_ids ? { markIds: mark_ids } : { subjectId: subject_id, termId: term_id }, req.user, { reason });
    await audit(req.db, actorOf(req.user), `results.${action}`, 'mark_batch', `${subject_id ?? 'ids'}|${term_id ?? ''}`, { reason, after: { moved: r.moved } });
    res.json(r);
  } catch (e) { return fail(res, e); }
});

// ── Grading scheme & academic rules ─────────────────────────────────────────────
const schemeDto = s => ({ id: s.id, name: s.name, ca_weight: s.ca_weight, exam_weight: s.exam_weight, pass_mark: s.pass_mark, resit_cap: s.resit_cap, bands: [...s.bands].sort((a, b) => b.min_score - a.min_score) });
router.get('/scheme', authenticate, authorize('super_admin', 'academic_officer', 'teacher'), async (req, res) => {
  const row = await req.db.gradingScheme.findFirst({ where: { is_active: true }, include: { bands: true } });
  if (!row) { const s = await getScheme(req.db); return res.json({ id: null, name: s.name, ca_weight: s.ca_weight, exam_weight: s.exam_weight, pass_mark: s.pass_mark, resit_cap: s.resit_cap, bands: s.bands, built_in: true }); }
  res.json(schemeDto(row));
});
router.put('/scheme', ...approvers, async (req, res) => {
  const b = req.body;
  const ca = Number(b.ca_weight), ex = Number(b.exam_weight), pass = Number(b.pass_mark);
  if (![ca, ex, pass].every(Number.isFinite) || ca < 0 || ex < 0 || ca + ex <= 0) return res.status(422).json({ error: 'Weights must be non-negative numbers and not both zero.' });
  if (Math.abs(ca + ex - 100) > 0.001) return res.status(422).json({ error: 'The CA and exam weights must add up to 100.' });
  if (pass < 0 || pass > 100) return res.status(422).json({ error: 'The pass mark must be between 0 and 100.' });
  if (!Array.isArray(b.bands) || b.bands.length < 2) return res.status(422).json({ error: 'Define at least two grade bands.' });
  const seen = new Set();
  for (const x of b.bands) {
    if (!x.grade || !Number.isFinite(Number(x.min_score)) || !Number.isFinite(Number(x.points)) || x.min_score < 0 || x.min_score > 100 || x.points < 0) return res.status(422).json({ error: 'Each band needs a grade, a minimum score (0–100) and points (≥ 0).' });
    if (seen.has(x.grade)) return res.status(422).json({ error: `Duplicate grade "${x.grade}".` }); seen.add(x.grade);
  }
  if (!b.bands.some(x => Number(x.min_score) === 0)) return res.status(422).json({ error: 'One band must start at 0 so every score has a grade.' });
  const mins = b.bands.map(x => Number(x.min_score)); if (new Set(mins).size !== mins.length) return res.status(422).json({ error: 'Two bands have the same minimum score.' });
  const before = await req.db.gradingScheme.findFirst({ where: { is_active: true }, include: { bands: true } });
  const id = uuid();
  await req.db.$transaction([
    req.db.gradingScheme.updateMany({ where: { is_active: true }, data: { is_active: false } }),
    req.db.gradingScheme.create({ data: { id, name: b.name || 'Grading scheme', is_active: true, ca_weight: ca, exam_weight: ex, pass_mark: pass, resit_cap: b.resit_cap === null || b.resit_cap === undefined || b.resit_cap === '' ? null : Number(b.resit_cap),
      bands: { create: b.bands.map(x => ({ id: uuid(), min_score: Number(x.min_score), grade: String(x.grade), points: Number(x.points), remark: x.remark || null, is_pass: x.is_pass !== false })) } } }),
  ]);
  invalidate(req.db);
  await audit(req.db, actorOf(req.user), 'grading_scheme.replace', 'grading_scheme', id, { reason: b.reason, before: before && schemeDto(before), after: { ca, ex, pass, bands: b.bands.length } });
  res.json(schemeDto(await req.db.gradingScheme.findUnique({ where: { id }, include: { bands: true } })));
});

const SETTINGS_DEFAULTS = { exam_min_attendance_pct: null, exam_fee_rule: 'none', exam_min_paid_pct: 0, progression: null };
router.get('/settings', authenticate, authorize('super_admin', 'academic_officer'), async (req, res) => {
  const { defaults } = require('../academics/progression');
  const row = await req.db.academicSettings.findUnique({ where: { id: 'main' } });
  res.json({ ...SETTINGS_DEFAULTS, ...(row ?? {}), progression: { ...defaults(), ...(row?.progression ?? {}) } });
});
router.put('/settings', ...approvers, async (req, res) => {
  const { validate } = require('../academics/progression');
  const b = req.body;
  if (b.exam_fee_rule && !['none', 'no_overdue', 'min_paid_pct'].includes(b.exam_fee_rule)) return res.status(422).json({ error: 'exam_fee_rule must be none, no_overdue or min_paid_pct' });
  const pct = v => v === null || v === undefined || v === '' ? null : Number(v);
  if (pct(b.exam_min_attendance_pct) !== null && !(pct(b.exam_min_attendance_pct) >= 0 && pct(b.exam_min_attendance_pct) <= 100)) return res.status(422).json({ error: 'Minimum attendance must be 0–100.' });
  if (b.exam_min_paid_pct !== undefined && !(Number(b.exam_min_paid_pct) >= 0 && Number(b.exam_min_paid_pct) <= 100)) return res.status(422).json({ error: 'Minimum paid % must be 0–100.' });
  let progression;
  if (b.progression !== undefined) { const v = validate(b.progression); if (v.error) return res.status(422).json({ error: v.error }); progression = v.value; }
  const data = {
    ...(b.exam_min_attendance_pct !== undefined && { exam_min_attendance_pct: pct(b.exam_min_attendance_pct) }), ...(b.exam_fee_rule !== undefined && { exam_fee_rule: b.exam_fee_rule }),
    ...(b.exam_min_paid_pct !== undefined && { exam_min_paid_pct: Number(b.exam_min_paid_pct) }), ...(progression !== undefined && { progression }), updated_by: req.user.id, updated_at: new Date(),
  };
  const row = await req.db.academicSettings.upsert({ where: { id: 'main' }, update: data, create: { id: 'main', ...data } });
  await audit(req.db, actorOf(req.user), 'academic_settings.update', 'academic_settings', 'main', { reason: b.reason, after: data });
  res.json(row);
});

// ── What students see ─────────────────────────────────────────────────────────────
// Published marks only, with credits/points, grouped by semester; plus any appeal they have filed.
router.get('/me', authenticate, authorize('student'), async (req, res) => {
  const sid = req.user.student_id;
  const scheme = await getScheme(req.db);
  const marks = await req.db.mark.findMany({ where: { student_id: sid, status: 'published' }, include: { appeals: { where: { student_id: sid }, orderBy: { created_at: 'desc' }, take: 1 } } });
  const [subjects, terms] = await Promise.all([
    req.db.subject.findMany({ where: { id: { in: [...new Set(marks.map(m => m.subject_id))] } } }),
    req.db.term.findMany({ where: { id: { in: [...new Set(marks.map(m => m.term_id))] } }, include: { academic_year: true } }),
  ]);
  const sb = Object.fromEntries(subjects.map(s => [s.id, s]));
  const byTerm = terms.map(t => {
    const rows = marks.filter(m => m.term_id === t.id).map(m => ({
      mark_id: m.id, course: sb[m.subject_id]?.name ?? m.subject_name, code: sb[m.subject_id]?.code, credits: sb[m.subject_id]?.credit_hours ?? 0,
      ca_score: m.ca_score, exam_score: m.exam_score, total_score: m.total_score, grade: m.grade, remark: m.remark, points: scheme.pointsFor(m.grade), passed: scheme.markPassed(m),
      resit_score: m.resit_score, resit_grade: m.resit_grade, exam_absent: m.exam_absent, appeal: m.appeals[0] ? { id: m.appeals[0].id, status: m.appeals[0].status, decision_note: m.appeals[0].decision_note } : null,
    }));
    const credits = rows.reduce((x, r) => x + r.credits, 0), quality = rows.reduce((x, r) => x + r.points * r.credits, 0);
    return { term_id: t.id, term: t.name, academic_year: t.academic_year.label, start_date: t.start_date, courses: rows, credits, earned: rows.filter(r => r.passed).reduce((x, r) => x + r.credits, 0), gpa: credits ? Math.round(quality / credits * 100) / 100 : 0 };
  }).sort((a, b) => b.start_date.localeCompare(a.start_date));
  const allRows = byTerm.flatMap(t => t.courses), credits = allRows.reduce((x, r) => x + r.credits, 0), quality = allRows.reduce((x, r) => x + r.points * r.credits, 0);
  res.json({ pass_mark: scheme.pass_mark, bands: scheme.bands, terms: byTerm, cumulative: { gpa: credits ? Math.round(quality / credits * 100) / 100 : 0, credits, earned: allRows.filter(r => r.passed).reduce((x, r) => x + r.credits, 0) } });
});

router.post('/me/appeals', authenticate, authorize('student'), async (req, res) => {
  const { mark_id, reason } = req.body;
  if (!reason || reason.trim().length < 10) return res.status(422).json({ error: 'Explain your appeal in at least a sentence (10+ characters).' });
  const mark = await req.db.mark.findUnique({ where: { id: String(mark_id || '') } });
  if (!mark || mark.student_id !== req.user.student_id || mark.status !== 'published') return res.status(404).json({ error: 'Result not found' });
  if (await req.db.gradeAppeal.findFirst({ where: { mark_id: mark.id, student_id: mark.student_id, status: { in: ['submitted', 'under_review'] } } })) return res.status(409).json({ error: 'You already have an open appeal for this result.' });
  const row = await req.db.gradeAppeal.create({ data: { id: uuid(), mark_id: mark.id, student_id: mark.student_id, reason: reason.trim() } });
  res.status(201).json(row);
});

// ── Appeals (reviewers) ───────────────────────────────────────────────────────────
router.get('/appeals', ...approvers, async (req, res) => {
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await req.db.gradeAppeal.findMany({ where, orderBy: { created_at: 'desc' }, take: 200, include: { mark: true, student: { select: { first_name: true, last_name: true, student_number: true } } } });
  res.json(rows.map(a => ({ id: a.id, status: a.status, reason: a.reason, decision_note: a.decision_note, created_at: a.created_at, decided_at: a.decided_at, student: `${a.student.first_name} ${a.student.last_name}`, matricule: a.student.student_number, mark_id: a.mark_id, course: a.mark.subject_name, ca_score: a.mark.ca_score, exam_score: a.mark.exam_score, total_score: a.mark.total_score, grade: a.mark.grade })));
});
router.post('/appeals/:id/decision', ...approvers, async (req, res) => {
  const { decision, note, new_ca, new_exam } = req.body;
  const a = await req.db.gradeAppeal.findUnique({ where: { id: req.params.id }, include: { mark: true } });
  if (!a) return res.status(404).json({ error: 'Appeal not found' });
  if (!['submitted', 'under_review'].includes(a.status)) return res.status(409).json({ error: `This appeal is already ${a.status}.` });
  if (!['uphold', 'reject', 'review'].includes(decision)) return res.status(422).json({ error: 'decision must be uphold, reject or review' });
  if (decision !== 'review' && !(note && note.trim())) return res.status(422).json({ error: 'A decision note is required.' });
  try {
    if (decision === 'uphold' && (new_ca !== undefined || new_exam !== undefined)) {
      const scheme = await getScheme(req.db);
      await saveMark(req.db, scheme, { studentId: a.mark.student_id, subjectId: a.mark.subject_id, termId: a.mark.term_id, classId: a.mark.class_id, caScore: new_ca ?? a.mark.ca_score, examScore: new_exam ?? a.mark.exam_score, resitScore: a.mark.resit_score, examAbsent: false }, req.user, { reason: `Appeal upheld: ${note}` });
    }
    const status = decision === 'uphold' ? 'upheld' : decision === 'reject' ? 'rejected' : 'under_review';
    const row = await req.db.gradeAppeal.update({ where: { id: a.id }, data: { status, reviewed_by: req.user.id, decision_note: note?.trim() || null, new_ca: new_ca ?? null, new_exam: new_exam ?? null, decided_at: decision === 'review' ? null : new Date() } });
    await audit(req.db, actorOf(req.user), `appeal.${decision}`, 'grade_appeal', a.id, { reason: note });
    if (decision !== 'review') await safe(async () => {
      const users = await req.db.user.findMany({ where: { student_id: a.student_id }, select: { id: true } });
      await notifyUsers(req.db, users.map(u => u.id), { type: 'appeal_decision', title: `Your grade appeal was ${status}`, body: `${a.mark.subject_name}${note ? ` — ${note}` : ''}`, link: '/student/marks' });
    });
    res.json(row);
  } catch (e) { return fail(res, e); }
});

module.exports = router;
