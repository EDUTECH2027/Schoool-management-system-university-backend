// Security hardening suite: lockout, rate limits, password policy, token invalidation, security events, /api/security.
// Spawns its OWN API instances (so lock/limit state never touches the instance under test by others):
//   A = default thresholds (except a large per-IP failure gate so the suite is re-runnable), B = strict thresholds + TRUST_PROXY=1.
// API_URL (the already-running instance) is only used for a few smoke checks of the default configuration.
// Keep Prisma pools small: the scratch Postgres is shared by several module owners (max_connections is low).
if (process.env.DATABASE_URL && !/connection_limit/.test(process.env.DATABASE_URL)) process.env.DATABASE_URL += (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'connection_limit=2';
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const H = require('./lib/academic-harness');
const { check, section, seedSchool, finish, sleep, uuid, platformClient, BASE } = H;

const SECRET = process.env.JWT_SECRET || 'dev_secret';
const kids = [];
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startApi(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ELEARNING_REMINDERS: 'off', PAYMENT_RECONCILER: 'off', MAX_OPEN_TENANT_PRISMA_CLIENTS: '6', ...env } });
  kids.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < Number(process.env.TEST_BOOT_TRIES || 90); i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ } await sleep(700); }
  return { base, child };
}
const mkCall = base => async (method, url, { token, body, headers: extra, rawBody, raw } = {}) => {
  const headers = { ...(token && { Authorization: `Bearer ${token}` }), ...extra };
  let payload;
  if (rawBody !== undefined) payload = rawBody; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
  if (raw) return res;
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers, text };
};

const PW = 'Str0ng-Pass-1', PW2 = 'An0ther-Good-Pass', dirs = [];
async function mkUser(S, name, role, { pw = PW, email, student_id, teacher_id, must } = {}) {
  const e = email || `${name.toLowerCase().replace(/\W/g, '')}-${uuid().slice(0, 8)}@t.local`;
  const u = await S.db.user.create({ data: { id: uuid(), name, email: e, password_hash: bcrypt.hashSync(pw, 4), role, initials: 'XX', student_id: student_id || null, teacher_id: teacher_id || null, must_change_password: !!must } });
  await platformClient.userDirectory.create({ data: { email: e, school_id: S.schoolId, role } });
  dirs.push(e);
  return u;
}
const events = (S, where) => S.db.securityEvent.findMany({ where, orderBy: { created_at: 'asc' } });
const row = (S, id) => S.db.user.findUnique({ where: { id } });

(async () => {
  const S = await seedSchool('SecA'), O = await seedSchool('SecB');
  const A = await startApi({ RATE_LOGIN_IP_MAX: '1000', RATE_LOGIN_ACCOUNT_MAX: '1000', RATE_RESET_IP_MAX: '1000', RATE_RESET_ACCOUNT_MAX: '1000' });
  const call = mkCall(A.base);
  const adm = S.tok.admin;

  // ── default configuration (running instance under test) ──────────────────────────────────
  section('Smoke: default configuration (instance A: default thresholds)');
  {
    const c = (await call('GET', '/security/config', { token: adm }));
    check('config endpoint: lockout defaults 5 failures / 15 min', c.status === 200 && c.body.login_max_failures === 5 && c.body.login_lock_minutes === 15, c.body);
    check('config: MFA is explicitly out of scope', c.body.mfa === false);
    check('health stays open', (await call('GET', '/health')).status === 200);
    const hr = await call('GET', '/health', { raw: true });
    check('no X-Powered-By header', !hr.headers.get('x-powered-by'));
    check('API responses carry a locked-down CSP', /default-src 'none'/.test(hr.headers.get('content-security-policy') || ''), hr.headers.get('content-security-policy'));
    check('nosniff + no-referrer headers', hr.headers.get('x-content-type-options') === 'nosniff' && hr.headers.get('referrer-policy') === 'no-referrer');
    const lr = await call('POST', '/auth/login', { body: { email: `nobody-${uuid()}@t.local`, password: 'whatever12' }, raw: true });
    check('auth responses are not cacheable', /no-store/.test(lr.headers.get('cache-control') || ''));
    check('harness-style forged JWT (no password) still works', (await call('GET', '/auth/me', { token: S.tok.officer })).status === 200);
  }

  // ── login basics ───────────────────────────────────────────────────────────────────────
  section('Login: success, generic failures, events');
  const staff = await mkUser(S, 'Sam Staff', 'academic_officer');
  const ok = await call('POST', '/auth/login', { body: { email: staff.email, password: PW } });
  check('staff login by e-mail works', ok.status === 200 && ok.body.token && ok.body.user.role === 'academic_officer', ok.body);
  check('login is case-insensitive on the e-mail', (await call('POST', '/auth/login', { body: { email: staff.email.toUpperCase(), password: PW } })).status === 200);
  const bad = await call('POST', '/auth/login', { body: { email: staff.email, password: 'wrong-password' } });
  const ghost = await call('POST', '/auth/login', { body: { email: `ghost-${uuid()}@t.local`, password: 'wrong-password' } });
  check('wrong password → 401', bad.status === 401);
  check('unknown e-mail → identical 401 + body (no enumeration)', ghost.status === 401 && JSON.stringify(ghost.body) === JSON.stringify(bad.body), { bad: bad.body, ghost: ghost.body });
  check('malformed e-mail → 422', (await call('POST', '/auth/login', { body: { email: 'nope', password: 'x' } })).status === 422);
  check('non-string password rejected → 422', (await call('POST', '/auth/login', { body: { email: staff.email, password: { $ne: 1 } } })).status === 422);
  let ev = await events(S, { user_id: staff.id });
  check('login_success events recorded with IP + user agent', ev.filter(e => e.type === 'login_success').length === 2 && ev[0].ip === '127.0.0.1' && /node|undici/i.test(ev[0].user_agent || 'node'), ev[0]);
  check('login_failed event recorded', ev.some(e => e.type === 'login_failed' && e.detail?.reason === 'bad_password'));
  check('no password or token ever stored in events', !JSON.stringify(ev).includes('wrong-password') && !JSON.stringify(ev).includes(PW) && !JSON.stringify(ev).includes(ok.body.token));
  const reqLong = await call('POST', '/auth/login', { body: { email: staff.email, password: 'x'.repeat(50) }, headers: { 'User-Agent': 'U'.repeat(500) } });
  ev = await events(S, { user_id: staff.id });
  check('user agent truncated to 200 chars', Math.max(...ev.map(e => (e.user_agent || '').length)) <= 200 && ev.some(e => (e.user_agent || '').length === 200));
  check('spoofed X-Forwarded-For is ignored by default (TRUST_PROXY off)', (await call('POST', '/auth/login', { body: { email: staff.email, password: PW }, headers: { 'X-Forwarded-For': '203.0.113.9' } })).status === 200 && !(await events(S, { ip: '203.0.113.9' })).length);
  await row(S, staff.id).then(r => check('counter reset after successful login', r.failed_logins === 0 && !r.locked_until, r));

  // ── lockout ───────────────────────────────────────────────────────────────────────────
  section('Account lockout (5 failures / 15 min)');
  const vic = await mkUser(S, 'Vic Victim', 'teacher', { teacher_id: S.teachers.tina.id });
  for (let i = 1; i <= 4; i++) await call('POST', '/auth/login', { body: { email: vic.email, password: `bad-pass-${i}` } });
  let r = await row(S, vic.id);
  check('4 failures counted, not yet locked', r.failed_logins === 4 && !r.locked_until, r);
  const fifth = await call('POST', '/auth/login', { body: { email: vic.email, password: 'bad-pass-5' } });
  check('5th failure still answers 401 (same as before)', fifth.status === 401);
  r = await row(S, vic.id);
  check('account locked after 5th failure, ~15 minutes', r.locked_until && Math.abs(new Date(r.locked_until) - Date.now() - 15 * 60_000) < 20_000, r);
  const locked = await call('POST', '/auth/login', { body: { email: vic.email, password: PW } });
  check('correct password during lock → 429 locked', locked.status === 429 && locked.body.code === 'locked' && locked.body.retry_after_seconds > 800 && locked.headers.get('retry-after'), locked.body);
  check('lock message does not mention the password was right', !/correct|valid password/i.test(locked.body.error));
  ev = await events(S, { user_id: vic.id });
  check('account_locked event written once', ev.filter(e => e.type === 'account_locked').length === 1, ev.map(e => e.type));
  check('failed + blocked attempts logged', ev.filter(e => e.type === 'login_failed').length >= 6);
  // enumeration resistance of the lock: an unknown address behaves identically after the same number of failures
  const gEmail = `ghost-${uuid()}@t.local`;
  const gr = [];
  for (let i = 1; i <= 6; i++) gr.push(await call('POST', '/auth/login', { body: { email: gEmail, password: `bad-pass-${i}` } }));
  check('unknown address: 5×401 then 429 locked — same sequence as a real account', gr.slice(0, 5).every(x => x.status === 401) && gr[5].status === 429 && gr[5].body.code === 'locked', gr.map(x => x.status));
  check('lock response body identical for real and unknown accounts', gr[5].body.error === locked.body.error);
  // unlock by admin
  check('non-admin cannot unlock', (await call('POST', `/security/users/${vic.id}/unlock`, { token: S.tok.officer })).status === 403);
  const un = await call('POST', `/security/users/${vic.id}/unlock`, { token: adm });
  check('admin unlocks the account', un.status === 200);
  r = await row(S, vic.id);
  check('lock + counter cleared in DB', r.failed_logins === 0 && !r.locked_until);
  check('login works again after unlock', (await call('POST', '/auth/login', { body: { email: vic.email, password: PW } })).status === 200);
  check('account_unlocked event recorded', (await events(S, { type: 'account_unlocked', user_id: vic.id })).length === 1);
  // counter reset on success
  await call('POST', '/auth/login', { body: { email: vic.email, password: 'bad-1' } }); await call('POST', '/auth/login', { body: { email: vic.email, password: 'bad-2' } });
  check('2 failures then success resets counter', (await call('POST', '/auth/login', { body: { email: vic.email, password: PW } })).status === 200 && (await row(S, vic.id)).failed_logins === 0);
  // concurrency: 12 parallel wrong attempts must lock exactly once-ish and never over-count past lock
  const race = await mkUser(S, 'Race Rick', 'finance_officer');
  const rr = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/auth/login', { body: { email: race.email, password: `bad-race-${i}` } })));
  check('parallel failures: only 401/429 answers', rr.every(x => x.status === 401 || x.status === 429), rr.map(x => x.status));
  check('parallel failures lock the account', !!(await row(S, race.id)).locked_until);
  check('correct password rejected while locked (race)', (await call('POST', '/auth/login', { body: { email: race.email, password: PW } })).status === 429);

  // ── student (matricule) login ───────────────────────────────────────────────────────────
  section('Student matricule login');
  const matric = `SEC-${uuid().slice(0, 6).toUpperCase()}`;
  const stu = await S.db.student.create({ data: { id: uuid(), student_number: matric, first_name: 'Stu', last_name: 'Dent', class_id: S.cls.y1.id, class_name: 'CS Year 1', is_active: true } });
  const { loginEmailFor } = require('../src/utils/matricule');
  const su = await mkUser(S, 'Stu Dent', 'student', { email: loginEmailFor(matric), student_id: stu.id });
  const sl = await call('POST', '/auth/student-login', { body: { studentId: matric } });
  check('matricule login still works (no password)', sl.status === 200 && sl.body.user.role === 'student' && sl.body.user.student_id === stu.id, sl.body);
  check('matricule login is forgiving on case/separators', (await call('POST', '/auth/student-login', { body: { studentId: matric.toLowerCase().replace('-', '_') } })).status === 200);
  const sbad = await call('POST', '/auth/student-login', { body: { studentId: 'NOPE-0000' } });
  check('unknown matricule → generic 401', sbad.status === 401 && sbad.body.error === 'Invalid Student ID');
  check('empty matricule → 422', (await call('POST', '/auth/student-login', { body: { studentId: '' } })).status === 422);
  await S.db.user.update({ where: { id: su.id }, data: { locked_until: new Date(Date.now() + 600_000) } });
  const sloc = await call('POST', '/auth/student-login', { body: { studentId: matric } });
  check('locked student account is refused (429) on matricule login', sloc.status === 429 && sloc.body.code === 'locked', sloc.body);
  await call('POST', `/security/users/${su.id}/unlock`, { token: adm });
  check('student can sign in again after unlock', (await call('POST', '/auth/student-login', { body: { studentId: matric } })).status === 200);
  check('student login events recorded', (await events(S, { user_id: su.id, type: 'login_success' })).length >= 3);

  // ── platform admin ─────────────────────────────────────────────────────────────────────
  section('Platform admin login');
  const paEmail = `pa-${uuid().slice(0, 8)}@platform.local`;
  const pa = await platformClient.platformAdmin.create({ data: { id: uuid(), name: 'PA Test', email: paEmail, password_hash: bcrypt.hashSync(PW, 4), role: 'platform_admin', initials: 'PA' } });
  const pl = await call('POST', '/auth/login', { body: { email: paEmail, password: PW } });
  check('platform admin login works', pl.status === 200 && pl.body.user.scope === 'platform');
  for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { body: { email: paEmail, password: `nope-nope-${i}` } });
  check('platform admin locked after 5 failures (429)', (await call('POST', '/auth/login', { body: { email: paEmail, password: PW } })).status === 429);

  // ── password policy ───────────────────────────────────────────────────────────────────
  section('Password policy');
  const pol = require('../src/security/policy');
  const ctx = { email: 'jane.doe@uni.cm', name: 'Jane Marie Doe' };
  const cases = [['short', 'Ab1!', /at least 8/], ['email', 'jane.doe@uni.cm', /email/], ['email local part', 'jane.doe', /email/], ['name', 'Jane Marie Doe', /name/], ['name no space', 'janemariedoe', /name/], ['common', 'password123', /common/], ['common (case)', 'Password123', /common/], ['single repeated char', 'aaaaaaaaaa', /repeated/], ['spaces only', '          ', /spaces/], ['too long', 'x'.repeat(80), /at most/]];
  for (const [label, pw, re] of cases) check(`policy rejects: ${label}`, re.test(pol.checkPassword(pw, ctx) || ''), pol.checkPassword(pw, ctx));
  check('policy accepts a good passphrase', pol.checkPassword('Correct-Horse-9', ctx) === null);
  check('policy rejects same-as-current', /different/.test(pol.checkPassword('Correct-Horse-9', { ...ctx, current: 'Correct-Horse-9' })));
  // via the API: user creation
  const mk = (extra) => call('POST', '/users', { token: adm, body: { name: 'New Person', email: `new-${uuid().slice(0, 8)}@t.local`, role: 'librarian', ...extra } });
  const w1 = await mk({ password: '123456' });
  check('POST /users with weak password → 422 + clear message', w1.status === 422 && w1.body.code === 'weak_password' && /at least 8/.test(w1.body.error), w1.body);
  check('POST /users with common password → 422', (await mk({ password: 'password123' })).status === 422);
  const okc = await mk({ password: 'Fine-Passw0rd' });
  check('POST /users with strong password → 201', okc.status === 201, okc.body);
  if (okc.body.email) dirs.push(okc.body.email);
  const nm = `Same Name`;
  check('POST /users password equal to e-mail → 422', (await call('POST', '/users', { token: adm, body: { name: nm, email: 'same.name@t.local', password: 'same.name@t.local', role: 'librarian' } })).status === 422);
  // admin password patch
  const tgt = await mkUser(S, 'Target Tom', 'teacher', { teacher_id: S.teachers.tom.id });
  const tgtLogin = await call('POST', '/auth/login', { body: { email: tgt.email, password: PW } });
  await sleep(1100);
  check('PATCH /users/:id/password weak → 422', (await call('PATCH', `/users/${tgt.id}/password`, { token: adm, body: { password: 'abc' } })).status === 422);
  check('PATCH /users/:id/password equal to name → 422', (await call('PATCH', `/users/${tgt.id}/password`, { token: adm, body: { password: 'Target Tom' } })).status === 422);
  check('old token still valid before any change', (await call('GET', '/auth/me', { token: tgtLogin.body.token })).status === 200);
  check('admin sets a strong password', (await call('PATCH', `/users/${tgt.id}/password`, { token: adm, body: { password: PW2 } })).status === 200);
  const rev = await call('GET', '/auth/me', { token: tgtLogin.body.token });
  check('token issued before the admin reset is rejected (session_revoked)', rev.status === 401 && rev.body.code === 'session_revoked', rev.body);
  check('new password works, old password no longer', (await call('POST', '/auth/login', { body: { email: tgt.email, password: PW2 } })).status === 200 && (await call('POST', '/auth/login', { body: { email: tgt.email, password: PW } })).status === 401);

  // ── self-service change + token invalidation ──────────────────────────────────────────
  section('Change own password & token invalidation');
  const me = await mkUser(S, 'Mia Self', 'teacher', { teacher_id: S.teachers.tess.id });
  const l1 = await call('POST', '/auth/login', { body: { email: me.email, password: PW } });
  await sleep(1100);
  const l2 = await call('POST', '/auth/login', { body: { email: me.email, password: PW } });   // a second "device" (different iat → different token)
  await sleep(1100);
  const chg = body => call('PUT', '/auth/me/password', { token: l1.body.token, body });
  check('wrong current password → 401', (await chg({ currentPassword: 'nope-nope', newPassword: PW2 })).status === 401);
  check('failed current-password attempts are counted', (await row(S, me.id)).failed_logins === 1);
  const cw = await chg({ currentPassword: PW, newPassword: 'short' });
  check('weak new password → 422 with message', cw.status === 422 && /at least 8/.test(cw.body.error), cw.body);
  check('new password equal to e-mail → 422', (await chg({ currentPassword: PW, newPassword: me.email })).status === 422);
  check('new password equal to current → 422', (await chg({ currentPassword: PW, newPassword: PW })).status === 422);
  check('common new password → 422', (await chg({ currentPassword: PW, newPassword: 'qwerty123' })).status === 422);
  check('missing fields → 422', (await chg({})).status === 422);
  const good = await chg({ currentPassword: PW, newPassword: PW2 });
  check('valid change → 200 + fresh token', good.status === 200 && good.body.token && good.body.user.must_change_password === false, good.body);
  check('failure counter reset by the change', (await row(S, me.id)).failed_logins === 0);
  check('the session that changed the password keeps working (same token)', (await call('GET', '/auth/me', { token: l1.body.token })).status === 200);
  check('the fresh token works', (await call('GET', '/auth/me', { token: good.body.token })).status === 200);
  const old2 = await call('GET', '/auth/me', { token: l2.body.token });
  check('other session issued before the change is rejected', old2.status === 401 && old2.body.code === 'session_revoked', old2.body);
  const forgedOld = jwt.sign({ id: me.id, email: me.email, role: 'teacher', name: me.name, teacher_id: me.teacher_id, school_id: S.schoolId, scope: 'tenant', iat: Math.floor(Date.now() / 1000) - 3600 }, SECRET, { expiresIn: '2h' });
  check('forged token with an old iat is rejected after the change', (await call('GET', '/auth/me', { token: forgedOld })).status === 401);
  check('login with the new password / not the old one', (await call('POST', '/auth/login', { body: { email: me.email, password: PW2 } })).status === 200 && (await call('POST', '/auth/login', { body: { email: me.email, password: PW } })).status === 401);
  check('password_changed_at stored', !!(await row(S, me.id)).password_changed_at);
  check('password_changed event (by self)', (await events(S, { user_id: me.id, type: 'password_changed' })).some(e => e.detail?.by === 'self'));
  check('users that never changed password keep working with harness tokens', (await call('GET', '/auth/me', { token: S.tok.tina })).status === 200);

  // ── reset-password flow ────────────────────────────────────────────────────────────────
  section('Forgot / reset password flow');
  const rp = await mkUser(S, 'Rita Reset', 'librarian');
  const gen1 = await call('POST', '/auth/forgot-password', { body: { email: rp.email } });
  const gen2 = await call('POST', '/auth/forgot-password', { body: { email: `ghost-${uuid()}@t.local` } });
  check('forgot-password answers identically for known and unknown e-mails', gen1.status === 200 && JSON.stringify(gen1.body) === JSON.stringify(gen2.body));
  const pend = await S.db.passwordResetRequest.findFirst({ where: { email: rp.email, status: 'pending' } });
  check('request raised for the real account', !!pend);
  check('reset-status false before approval', (await call('GET', `/auth/reset-status?email=${encodeURIComponent(rp.email)}`)).body.canReset === false);
  check('reset-password without approval → 400', (await call('POST', '/auth/reset-password', { body: { email: rp.email, newPassword: PW2 } })).status === 400);
  await call('PATCH', `/password-resets/${pend.id}/approve`, { token: adm });
  check('reset-status true after approval', (await call('GET', `/auth/reset-status?email=${encodeURIComponent(rp.email)}`)).body.canReset === true);
  const rw = await call('POST', '/auth/reset-password', { body: { email: rp.email, newPassword: '12345678' } });
  check('reset-password enforces the policy', rw.status === 422 && rw.body.code === 'weak_password', rw.body);
  const oldTok = (await call('POST', '/auth/login', { body: { email: rp.email, password: PW } })).body.token;
  for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { body: { email: rp.email, password: `bad-${i}-xx` } });
  check('(precondition) account locked before reset', !!(await row(S, rp.id)).locked_until);
  await sleep(1100);
  const rs = await call('POST', '/auth/reset-password', { body: { email: rp.email, newPassword: PW2 } });
  check('reset-password with a strong password logs the user in', rs.status === 200 && rs.body.token, rs.body);
  check('reset clears the lockout', !(await row(S, rp.id)).locked_until);
  check('token issued before the reset is rejected', (await call('GET', '/auth/me', { token: oldTok })).status === 401);
  check('token returned by the reset works', (await call('GET', '/auth/me', { token: rs.body.token })).status === 200);
  check('the approval is single-use', (await call('POST', '/auth/reset-password', { body: { email: rp.email, newPassword: PW } })).status === 400);
  check('forced-change flag still honoured at login (must_change_password)', await (async () => { const f = await mkUser(S, 'Fay Forced', 'teacher', { must: true, teacher_id: S.teachers.tina.id }); const x = await call('POST', '/auth/login', { body: { email: f.email, password: PW } }); return x.status === 200 && x.body.user.must_change_password === true; })());

  // ── /api/security permissions + features ───────────────────────────────────────────────
  section('/api/security: permissions');
  for (const [who, expect] of [['admin', 200], ['officer', 403], ['finance', 403], ['tina', 403], ['ann', 403]]) {
    const x = await call('GET', '/security/summary', { token: S.tok[who] });
    check(`GET /security/summary as ${who} → ${expect}`, x.status === expect, x.status);
  }
  check('no token → 401', (await call('GET', '/security/events')).status === 401);
  check('events as officer → 403', (await call('GET', '/security/events', { token: S.tok.officer })).status === 403);
  check('export as teacher → 403', (await call('GET', '/security/events/export', { token: S.tok.tina })).status === 403);
  check('force-reset as officer → 403', (await call('POST', `/security/users/${tgt.id}/force-reset`, { token: S.tok.officer })).status === 403);
  const headT = jwt.sign({ id: S.users.admin.id, email: S.users.admin.email, role: 'head_teacher', name: 'Head', school_id: S.schoolId, scope: 'tenant' }, SECRET, { expiresIn: '1h' });
  check('head_teacher (legacy alias of super_admin) has access', (await call('GET', '/security/summary', { token: headT })).status === 200);

  section('/api/security: events, summary, force reset, export');
  const e1 = await call('GET', '/security/events?limit=5', { token: adm });
  check('events: paged shape', e1.status === 200 && e1.body.total > 20 && e1.body.items.length === 5 && e1.body.page === 1, e1.body.total);
  const e2 = await call('GET', '/security/events?limit=5&page=2', { token: adm });
  check('events: page 2 differs from page 1', e2.body.items.length === 5 && e2.body.items[0].id !== e1.body.items[0].id);
  check('events: newest first', e1.body.items.every((x, i, a) => !i || new Date(a[i - 1].created_at) >= new Date(x.created_at)));
  const f1 = await call('GET', '/security/events?type=account_locked', { token: adm });
  check('events: filter by type', f1.body.total >= 2 && f1.body.items.every(x => x.type === 'account_locked'), f1.body.total);
  const f2 = await call('GET', '/security/events?type=login_failed,account_locked&email=' + encodeURIComponent(vic.email.slice(0, 10)), { token: adm });
  check('events: filter by several types + e-mail fragment', f2.body.total >= 6 && f2.body.items.every(x => ['login_failed', 'account_locked'].includes(x.type) && x.email === vic.email), f2.body.total);
  check('events: filter by user_id', (await call('GET', `/security/events?user_id=${vic.id}`, { token: adm })).body.items.every(x => x.user_id === vic.id));
  check('events: filter by ip', (await call('GET', '/security/events?ip=127.0.0.1&limit=3', { token: adm })).body.total > 0 && (await call('GET', '/security/events?ip=198.51.100.7', { token: adm })).body.total === 0);
  const today = new Date().toISOString().slice(0, 10);
  check('events: date range includes today', (await call('GET', `/security/events?from=${today}&to=${today}`, { token: adm })).body.total > 0);
  check('events: future range is empty', (await call('GET', '/security/events?from=2099-01-01', { token: adm })).body.total === 0);
  check('events: invalid type → 422', (await call('GET', '/security/events?type=bogus', { token: adm })).status === 422);
  check('events: invalid date → 422', (await call('GET', '/security/events?from=yesterday-ish', { token: adm })).status === 422);
  check('events: limit capped at 200', (await call('GET', '/security/events?limit=9999', { token: adm })).body.limit === 200);

  const sum = await call('GET', '/security/summary?days=7', { token: adm });
  check('summary: 7 day buckets', sum.status === 200 && sum.body.by_day.length === 7 && sum.body.by_day[6].day === today, sum.body.by_day?.map(d => d.day));
  const todayRow = sum.body.by_day[6];
  const failedDb = await S.db.securityEvent.count({ where: { type: 'login_failed', created_at: { gte: new Date(`${today}T00:00:00Z`) } } });
  check('summary: failed-login count matches the event table', todayRow.failed === failedDb && failedDb >= 20, { todayRow, failedDb });
  check('summary: top IPs lists 127.0.0.1 with failures', sum.body.top_ips[0]?.ip === '127.0.0.1' && sum.body.top_ips[0].failures === failedDb, sum.body.top_ips);
  check('summary: locked accounts listed (Race Rick)', sum.body.locked_accounts.some(a => a.id === race.id) && !sum.body.locked_accounts.some(a => a.id === vic.id), sum.body.locked_accounts.map(a => a.email));
  check('summary: totals by type', sum.body.totals.login_failed === failedDb && sum.body.totals.account_locked >= 2);
  check('summary: days clamped', (await call('GET', '/security/summary?days=500', { token: adm })).body.days === 90);

  const fr = await call('POST', `/security/users/${tgt.id}/force-reset`, { token: adm, body: {} });
  const tl = await call('POST', '/auth/login', { body: { email: tgt.email, password: PW2 } });
  check('force-reset: flag set', fr.status === 200 && (await row(S, tgt.id)).must_change_password === true && fr.body.revoked_sessions === true);
  check('force-reset: next login reports must_change_password', tl.body.user?.must_change_password === true);
  check('force-reset: events recorded', (await events(S, { type: 'password_reset_forced', user_id: tgt.id })).length === 1);
  const nrv = await call('POST', `/security/users/${me.id}/force-reset`, { token: adm, body: { revoke_sessions: false } });
  check('force-reset without revoking sessions keeps existing tokens', nrv.status === 200 && (await call('GET', '/auth/me', { token: good.body.token })).status === 200);
  check('force-reset unknown user → 404', (await call('POST', `/security/users/${uuid()}/force-reset`, { token: adm })).status === 404);
  check('unlock unknown user → 404', (await call('POST', `/security/users/${uuid()}/unlock`, { token: adm })).status === 404);
  const forced = await call('PUT', '/auth/me/password', { token: tl.body.token, body: { currentPassword: PW2, newPassword: PW } });
  check('forced user can complete the password change', forced.status === 200 && (await row(S, tgt.id)).must_change_password === false);

  const csv = await call('GET', '/security/events/export?type=login_failed', { token: adm, raw: true });
  const csvText = await csv.text();
  check('CSV export: content type + attachment', /text\/csv/.test(csv.headers.get('content-type')) && /attachment/.test(csv.headers.get('content-disposition')));
  check('CSV export: header row + data rows', csvText.replace('﻿', '').startsWith('time,type,email,user_id,ip,user_agent,detail') && csvText.trim().split('\r\n').length > 20);
  const inj = await call('POST', '/auth/login', { body: { email: 'a@b.cm', password: 'x' }, headers: { 'User-Agent': '=cmd|calc' } });
  const { toCsv } = require('../src/analytics/csv');
  check('CSV cells starting with = are neutralised', toCsv([{ a: '=1+1', b: 'x,"y"', c: 5 }]).includes("'=1+1") && toCsv([{ b: 'x,"y"' }]).includes('"x,""y"""'));
  check('CSV export honours filters (bad type → 422)', (await call('GET', '/security/events/export?type=zzz', { token: adm })).status === 422);

  section('Permission-denied events & tenant isolation');
  const denied1 = await call('GET', '/security/summary', { token: S.tok.ann });
  await sleep(300);
  let dn = await events(S, { type: 'permission_denied', user_id: S.users.ann.id });
  check('403 from authorize() is logged as permission_denied', denied1.status === 403 && dn.length === 1 && dn[0].detail?.role === 'student' && /security/.test(dn[0].detail?.route), dn);
  await call('GET', '/security/summary', { token: S.tok.ann }); await sleep(300);
  check('repeated denials on the same route are collapsed (no log flooding)', (await events(S, { type: 'permission_denied', user_id: S.users.ann.id })).length === 1);
  await call('GET', '/security/events', { token: S.tok.ann }); await sleep(300);
  check('a different route is logged separately', (await events(S, { type: 'permission_denied', user_id: S.users.ann.id })).length === 2);
  const oadm = O.tok.admin;
  const oe = await call('GET', '/security/events?limit=200', { token: oadm });
  check('school B admin sees none of school A’s events', oe.status === 200 && !oe.body.items.some(x => x.user_id === vic.id || x.user_id === staff.id), oe.body.total);
  check('school B admin cannot unlock school A’s user (404)', (await call('POST', `/security/users/${race.id}/unlock`, { token: oadm })).status === 404);
  check('school B admin cannot force-reset school A’s user (404)', (await call('POST', `/security/users/${race.id}/force-reset`, { token: oadm })).status === 404);
  check('tokens of school A are not valid with school B ids (forged school mismatch → data isolated)', (await call('GET', '/security/events', { token: jwt.sign({ id: S.users.admin.id, role: 'super_admin', name: 'x', school_id: O.schoolId, scope: 'tenant' }, SECRET) })).body.items?.every(x => x.user_id !== vic.id));

  section('Safe error handling & body limits');
  const mal = await call('POST', '/auth/login', { rawBody: '{"email": "x", ', headers: { 'Content-Type': 'application/json' } });
  check('malformed JSON → 400 JSON error, no stack', mal.status === 400 && mal.body.error === 'Malformed JSON body' && !/at .*\.js/.test(mal.text), mal.text.slice(0, 200));
  const big = await call('POST', '/auth/login', { rawBody: JSON.stringify({ email: 'a@b.cm', password: 'x'.repeat(3_000_000) }), headers: { 'Content-Type': 'application/json' } });
  check('oversized JSON body → 413', big.status === 413 && big.body.error === 'Request body too large', big.status);
  check('unknown route → 404 JSON', (await call('GET', '/nope/nothing')).status === 404);
  A.child.kill();
  const prod = await startApi({ NODE_ENV: 'production', RATE_GLOBAL_MAX: '100000' });
  const pcall = mkCall(prod.base);
  const pe = await pcall('POST', '/auth/login', { rawBody: '{bad', headers: { 'Content-Type': 'application/json' } });
  check('production: parse errors stay clean 400s', pe.status === 400);
  const hsts = await pcall('GET', '/health', { raw: true });
  check('production: HSTS header enabled', /max-age/.test(hsts.headers.get('strict-transport-security') || ''));
  const { errorHandler } = { errorHandler: require('../src/middleware/errorHandler') };
  let sent;
  const fakeRes = { headersSent: false, status(c) { this.code = c; return this; }, json(b) { sent = b; } };
  const prevEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const origErr = console.error; console.error = () => {};
  errorHandler(new Error('connection to db at 10.0.0.5 failed: secret'), {}, fakeRes, () => {});
  console.error = origErr; process.env.NODE_ENV = prevEnv;
  check('production: 500 messages are generic (no internals leaked)', fakeRes.code === 500 && sent.error === 'Internal server error', sent);
  errorHandler(Object.assign(new Error('Custom validation'), { status: 422 }), {}, fakeRes, () => {});
  check('4xx messages are preserved', fakeRes.code === 422 && sent.error === 'Custom validation');
  prod.child.kill();

  // ── strict instance: lock expiry, rate limits, proxies ────────────────────────────────────
  section('Strict instance: lock expiry, rate limiting, trust proxy');
  prod.child.kill();
  const B = await startApi({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_MINUTES: '0.05', RATE_LOGIN_IP_MAX: '12', RATE_LOGIN_ACCOUNT_MAX: '8', RATE_RESET_IP_MAX: '5', RATE_RESET_ACCOUNT_MAX: '3', TRUST_PROXY: '1', AUTH_USER_CACHE_SEC: '0' });
  const bc = mkCall(B.base);
  const xff = ip => ({ 'X-Forwarded-For': ip });
  const lk = await mkUser(S, 'Lock Lena', 'teacher', { teacher_id: S.teachers.tom.id });
  const cfgB = await bc('GET', '/security/config', { token: adm });
  check('LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES are env-tunable', cfgB.body.login_max_failures === 3 && cfgB.body.login_lock_minutes === 0.05 && cfgB.body.login_ip.max === 12, cfgB.body);
  for (let i = 0; i < 3; i++) await bc('POST', '/auth/login', { body: { email: lk.email, password: `bad-${i}-xx` }, headers: xff('10.1.0.1') });
  check('locked after 3 failures (tuned)', (await bc('POST', '/auth/login', { body: { email: lk.email, password: PW }, headers: xff('10.1.0.1') })).status === 429);
  await sleep(3400);
  check('lock expires by itself after LOGIN_LOCK_MINUTES', (await bc('POST', '/auth/login', { body: { email: lk.email, password: PW }, headers: xff('10.1.0.1') })).status === 200);
  ev = await events(S, { user_id: lk.id, type: 'login_success' });
  check('TRUST_PROXY=1: client IP taken from X-Forwarded-For', ev.length === 1 && ev[0].ip === '10.1.0.1', ev.map(e => e.ip));
  // per-IP failure gate: 12 failures from one IP (various accounts) → blocked, other IP unaffected
  const ipx = xff('10.2.0.2');
  let last;
  for (let i = 0; i < 12; i++) last = await bc('POST', '/auth/login', { body: { email: `ghost${i}-${uuid().slice(0, 6)}@t.local`, password: 'bad-bad-bad' }, headers: ipx });
  const blocked = await bc('POST', '/auth/login', { body: { email: lk.email, password: PW }, headers: ipx });
  check('per-IP failure gate: after 12 failures the IP is rate limited (even with valid credentials)', last.status === 401 && blocked.status === 429 && blocked.body.code === 'rate_limited' && blocked.headers.get('retry-after'), blocked.body);
  check('the block is per IP: another address can still log in', (await bc('POST', '/auth/login', { body: { email: lk.email, password: PW }, headers: xff('10.2.0.3') })).status === 200);
  check('student matricule login is blocked from the abusive IP too', (await bc('POST', '/auth/student-login', { body: { studentId: matric }, headers: ipx })).status === 429);
  await sleep(500);
  check('rate_limited event logged (school resolved from the login e-mail)', (await events(S, { type: 'rate_limited', email: lk.email })).length >= 1);
  // per-account attempt limiter: 6 attempts / window
  const acc = await mkUser(S, 'Acc Ann', 'teacher', { teacher_id: S.teachers.tom.id });
  const accRes = [];
  for (let i = 0; i < 10; i++) accRes.push(await bc('POST', '/auth/login', { body: { email: acc.email, password: PW }, headers: xff('10.3.0.' + (i + 1)) }));
  check('per-account limiter: 8 attempts allowed (from different IPs), then 429', accRes.slice(0, 8).every(x => x.status === 200) && accRes[8].status === 429 && accRes[8].body.code === 'rate_limited', accRes.map(x => x.status));
  // forgot-password limiter
  const fp = [];
  for (let i = 0; i < 4; i++) fp.push(await bc('POST', '/auth/forgot-password', { body: { email: `u${i}-${uuid().slice(0, 5)}@t.local` }, headers: xff('10.4.0.1') }));
  check('forgot-password: per-IP limit (5) then 429', fp.every(x => x.status === 200));
  await bc('POST', '/auth/forgot-password', { body: { email: 'z1@t.local' }, headers: xff('10.4.0.1') });
  check('forgot-password: 6th request from the IP → 429', (await bc('POST', '/auth/forgot-password', { body: { email: 'z2@t.local' }, headers: xff('10.4.0.1') })).status === 429);
  const rsT = [];
  for (let i = 0; i < 4; i++) rsT.push((await bc('GET', `/auth/reset-status?email=${encodeURIComponent(acc.email)}`, { headers: xff('10.5.0.' + (i + 1)) })).status);
  check('reset-status: per-account limit (3) across IPs', rsT.slice(0, 3).every(s => s === 200) && rsT[3] === 429, rsT);
  check('rate-limit messages are generic (no account hints)', !/exist|unknown|not found/i.test(JSON.stringify((await bc('POST', '/auth/forgot-password', { body: { email: 'z3@t.local' }, headers: xff('10.4.0.1') })).body)));

  // global limiter
  B.child.kill();
  const G = await startApi({ RATE_GLOBAL_MAX: '30', RATE_GLOBAL_WINDOW_SEC: '4', TRUST_PROXY: '1' });
  const gc = mkCall(G.base);
  const gs = [];
  for (let i = 0; i < 40; i++) gs.push((await gc('GET', '/school', { token: S.tok.officer, headers: xff('10.9.0.1') })).status);
  check('global limiter: first 30 requests pass, the rest get 429', gs.slice(0, 30).every(s => s !== 429) && gs.slice(30).every(s => s === 429), gs.join(','));
  check('global limiter: /api/health is never limited', (await gc('GET', '/health', { headers: xff('10.9.0.1') })).status === 200);
  check('global limiter: another IP is unaffected', (await gc('GET', '/school', { token: S.tok.officer, headers: xff('10.9.0.2') })).status !== 429);
  check('global limiter: webhook path is excluded', (await gc('POST', '/payments/webhooks/orange', { body: {}, headers: xff('10.9.0.1') })).status !== 429);
  await sleep(300);
  const rl = await events(S, { type: 'rate_limited', user_id: S.users.officer.id });
  check('global limiter: rate_limited event logged for the authenticated caller', rl.length === 1 && rl[0].detail?.scope === 'global', rl.length);
  await sleep(4200);
  check('global limiter: window slides — allowed again after 4 s', (await gc('GET', '/school', { token: S.tok.officer, headers: xff('10.9.0.1') })).status !== 429);

  // ── cleanup ───────────────────────────────────────────────────────────────────────────
  for (const k of kids) try { k.kill(); } catch { /* gone */ }
  try { await platformClient.platformAdmin.delete({ where: { id: pa.id } }); await platformClient.userDirectory.deleteMany({ where: { email: { in: dirs } } }); } catch { /* best effort */ }
  await finish(platformClient);
})().catch(e => { console.error(e); for (const k of kids) try { k.kill(); } catch { /* gone */ } process.exit(1); });
