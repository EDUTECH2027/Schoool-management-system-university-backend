const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const authenticate = require('../middleware/auth');
const { loginEmailFor } = require('../utils/matricule');

const SECRET = () => process.env.JWT_SECRET || 'dev_secret';
const EXPIRES = () => process.env.JWT_EXPIRES_IN || '24h';

// Shared by /forgot-password, /reset-status and /reset-password — resolves an
// email to its tenant db + user row via the cross-tenant directory, the same
// way /login does. Returns null if the email isn't a real tenant user.
async function findTenantUser(email) {
  const dirEntry = await platformClient.userDirectory.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });
  if (!dirEntry) return null;
  const tenantDb = tenantPool.getOrOpen(dirEntry.school_id);
  const user = await tenantDb.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (!user) return null;
  return { tenantDb, user, schoolId: dirEntry.school_id };
}

// POST /api/auth/login
// Checks platform admins first, then routes to the correct tenant schema via the
// cross-tenant email -> school_id directory (see prisma/platform/schema.prisma).
router.post('/login',
  // Note: no .normalizeEmail() here — it lowercases *and* strips gmail dots/subaddresses,
  // which would silently diverge from whatever case the email was stored in at write time.
  // Lookups below use a case-insensitive filter instead, so login is case-insensitive
  // without mutating input.
  body('email').isEmail().trim(),
  body('password').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, password } = req.body;

    const platformAdmin = await platformClient.platformAdmin.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (platformAdmin) {
      if (!bcrypt.compareSync(password, platformAdmin.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const payload = {
        id: platformAdmin.id, email: platformAdmin.email, role: platformAdmin.role,
        name: platformAdmin.name, initials: platformAdmin.initials, scope: 'platform',
      };
      const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
      return res.json({ token, user: payload });
    }

    const dirEntry = await platformClient.userDirectory.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!dirEntry) return res.status(401).json({ error: 'Invalid email or password' });

    const school = await platformClient.school.findUnique({
      where: { id: dirEntry.school_id },
      select: { status: true },
    });
    if (!school || school.status !== 'active') return res.status(403).json({ error: 'School account is not active' });

    const tenantDb = tenantPool.getOrOpen(dirEntry.school_id);
    const user = await tenantDb.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const payload = {
      id: user.id, email: user.email, role: user.role, name: user.name,
      initials: user.initials,
      teacher_id: user.teacher_id || null,
      student_id: user.student_id || null,
      parent_id: user.parent_id || null,
      school_id: dirEntry.school_id,
      scope: 'tenant',
      must_change_password: !!user.must_change_password,
    };
    const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
    res.json({ token, user: payload });
  }
);

// POST /api/auth/student-login
// Matricule-only login: no password, by design (student choice — matricules
// aren't treated as secret, they're printed on ID cards/class lists). Reuses
// the synthetic email every student portal account is created with
// (studentEmailFor() in Login.tsx, mirrored in routes/students.js and
// routes/migrate.js) purely to resolve the tenant + user row; the account's
// password_hash is never checked here.
router.post('/student-login',
  body('studentId').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const loginEmail = loginEmailFor(req.body.studentId);

    const dirEntry = await platformClient.userDirectory.findFirst({
      where: { email: { equals: loginEmail, mode: 'insensitive' } },
    });
    if (!dirEntry) return res.status(401).json({ error: 'Invalid Student ID' });

    const school = await platformClient.school.findUnique({
      where: { id: dirEntry.school_id },
      select: { status: true },
    });
    if (!school || school.status !== 'active') return res.status(403).json({ error: 'School account is not active' });

    const tenantDb = tenantPool.getOrOpen(dirEntry.school_id);
    const user = await tenantDb.user.findFirst({
      where: { email: { equals: loginEmail, mode: 'insensitive' }, role: 'student' },
    });
    if (!user) return res.status(401).json({ error: 'Invalid Student ID' });

    const payload = {
      id: user.id, email: user.email, role: user.role, name: user.name,
      initials: user.initials,
      teacher_id: null,
      student_id: user.student_id || null,
      parent_id: null,
      school_id: dirEntry.school_id,
      scope: 'tenant',
      must_change_password: false,
    };
    const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
    res.json({ token, user: payload });
  }
);

// POST /api/auth/forgot-password
// Raises a request the school's own admin reviews (Settings → Password Reset
// Requests). Always responds with the same generic message, whether or not
// the email exists, so this can't be used to enumerate accounts.
router.post('/forgot-password',
  body('email').isEmail().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const generic = { message: 'If that email exists, a request has been sent to your school admin.' };
    const found = await findTenantUser(req.body.email);
    if (!found) return res.json(generic);

    const existing = await found.tenantDb.passwordResetRequest.findFirst({
      where: { email: { equals: req.body.email, mode: 'insensitive' }, status: 'pending' },
    });
    if (!existing) {
      await found.tenantDb.passwordResetRequest.create({
        data: { id: uuid(), email: req.body.email.trim() },
      });
    }
    res.json(generic);
  }
);

// GET /api/auth/reset-status?email=  — lets the login screen know whether an
// admin has already approved a reset for this email, so it can switch
// straight to "create a new password" without asking for the old one.
router.get('/reset-status', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.json({ canReset: false });
  const found = await findTenantUser(email);
  if (!found) return res.json({ canReset: false });
  const approved = await found.tenantDb.passwordResetRequest.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, status: 'approved' },
  });
  res.json({ canReset: !!approved });
});

// POST /api/auth/reset-password  — the self-service step: no old/temp
// password needed, only that an admin approved a pending request for this
// email. Logs the user straight in on success, same as a normal login.
router.post('/reset-password',
  body('email').isEmail().trim(),
  body('newPassword').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const found = await findTenantUser(req.body.email);
    if (!found) return res.status(400).json({ error: 'No approved password reset for this email' });

    const approved = await found.tenantDb.passwordResetRequest.findFirst({
      where: { email: { equals: req.body.email, mode: 'insensitive' }, status: 'approved' },
      orderBy: { approved_at: 'desc' },
    });
    if (!approved) return res.status(400).json({ error: 'No approved password reset for this email' });

    const hash = bcrypt.hashSync(req.body.newPassword, 10);
    await found.tenantDb.user.update({
      where: { id: found.user.id },
      data: { password_hash: hash, must_change_password: false, updated_at: new Date() },
    });
    await found.tenantDb.passwordResetRequest.update({ where: { id: approved.id }, data: { status: 'resolved' } });

    const payload = {
      id: found.user.id, email: found.user.email, role: found.user.role, name: found.user.name,
      initials: found.user.initials,
      teacher_id: found.user.teacher_id || null,
      student_id: found.user.student_id || null,
      parent_id: found.user.parent_id || null,
      school_id: found.schoolId,
      scope: 'tenant',
      must_change_password: false,
    };
    const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
    res.json({ token, user: payload });
  }
);

// POST /api/auth/logout  (stateless — client discards token)
router.post('/logout', (_req, res) => res.json({ message: 'Logged out' }));

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  const user = await req.db.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, email: true, role: true, initials: true,
      teacher_id: true, student_id: true, parent_id: true, must_change_password: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// PUT /api/auth/me/password
router.put('/me/password',
  authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const user = await req.db.user.findUnique({ where: { id: req.user.id } });
    if (!bcrypt.compareSync(req.body.currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = bcrypt.hashSync(req.body.newPassword, 10);
    await req.db.user.update({
      where: { id: req.user.id },
      data: { password_hash: hash, must_change_password: false, updated_at: new Date() },
    });
    res.json({ message: 'Password updated' });
  }
);

module.exports = router;
