// Connected timetable engine: weekly timetables (student / lecturer / room / programme), conflicts report, .ics export.
// Students only see their own timetable, lecturers only theirs, staff see everything. See docs/TIMETABLE.md.
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const E = require('../timetable/engine');
const T = require('../timetable/core');

const staff = [authenticate, authorize('super_admin', 'academic_officer')];
const isStaff = u => ['super_admin', 'head_teacher', 'academic_officer'].includes(u.role);

/** Resolve :id ('me' allowed) honouring ownership; returns the id or sends 403/404. */
function scoped(kind) {
  return (req, res, next) => {
    const u = req.user;
    if (isStaff(u)) { req.subjectId = req.params.id === 'me' ? null : req.params.id; if (!req.subjectId) return res.status(404).json({ error: 'Not found' }); return next(); }
    const own = kind === 'student' && u.role === 'student' ? u.student_id : kind === 'lecturer' && u.role === 'teacher' ? u.teacher_id : null;
    if (!own) return res.status(403).json({ error: 'Forbidden' });
    if (req.params.id !== 'me' && req.params.id !== own) return res.status(403).json({ error: 'You can only view your own timetable' });
    req.subjectId = own; next();
  };
}
const q = req => ({ termId: req.query.term_id, past: req.query.past === 'true', levelId: req.query.level_id });
const send = (res, v) => (v.error ? res.status(v.status).json({ error: v.error }) : res.json(v));

router.get('/student/:id', authenticate, scoped('student'), async (req, res) => send(res, await E.buildView(req.db, 'student', req.subjectId, q(req))));
router.get('/lecturer/:id', authenticate, scoped('lecturer'), async (req, res) => send(res, await E.buildView(req.db, 'lecturer', req.subjectId, q(req))));
router.get('/room/:id', ...staff, async (req, res) => send(res, await E.buildView(req.db, 'room', req.params.id, q(req))));
router.get('/programme/:id', ...staff, async (req, res) => send(res, await E.buildView(req.db, 'programme', req.params.id, q(req))));

const ics = kind => async (req, res) => {
  const v = await E.buildView(req.db, kind, req.subjectId, { ...q(req), past: false });
  if (v.error) return res.status(v.status).json({ error: v.error });
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="timetable-${kind}-${v.term.name}.ics"` });
  res.send(E.renderIcs(v));
};
router.get('/student/:id/ics', authenticate, scoped('student'), ics('student'));
router.get('/lecturer/:id/ics', authenticate, scoped('lecturer'), ics('lecturer'));

router.get('/conflicts', ...staff, async (req, res) => send(res, await E.conflictsReport(req.db, req.query.term_id)));

// Lookups for the staff view selector.
router.get('/options', ...staff, async (req, res) => {
  const [terms, lecturers, rooms, programmes, levels] = await Promise.all([
    req.db.term.findMany({ include: { academic_year: { select: { label: true } } }, orderBy: { start_date: 'desc' } }),
    req.db.teacher.findMany({ select: { id: true, first_name: true, last_name: true }, orderBy: { last_name: 'asc' } }),
    req.db.room.findMany({ select: { id: true, code: true, name: true, capacity: true }, orderBy: { code: 'asc' } }),
    req.db.programme.findMany({ where: { is_active: true }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
    req.db.gradeLevel.findMany({ select: { id: true, name: true }, orderBy: { sort_order: 'asc' } }),
  ]);
  const cur = await T.resolveTerm(req.db);
  res.json({ current_term_id: cur?.id ?? null, terms: terms.map(t => ({ id: t.id, name: t.name, academic_year: t.academic_year.label, is_current: t.is_current })), lecturers: lecturers.map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}` })), rooms, programmes, levels });
});
router.get('/students', ...staff, async (req, res) => {
  const s = String(req.query.q || '').trim();
  if (s.length < 2) return res.json([]);
  const rows = await req.db.student.findMany({ where: { OR: [{ student_number: { contains: s, mode: 'insensitive' } }, { first_name: { contains: s, mode: 'insensitive' } }, { last_name: { contains: s, mode: 'insensitive' } }] }, take: 15, orderBy: { last_name: 'asc' } });
  res.json(rows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, matricule: r.student_number })));
});

module.exports = router;
