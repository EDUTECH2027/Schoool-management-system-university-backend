require('dotenv').config();
require('express-async-errors');
const path      = require('path');
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const compression = require('compression');
const morgan    = require('morgan');
const bcrypt    = require('bcryptjs');
const { v4: uuid } = require('uuid');

const platformClient = require('./db/platformClient');
const { provisionTenantSchema } = require('./db/provisionTenant');
const errorHandler = require('./middleware/errorHandler');

async function bootstrap() {
  // ── Bootstrap a first platform admin if none exists ────────────────────────
  const platformAdminCount = await platformClient.platformAdmin.count();
  if (platformAdminCount === 0) {
    const email = process.env.PLATFORM_ADMIN_EMAIL || 'superadmin@platform.local';
    const password = process.env.PLATFORM_ADMIN_PASSWORD || 'SuperAdmin@2025';
    await platformClient.platformAdmin.create({
      data: { id: uuid(), name: 'Super Admin', email, password_hash: bcrypt.hashSync(password, 10), role: 'platform_owner', initials: 'SA' },
    });
    console.log(`[server] Bootstrapped platform owner account: ${email} / ${password}`);
  }

  // ── Bring every registered school's tenant schema up to date on boot ───────
  const schools = await platformClient.school.findMany({ select: { id: true } });
  for (const school of schools) {
    try {
      await provisionTenantSchema(school.id);
    } catch (e) {
      console.error(`[server] Failed to migrate tenant ${school.id}:`, e.message);
    }
  }
}

const authRouter         = require('./routes/auth');
const schoolRouter       = require('./routes/school');
const academicRouter     = require('./routes/academic');
const subjectsRouter     = require('./routes/subjects');
const teachersRouter     = require('./routes/teachers');
const classesRouter      = require('./routes/classes');
const studentsRouter     = require('./routes/students');
const parentsRouter      = require('./routes/parents');
const attendanceRouter   = require('./routes/attendance');
const timetableRouter    = require('./routes/timetable');
const marksRouter        = require('./routes/marks');
const marksSessionsRouter = require('./routes/marksSessions');
const passwordResetsRouter = require('./routes/passwordResets');
const transcriptsRouter  = require('./routes/transcripts');
const certificatesRouter = require('./routes/certificates');
const feesRouter         = require('./routes/fees');
const payrollRouter      = require('./routes/payroll');
const announcementsRouter = require('./routes/announcements');
const emailAlertsRouter  = require('./routes/emailAlerts');
const forumsRouter       = require('./routes/forums');
const dashboardRouter    = require('./routes/dashboard');
const usersRouter        = require('./routes/users');
const migrateRouter      = require('./routes/migrate');
const behaviorRouter     = require('./routes/behavior');
const withdrawalsRouter  = require('./routes/withdrawals');
const portalTeacherRouter = require('./routes/portal/teacher');
const portalStudentRouter = require('./routes/portal/student');
const portalParentRouter  = require('./routes/portal/parent');
const elearningRouter    = require('./routes/elearning');
const paymentsRouter     = require('./routes/payments');
const financeRouter      = require('./routes/finance');
const assessmentsRouter = require('./routes/assessments');
const servicesRouter = require('./routes/services');
const notificationCenterRouter = require('./routes/notificationCenter');
const libraryRouter = require('./routes/library');
const roomsRouter = require('./routes/rooms');
const timetableEngineRouter = require('./routes/timetableEngine');
const careersRouter = require('./routes/careers');
const thesisRouter = require('./routes/thesis');
const analyticsRouter = require('./routes/analytics');
const assistantRouter = require('./routes/assistant');
const securityRouter = require('./routes/security');
const academicsRouter    = require('./routes/academics');
const registrationRouter = require('./routes/registration');
const lecturerRouter     = require('./routes/lecturer');
const resultsRouter      = require('./routes/results');
const examsRouter        = require('./routes/exams');
const progressionRouter  = require('./routes/progression');
const documentsRouter    = require('./routes/documents');

// ── Platform (Super Admin) routes ───────────────────────────────────────────────
const platformDashboardRouter     = require('./routes/platform/dashboard');
const platformSchoolsRouter       = require('./routes/platform/schools');
const platformPlansRouter         = require('./routes/platform/plans');
const platformUsersRouter         = require('./routes/platform/users');
const platformLogsRouter          = require('./routes/platform/logs');
const platformAdminsRouter        = require('./routes/platform/admins');
const platformAnnouncementsRouter = require('./routes/platform/announcements');
const platformSettingsRouter      = require('./routes/platform/settings');
const platformBackupRouter        = require('./routes/platform/backup');
const platformReportsRouter       = require('./routes/platform/reports');
const platformFeaturesRouter      = require('./routes/platform/features');

// ── App ───────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware (see docs/SECURITY.md) ───────────────────────────────────
// Behind Render (or any reverse proxy) the client IP comes from X-Forwarded-For; trusting that header blindly would
// let anyone spoof their IP past the rate limiters, so it is only trusted when configured: TRUST_PROXY=<hops|true|csv>.
{
  const tp = process.env.TRUST_PROXY ?? (process.env.RENDER ? '1' : '');
  if (tp !== '') app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp === 'false' ? false : tp);
}
// CSP is applied to the JSON API only (default-src 'none'): the desktop build also serves the SPA from this server.
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false, referrerPolicy: { policy: 'no-referrer' }, hsts: process.env.NODE_ENV === 'production' }));
app.use('/api', (_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});
app.use(['/api/auth', '/api/security', '/api/assistant'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(cors({
  // CORS_ORIGINS="https://a.example,https://b.example" restricts browsers to those origins; unset = all origins (desktop + dev).
  origin: process.env.CORS_ORIGINS
    ? (origin, cb) => cb(null, !origin || process.env.CORS_ORIGINS.split(',').map(x => x.trim()).includes(origin))
    : (origin, cb) => cb(null, true),
  credentials: true,
  exposedHeaders: ['X-Has-More', 'Retry-After'],
}));
app.use(compression());   // gzip JSON/text responses (images and other pre-compressed types are skipped)
app.use(morgan('dev'));
// Provider webhooks first: Stripe needs the raw request body for signature verification.
require('./routes/paymentWebhooks').mount(app);
app.use('/api', require('./security/rateLimit').globalLimiter);   // generous per-IP limit; /health and webhooks excluded
{
  const secCfg = require('./security/config');
  const small = express.json({ limit: secCfg.jsonLimit() }), large = express.json({ limit: secCfg.jsonLimitLarge() });
  const LARGE = /^\/api\/(finance|migrate|platform|students|teachers|school|elearning|fees|payroll|notification-center)(\/|$)/;
  app.use((req, res, next) => (LARGE.test(req.path) ? large : small)(req, res, next));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
}
// Thumbnails first (/uploads/_t/<width>/…), then the originals. Stored names are random UUIDs, so a given
// URL's content never changes → cache for a year.
app.get('/uploads/_t/:width/*', require('./utils/thumbnails').handler);
app.use('/uploads', express.static(require('./utils/forumUploads').UPLOADS_ROOT, { maxAge: '365d', immutable: true }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/school',        schoolRouter);
app.use('/api/academic',      academicRouter);
app.use('/api/subjects',      subjectsRouter);
app.use('/api/teachers',      teachersRouter);
app.use('/api/classes',       classesRouter);
app.use('/api/students',      studentsRouter);
app.use('/api/parents',       parentsRouter);
app.use('/api/attendance',    attendanceRouter);
app.use('/api/timetable',     timetableRouter);
app.use('/api/marks',         marksRouter);
app.use('/api/marks-sessions', marksSessionsRouter);
app.use('/api/password-resets', passwordResetsRouter);
app.use('/api/transcripts',   transcriptsRouter);
app.use('/api/certificates',  certificatesRouter);
app.use('/api/fees',          feesRouter);
app.use('/api/payroll',       payrollRouter);
app.use('/api/announcements', announcementsRouter);
app.use('/api/email-alerts',  emailAlertsRouter);
app.use('/api/forums',        forumsRouter);
app.use('/api/dashboard',        dashboardRouter);
app.use('/api/users',            usersRouter);
app.use('/api/behavior',         behaviorRouter);
app.use('/api/withdrawals',      withdrawalsRouter);
app.use('/api/migrate',          migrateRouter);
app.use('/api/portal/teacher',   portalTeacherRouter);
app.use('/api/portal/student',   portalStudentRouter);
app.use('/api/portal/parent',    portalParentRouter);
app.use('/api/elearning',         elearningRouter);
app.use('/api/payments',          paymentsRouter);
app.use('/api/finance',           financeRouter);
app.use('/api/academics',         academicsRouter);
app.use('/api/registration',      registrationRouter);
app.use('/api/lecturer',          lecturerRouter);
app.use('/api/results',           resultsRouter);
app.use('/api/exams',             examsRouter);
app.use('/api/progression',       progressionRouter);
app.use('/api/documents',         documentsRouter);
app.use('/api/verify',            documentsRouter.verifyRouter);   // public: checks a document's verification code
app.use('/api/assessments', assessmentsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/notification-center', notificationCenterRouter);
app.use('/api/library', libraryRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/timetable-engine', timetableEngineRouter);
app.use('/api/careers', careersRouter);
app.use('/api/thesis', thesisRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/security', securityRouter);

// ── Platform (Super Admin) routes ───────────────────────────────────────────────
app.use('/api/platform/dashboard',     platformDashboardRouter);
app.use('/api/platform/schools',       platformSchoolsRouter);
app.use('/api/platform/plans',         platformPlansRouter);
app.use('/api/platform/users',         platformUsersRouter);
app.use('/api/platform/logs',          platformLogsRouter);
app.use('/api/platform/admins',        platformAdminsRouter);
app.use('/api/platform/announcements', platformAnnouncementsRouter);
app.use('/api/platform/settings',      platformSettingsRouter);
app.use('/api/platform/backup',        platformBackupRouter);
app.use('/api/platform/reports',       platformReportsRouter);
app.use('/api/platform/features',      platformFeaturesRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Desktop mode: serve built React frontend ──────────────────────────────────
if (process.env.FRONTEND_PATH) {
  const feDir = process.env.FRONTEND_PATH;
  app.use(express.static(feDir));
  app.get(/^(?!\/api)/, (_req, res) =>
    res.sendFile(path.join(feDir, 'index.html'))
  );
}

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';
bootstrap()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`\n🚀  School Management API running on http://localhost:${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/api/health`);
      console.log(`   Docs:   see README for full endpoint list\n`);
      if (process.env.ELEARNING_REMINDERS !== 'off') require('./utils/reminders').start();
      if (process.env.PAYMENT_RECONCILER !== 'off') require('./payments/reconciler').start();
      // Signal Electron main process that the server is ready
      if (process.send) process.send({ type: 'ready', port: Number(PORT) });
    });
  })
  .catch((e) => {
    console.error('[server] Bootstrap failed:', e);
    process.exit(1);
  });

module.exports = app;
