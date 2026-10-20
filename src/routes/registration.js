// Student-facing course registration. Every rule is enforced on the server (academics/registration.js);
// the browser only displays the verdicts.
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const reg = require('../academics/registration');
const { buildProfile, currentTerm } = require('../academics/profile');

router.use(authenticate, authorize('student'));
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const me = async (req, res) => {
  const s = req.user.student_id && await reg.loadStudent(req.db, req.user.student_id);
  if (!s) { res.status(404).json({ error: 'Student profile not found' }); return null; }
  return s;
};
const actor = u => ({ id: u.id, name: u.name, role: u.role });
const fail = (res, e) => { if (e instanceof reg.RegistrationError) return res.status(e.status).json({ error: e.message, code: e.code, details: e.details }); throw e; };

// Semesters the student can register in: those with a registration period that applies to them.
async function termsFor(db, student) {
  const periods = await db.registrationPeriod.findMany({ include: { term: { include: { academic_year: true } } }, orderBy: { opens_at: 'desc' } });
  const prog = student.class?.programme_id ?? null, level = student.class?.grade_level_id ?? null;
  const seen = new Map();
  for (const p of periods) {
    if ((p.programme_id && p.programme_id !== prog) || (p.level_id && p.level_id !== level)) continue;
    if (!seen.has(p.term_id)) seen.set(p.term_id, { id: p.term_id, name: p.term.name, academic_year: p.term.academic_year.label });
  }
  return [...seen.values()];
}

// GET /api/registration/me?termId=
router.get('/me', async (req, res) => {
  const s = await me(req, res); if (!s) return;
  const terms = await termsFor(req.db, s);
  const cur = await currentTerm(req.db);
  const termId = req.query.termId ? String(req.query.termId) : (terms.find(t => t.id === cur?.id) ?? terms[0] ?? (cur && { id: cur.id }))?.id;
  if (!termId) return res.json({ student: reg.studentView(s), terms: [], term: null, period: null, registered: [], offerings: [], credits: { registered: 0, pending: 0, min: null, max: null, below_minimum: false } });
  try { res.json({ terms, ...(await reg.overview(req.db, s, termId)) }); } catch (e) { return fail(res, e); }
});

router.post('/me/enroll', async (req, res) => {
  const s = await me(req, res); if (!s) return;
  if (!req.body.offering_id) return res.status(422).json({ error: 'offering_id is required' });
  try {
    const r = await reg.enroll(req.db, s, req.body.offering_id, { actor: actor(req.user), exceptionReason: req.body.exception_reason });
    res.status(201).json({ enrollment: r.enrollment, pending_approval: r.enrollment.status === 'pending_approval' });
  } catch (e) { return fail(res, e); }
});

router.post('/me/drop', async (req, res) => {
  const s = await me(req, res); if (!s) return;
  try { res.json(await reg.drop(req.db, s, req.body.enrollment_id, { actor: actor(req.user), reason: req.body.reason })); } catch (e) { return fail(res, e); }
});

// Data for the printable registration summary
router.get('/me/summary', async (req, res) => {
  const s = await me(req, res); if (!s) return;
  const cur = await currentTerm(req.db);
  const termId = req.query.termId ? String(req.query.termId) : cur?.id;
  if (!termId) return res.status(404).json({ error: 'No semester found' });
  const [o, school] = await Promise.all([reg.overview(req.db, s, termId), req.db.school.findFirst()]);
  res.json({
    generated_at: new Date(), school: { name: school?.name ?? '', address: school?.address ?? null }, student: o.student, term: o.term,
    courses: o.registered.filter(r => r.status === 'registered'), pending: o.registered.filter(r => r.status === 'pending_approval'),
    credits: o.credits, period: o.period && { min_credits: o.period.min_credits, max_credits: o.period.max_credits },
  });
});

router.get('/me/profile', async (req, res) => {
  const s = await me(req, res); if (!s) return;
  res.json(await buildProfile(req.db, s.id, { includeFinance: true }));
});

module.exports = router;
