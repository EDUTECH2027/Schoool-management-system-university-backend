const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const authenticate = require('../middleware/auth');
const { loginEmailFor } = require('../utils/matricule');
const cfg = require('../security/config');
const { checkPassword } = require('../security/policy');
const { logEvent, clientIp } = require('../security/events');
const { attemptLimiter, failGate, identity, deny } = require('../security/rateLimit');
const { SlidingWindow } = require('../security/limiter');
const sessions = require('../security/sessions');

const SECRET = () => process.env.JWT_SECRET || 'dev_secret';
const EXPIRES = () => process.env.JWT_EXPIRES_IN || '24h';
// Compared against when the account does not exist, so response time does not reveal whether it does.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = attemptLimiter('login', cfg.loginIp, cfg.loginAccount);
const resetLimiter = attemptLimiter('reset', cfg.resetIp, cfg.resetAccount);

const lockedResponse = (res, ms) => {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  res.set('Retry-After', String(secs));
  return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${Math.ceil(secs / 60)} minute(s).`, code: 'locked', retry_after_seconds: secs });
};
const invalidCreds = res => res.status(401).json({ error: 'Invalid email or password' });
const tenantPayload = (user, schoolId, mustChange) => ({
  id: user.id, email: user.email, role: user.role, name: user.name,
  initials: user.initials,
  teacher_id: user.teacher_id || null,
  student_id: user.student_id || null,
  parent_id: user.parent_id || null,
  school_id: schoolId,
  scope: 'tenant',
  must_change_password: mustChange,
});
const weak = (res, msg) => res.status(422).json({ error: msg, code: 'weak_password' });

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

/** Records a failed password attempt on a real account; locks it at LOGIN_MAX_FAILURES. Returns the failure count. */
async function recordFailure(db, user, req, reason) {
  const max = cfg.loginMaxFailures();
  const upd = await db.user.update({ where: { id: user.id }, data: { failed_logins: { increment: 1 } }, select: { failed_logins: true } });
  failGate.failIp(req);
  let locked = false;
  if (upd.failed_logins >= max) {
    const until = new Date(Date.now() + cfg.loginLockMinutes() * 60_000);
    await db.user.update({ where: { id: user.id }, data: { locked_until: until, failed_logins: 0 } });
    locked = true;
    await logEvent(db, { type: 'account_locked', user_id: user.id, email: user.email, req, detail: { failures: upd.failed_logins, locked_until: until.toISOString() } });
  }
  await logEvent(db, { type: 'login_failed', user_id: user.id, email: user.email, req, detail: { reason, failures: upd.failed_logins, locked } });
  return upd.failed_logins;
}
const lockRemainingMs = user => (user.locked_until ? new Date(user.locked_until).getTime() - Date.now() : 0);

// POST /api/auth/login
// Checks platform admins first, then routes to the correct tenant schema via the
// cross-tenant email -> school_id directory (see prisma/platform/schema.prisma).
router.post('/login',
  loginLimiter,
  // Note: no .normalizeEmail() here — it lowercases *and* strips gmail dots/subaddresses,
  // which would silently diverge from whatever case the email was stored in at write time.
  // Lookups below use a case-insensitive filter instead, so login is case-insensitive
  // without mutating input.
  body('email').isEmail().trim(),
  body('password').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, password } = req.body;
    const idKey = `e:${email.toLowerCase()}`;
    const ipBlock = failGate.blockedIp(req);
    if (ipBlock) return deny(req, res, 'login:failures', ipBlock.retryAfterMs, 'Too many failed attempts from this address. Please try again later.');

    // Accounts that have no tenant row (platform admins, unknown e-mails) share one in-memory lockout, so both
    // behave exactly like an unknown address: 401 until the threshold, then 429.
    const lockMs = identity.retryMs(idKey);
    const platformAdmin = await platformClient.platformAdmin.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (platformAdmin) {
      if (lockMs) return lockedResponse(res, lockMs);
      if (!bcrypt.compareSync(password, platformAdmin.password_hash)) {
        identity.fail(idKey); failGate.failIp(req);
        return invalidCreds(res);
      }
      identity.clear(idKey);
      const payload = {
        id: platformAdmin.id, email: platformAdmin.email, role: platformAdmin.role,
        name: platformAdmin.name, initials: platformAdmin.initials, scope: 'platform',
      };
      const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
      return res.json({ token, user: payload });
    }

    const unknown = () => { bcrypt.compareSync(password, DUMMY_HASH); identity.fail(idKey); failGate.failIp(req); return invalidCreds(res); };
    const dirEntry = await platformClient.userDirectory.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!dirEntry) return lockMs ? lockedResponse(res, lockMs) : unknown();

    const school = await platformClient.school.findUnique({
      where: { id: dirEntry.school_id },
      select: { status: true },
    });
    if (!school || school.status !== 'active') return res.status(403).json({ error: 'School account is not active' });

    const tenantDb = tenantPool.getOrOpen(dirEntry.school_id);
    const user = await tenantDb.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!user) return lockMs ? lockedResponse(res, lockMs) : unknown();

    const remaining = lockRemainingMs(user);
    if (remaining > 0) {
      await logEvent(tenantDb, { type: 'login_failed', user_id: user.id, email: user.email, req, detail: { reason: 'locked' } });
      return lockedResponse(res, remaining);
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      await recordFailure(tenantDb, user, req, 'bad_password');
      return invalidCreds(res);
    }
    if (user.failed_logins > 0 || user.locked_until) {
      await tenantDb.user.update({ where: { id: user.id }, data: { failed_logins: 0, locked_until: null } });
    }
    await logEvent(tenantDb, { type: 'login_success', user_id: user.id, email: user.email, req, detail: { method: 'password' } });

    const payload = tenantPayload(user, dirEntry.school_id, !!user.must_change_password);
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
// password_hash is never checked here. Because there is no secret, brute-forcing matricules is
// slowed by the per-IP failure gate, and a locked account (locked_until) is honoured here too.
router.post('/student-login',
  body('studentId').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const ipBlock = failGate.blockedIp(req);
    if (ipBlock) return deny(req, res, 'login:failures', ipBlock.retryAfterMs, 'Too many failed attempts from this address. Please try again later.');
    const bad = () => { failGate.failIp(req); return res.status(401).json({ error: 'Invalid Student ID' }); };

    const loginEmail = loginEmailFor(req.body.studentId);

    const dirEntry = await platformClient.userDirectory.findFirst({
      where: { email: { equals: loginEmail, mode: 'insensitive' } },
    });
    if (!dirEntry) return bad();

    const school = await platformClient.school.findUnique({
      where: { id: dirEntry.school_id },
      select: { status: true },
    });
    if (!school || school.status !== 'active') return res.status(403).json({ error: 'School account is not active' });

    const tenantDb = tenantPool.getOrOpen(dirEntry.school_id);
    const user = await tenantDb.user.findFirst({
      where: { email: { equals: loginEmail, mode: 'insensitive' }, role: 'student' },
    });
    if (!user) return bad();

    const remaining = lockRemainingMs(user);
    if (remaining > 0) {
      await logEvent(tenantDb, { type: 'login_failed', user_id: user.id, email: user.email, req, detail: { reason: 'locked', method: 'matricule' } });
      return lockedResponse(res, remaining);
    }
    await logEvent(tenantDb, { type: 'login_success', user_id: user.id, email: user.email, req, detail: { method: 'matricule' } });

    const payload = tenantPayload({ ...user, teacher_id: null, parent_id: null }, dirEntry.school_id, false);
    const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
    res.json({ token, user: payload });
  }
);

// POST /api/auth/forgot-password
// Raises a request the school's own admin reviews (Settings → Password Reset
// Requests). Always responds with the same generic message, whether or not
// the email exists, so this can't be used to enumerate accounts.
router.post('/forgot-password',
  resetLimiter,
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
router.get('/reset-status', resetLimiter, async (req, res) => {
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
  resetLimiter,
  body('email').isEmail().trim(),
  body('newPassword').isString().notEmpty(),
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

    const problem = checkPassword(req.body.newPassword, { email: found.user.email, name: found.user.name });
    if (problem) return weak(res, problem);

    const now = new Date();
    const hash = bcrypt.hashSync(req.body.newPassword, 10);
    await found.tenantDb.user.update({
      where: { id: found.user.id },
      data: { password_hash: hash, must_change_password: false, password_changed_at: now, failed_logins: 0, locked_until: null, updated_at: now },
    });
    await found.tenantDb.passwordResetRequest.update({ where: { id: approved.id }, data: { status: 'resolved' } });
    sessions.markChanged(found.schoolId, found.user.id, now);
    identity.clear(`e:${found.user.email.toLowerCase()}`);
    await logEvent(found.tenantDb, { type: 'password_changed', user_id: found.user.id, email: found.user.email, req, detail: { by: 'reset_request' } });

    const payload = tenantPayload(found.user, found.schoolId, false);
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
// Wrong "current password" attempts count towards the lockout like failed logins do (a stolen token alone must
// not be enough to brute-force the password). Tokens issued before the change stop working — except the one used
// for this request; the response also carries a fresh token.
const changeWin = new SlidingWindow();
router.put('/me/password',
  authenticate,
  body('currentPassword').isString().notEmpty(),
  body('newPassword').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
    const w = changeWin.hit(`${req.user.school_id}:${req.user.id}`, 20, 900_000);
    if (!w.allowed) return deny(req, res, 'password_change', w.retryAfterMs);

    const user = await req.db.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const remaining = lockRemainingMs(user);
    if (remaining > 0) return lockedResponse(res, remaining);
    if (!bcrypt.compareSync(req.body.currentPassword, user.password_hash)) {
      await recordFailure(req.db, user, req, 'bad_current_password');
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const problem = checkPassword(req.body.newPassword, { email: user.email, name: user.name, current: req.body.currentPassword });
    if (problem) return weak(res, problem);

    const now = new Date();
    const hash = bcrypt.hashSync(req.body.newPassword, 10);
    await req.db.user.update({
      where: { id: req.user.id },
      data: { password_hash: hash, must_change_password: false, password_changed_at: now, failed_logins: 0, locked_until: null, updated_at: now },
    });
    sessions.markChanged(req.user.school_id, req.user.id, now, { token: req.headers.authorization.slice(7), exp: req.user.exp });
    await logEvent(req.db, { type: 'password_changed', user_id: user.id, email: user.email, req, detail: { by: 'self' } });
    const payload = tenantPayload(user, req.user.school_id, false);
    const token = jwt.sign(payload, SECRET(), { expiresIn: EXPIRES() });
    res.json({ message: 'Password updated', token, user: payload });
  }
);

module.exports = router;
