const router = require('express').Router();
const authenticate = require('../middleware/auth');

// GET /api/school
router.get('/', authenticate, async (req, res) => {
  const row = await req.db.school.findFirst();
  if (!row) return res.status(404).json({ error: 'School not found' });
  res.json(row);
});

// PUT /api/school
router.put('/', authenticate, async (req, res) => {
  const {
    name, code, address, phone, email, head_teacher, motto, logo_url,
    matricule_prefix, matricule_include_year, matricule_digits, matricule_separator,
  } = req.body;
  const data = { name, code, address, phone, email, head_teacher, motto, logo_url: logo_url ?? null, updated_at: new Date() };
  if (matricule_prefix !== undefined) data.matricule_prefix = matricule_prefix || 'BSPS';
  if (matricule_include_year !== undefined) data.matricule_include_year = !!matricule_include_year;
  if (matricule_digits !== undefined) data.matricule_digits = Math.min(6, Math.max(1, Number(matricule_digits) || 3));
  if (matricule_separator !== undefined) data.matricule_separator = matricule_separator ?? '';
  await req.db.school.update({ where: { id: 's1' }, data });
  res.json(await req.db.school.findFirst());
});

module.exports = router;
