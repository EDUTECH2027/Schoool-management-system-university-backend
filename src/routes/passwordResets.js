const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');

const guard = [authenticate, authorize('super_admin')];

// GET /api/password-resets
router.get('/', ...guard, async (req, res) => {
  res.json(await req.db.passwordResetRequest.findMany({ orderBy: { requested_at: 'desc' } }));
});

// PATCH /api/password-resets/:id/approve — authorizes one self-service
// password reset for this email; does not set a password itself.
router.patch('/:id/approve', ...guard, async (req, res) => {
  const reqst = await req.db.passwordResetRequest.findUnique({ where: { id: req.params.id } });
  if (!reqst) return res.status(404).json({ error: 'Request not found' });
  if (reqst.status !== 'pending') return res.status(409).json({ error: 'Request is no longer pending' });
  const updated = await req.db.passwordResetRequest.update({
    where: { id: req.params.id },
    data: { status: 'approved', approved_at: new Date(), approved_by: req.user.name || req.user.email || null },
  });
  res.json(updated);
});

// PATCH /api/password-resets/:id/dismiss
router.patch('/:id/dismiss', ...guard, async (req, res) => {
  const reqst = await req.db.passwordResetRequest.findUnique({ where: { id: req.params.id } });
  if (!reqst) return res.status(404).json({ error: 'Request not found' });
  if (reqst.status !== 'pending') return res.status(409).json({ error: 'Request is no longer pending' });
  const updated = await req.db.passwordResetRequest.update({ where: { id: req.params.id }, data: { status: 'dismissed' } });
  res.json(updated);
});

module.exports = router;
