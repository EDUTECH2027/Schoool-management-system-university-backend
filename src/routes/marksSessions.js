const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');

const adminGuard = [authenticate, authorize('super_admin')];

// GET /api/marks-sessions — history, most recent first. Any authenticated
// tenant user may read (teachers need this to know whether filling is open).
router.get('/', authenticate, async (req, res) => {
  res.json(await req.db.marksSession.findMany({ orderBy: { start_at: 'desc' } }));
});

// GET /api/marks-sessions/current — the session covering right now, if any,
// plus a plain isOpen flag so callers don't need to compare dates themselves.
router.get('/current', authenticate, async (req, res) => {
  const now = new Date();
  const session = await req.db.marksSession.findFirst({
    where: { start_at: { lte: now }, end_at: { gte: now } },
    orderBy: { start_at: 'desc' },
  });
  res.json({ isOpen: !!session, session });
});

// POST /api/marks-sessions — admin opens a new window.
router.post('/', ...adminGuard, async (req, res) => {
  const { label, startAt, endAt } = req.body;
  if (!startAt || !endAt) return res.status(422).json({ error: 'startAt and endAt required' });
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return res.status(422).json({ error: 'Invalid date' });
  if (end <= start) return res.status(422).json({ error: 'endAt must be after startAt' });

  const created = await req.db.marksSession.create({
    data: { id: uuid(), label: label || null, start_at: start, end_at: end, created_by: req.user.name || req.user.email || null },
  });
  res.status(201).json(created);
});

// PATCH /api/marks-sessions/:id/close — admin ends a window early by pulling
// end_at up to now (a no-op if it already ended).
router.patch('/:id/close', ...adminGuard, async (req, res) => {
  const session = await req.db.marksSession.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const now = new Date();
  const updated = await req.db.marksSession.update({
    where: { id: req.params.id },
    data: { end_at: now < session.end_at ? now : session.end_at },
  });
  res.json(updated);
});

module.exports = router;
