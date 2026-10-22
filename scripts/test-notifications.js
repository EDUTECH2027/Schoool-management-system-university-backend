// Notification centre suite: own notifications, preferences, notifyUsers rules, broadcasts, audience resolution, outbox + SMTP worker.
// The API under test must run WITHOUT SMTP and with MAIL_WORKER=off (start-api.ps1 -Extra "MAIL_WORKER=off");
// delivery is tested in-process against a tiny SMTP sink written here with node:net.
process.env.BROADCAST_MAX_RECIPIENTS = process.env.BROADCAST_MAX_RECIPIENTS || '5000';
const net = require('net');
const H = require('./lib/academic-harness');
const { call, check, section, seedSchool, finish, uuid, platformClient } = H;
const { notifyUsers, notifyDetailed } = require('../src/utils/notify');
const mailWorker = require('../src/services/mailWorker');
const mailer = require('../src/utils/mailer');
const audienceSvc = require('../src/services/audience');

// ── SMTP sink: accepts anything, records messages, can answer 451 on demand ─────────
function startSink() {
  const box = { messages: [], fail: 0, sessions: 0 };
  const server = net.createServer(sock => {
    box.sessions++;
    let buf = '', data = false, cur = { to: [], raw: '' };
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
          cur.raw = buf.slice(0, end); buf = buf.slice(end + 5); data = false;
          if (box.fail > 0) { box.fail--; sock.write('451 4.3.0 Temporary failure, try later\r\n'); cur = { to: [], raw: '' }; continue; }
          box.messages.push(cur); cur = { to: [], raw: '' }; sock.write('250 OK queued\r\n'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 sink\r\n');
        else if (cmd === 'MAIL') { cur.from = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { cur.to.push(/<([^>]+)>/.exec(line)?.[1]); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'RSET') sock.write('250 OK\r\n');
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, box, port: server.address().port })));
}

(async () => {
  const S = await seedSchool('NotA'), O = await seedSchool('NotB');
  const { tok, db } = S;
  const OF = tok.officer, AD = tok.admin, ANN = tok.ann, BOB = tok.bob;
  const uid = S.users;
  const N = (userId, n, extra = {}) => db.notification.createMany({ data: Array.from({ length: n }, (_, i) => ({ id: uuid(), user_id: userId, type: extra.type ?? 'general', title: `${extra.title ?? 'Note'} ${i}`, body: 'b', created_at: new Date(Date.now() - i * 1000) })) });

  section('Own notifications');
  await N(uid.ann.id, 7); await N(uid.ann.id, 2, { type: 'results_published', title: 'Results' }); await N(uid.bob.id, 3);
  const l = await call('GET', '/notification-center?limit=4', { token: ANN });
  check('list own notifications with paging', l.status === 200 && l.body.items.length === 4 && l.body.total === 9 && l.body.unread === 9, l.body);
  check('page 2', (await call('GET', '/notification-center?limit=4&page=3', { token: ANN })).body.items.length === 1);
  check('sorted newest first', l.body.items[0].created_at >= l.body.items[1].created_at);
  check('type filter', (await call('GET', '/notification-center?type=results_published', { token: ANN })).body.total === 2);
  check('other user sees only theirs', (await call('GET', '/notification-center', { token: BOB })).body.total === 3);
  check('requires login', (await call('GET', '/notification-center')).status === 401);
  check('unread count', (await call('GET', '/notification-center/unread-count', { token: ANN })).body.unread === 9);
  const one = l.body.items[0].id;
  check('mark one read', (await call('POST', `/notification-center/${one}/read`, { token: ANN })).status === 200);
  check('unread-only filter excludes it', (await call('GET', '/notification-center?unread=1', { token: ANN })).body.total === 8);
  check('marking read twice is idempotent', (await call('POST', `/notification-center/${one}/read`, { token: ANN })).status === 200);
  check('cannot mark someone else\'s notification → 404', (await call('POST', `/notification-center/${one}/read`, { token: BOB })).status === 404);
  check('unknown id → 404', (await call('POST', `/notification-center/${uuid()}/read`, { token: ANN })).status === 404);
  const bobFirst = (await call('GET', '/notification-center', { token: BOB })).body.items[0].id;
  check('cannot delete someone else\'s → 404 and it survives', (await call('DELETE', `/notification-center/${bobFirst}`, { token: ANN })).status === 404 && await db.notification.count({ where: { id: bobFirst } }) === 1);
  check('delete own', (await call('DELETE', `/notification-center/${one}`, { token: ANN })).status === 200 && (await call('GET', '/notification-center', { token: ANN })).body.total === 8);
  const sel = (await call('GET', '/notification-center?limit=2', { token: ANN })).body.items.map(i => i.id);
  check('mark selected read', (await call('POST', '/notification-center/read', { token: ANN, body: { ids: sel } })).body.updated === 2);
  check('mark-all does not touch other users', (await call('POST', '/notification-center/read', { token: ANN, body: {} })).body.updated === 6 && (await call('GET', '/notification-center/unread-count', { token: BOB })).body.unread === 3);
  check('works for a teacher', (await call('GET', '/notification-center', { token: tok.tina })).status === 200);
  check('works for finance', (await call('GET', '/notification-center/unread-count', { token: tok.finance })).status === 200);
  check('legacy e-learning bell endpoint still works', (await call('GET', '/elearning/notifications', { token: ANN })).status === 200);

  section('Preferences');
  const p0 = await call('GET', '/notification-center/preferences', { token: ANN });
  check('defaults: in_app + email on, nothing muted', p0.body.in_app === true && p0.body.email === true && p0.body.muted_types.length === 0, p0.body);
  check('preferences list known types with critical flags', p0.body.types.some(t => t.type === 'security' && t.critical) && p0.body.types.some(t => t.type === 'service_update' && !t.critical));
  check('email_configured is reported honestly (false here)', p0.body.email_configured === false);
  check('set preferences', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { email: false, muted_types: ['forum', 'forum', 'class_reminder'] } })).body.muted_types.length === 2);
  check('persisted per user', (await call('GET', '/notification-center/preferences', { token: ANN })).body.email === false && (await call('GET', '/notification-center/preferences', { token: BOB })).body.email === true);
  check('partial update keeps the rest', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { in_app: true } })).body.email === false);
  check('cannot mute security → 422', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { muted_types: ['security'] } })).status === 422);
  check('cannot mute must_read → 422', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { muted_types: ['forum', 'must_read'] } })).status === 422);
  check('invalid flag → 422', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { email: 'yes' } })).status === 422);
  check('muted_types must be a list → 422', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { muted_types: 'forum' } })).status === 422);
  check('too many muted types → 422', (await call('PUT', '/notification-center/preferences', { token: ANN, body: { muted_types: Array.from({ length: 31 }, (_, i) => `t${i}`) } })).status === 422);
  check('rejected updates changed nothing', (await call('GET', '/notification-center/preferences', { token: ANN })).body.muted_types.length === 2);
  check('works for a teacher', (await call('PUT', '/notification-center/preferences', { token: tok.tina, body: { email: false } })).status === 200);
  check('email-status endpoint', (await call('GET', '/notification-center/email-status', { token: ANN })).body.configured === false);

  section('notifyUsers: preferences and e-mail queueing');
  const cnt = (userId, type) => db.notification.count({ where: { user_id: userId, type } });
  const outCnt = (userId, type) => db.emailOutbox.count({ where: { user_id: userId, type } });
  check('legacy signature still returns the in-app count', await notifyUsers(db, [uid.cid.id, uid.cid.id, null], { type: 'general', title: 'Hello' }) === 1);
  check('non-allow-listed type is never e-mailed', await outCnt(uid.cid.id, 'general') === 0);
  await notifyUsers(db, [uid.cid.id], { type: 'results_published', title: 'Results are out', body: 'See them', link: '/student/results' });
  check('allow-listed type queues an e-mail for a user with an address', await outCnt(uid.cid.id, 'results_published') === 1);
  const em = await db.emailOutbox.findFirst({ where: { user_id: uid.cid.id } });
  check('queued mail has address, subject, link in body; with no SMTP it is recorded as skipped with the reason', em.to_email === uid.cid.email && em.subject === 'Results are out' && em.body.includes('/student/results') && em.status === 'skipped' && /not configured/.test(em.error) && em.attempts === 0, em);
  await notifyUsers(db, [uid.ann.id], { type: 'results_published', title: 'Results 2' });
  check('email=false → in-app only, no e-mail', await cnt(uid.ann.id, 'results_published') >= 2 && await outCnt(uid.ann.id, 'results_published') === 0);
  await call('PUT', '/notification-center/preferences', { token: ANN, body: { in_app: false } });
  await notifyUsers(db, [uid.ann.id], { type: 'class_reminder', title: 'muted + in_app off' });
  check('in_app=false skips non-critical types', await cnt(uid.ann.id, 'class_reminder') === 0);
  await notifyUsers(db, [uid.ann.id], { type: 'security', title: 'New sign-in' });
  check('in_app=false never hides security', await cnt(uid.ann.id, 'security') === 1);
  await notifyUsers(db, [uid.ann.id], { type: 'must_read', title: 'Important', channels: ['in_app', 'email'] });
  check('must_read always delivered (in-app and e-mail) despite preferences', await cnt(uid.ann.id, 'must_read') === 1 && await outCnt(uid.ann.id, 'must_read') === 1);
  await call('PUT', '/notification-center/preferences', { token: BOB, body: { muted_types: ['service_update'] } });
  await notifyUsers(db, [uid.bob.id, uid.cid.id], { type: 'service_update', title: 'Req moved' });
  check('muted type skipped in-app and e-mail for that user only', await cnt(uid.bob.id, 'service_update') === 0 && await outCnt(uid.bob.id, 'service_update') === 0 && await cnt(uid.cid.id, 'service_update') === 1 && await outCnt(uid.cid.id, 'service_update') === 1);
  const det = await notifyDetailed(db, [uid.dee.id], { type: 'broadcast', title: 'Only e-mail', channels: ['email'] });
  check('channels=[email] queues mail without an in-app row', det.in_app === 0 && det.email === 1 && await cnt(uid.dee.id, 'broadcast') === 0);
  await db.user.update({ where: { id: uid.dee.id }, data: { email: '' } });
  check('user without an address → no mail, no failure', (await notifyDetailed(db, [uid.dee.id], { type: 'broadcast', title: 'x' })).email === 0);
  const before = await db.notification.count();
  check('empty list → 0 and no error', await notifyUsers(db, [], { type: 'x', title: 'y' }) === 0 && await db.notification.count() === before);

  section('Broadcasts: permissions & validation');
  const bc = (token, body) => call('POST', '/notification-center/broadcasts', { token, body });
  const okBody = { title: 'Campus closed Friday', body: 'The campus is closed on Friday.', channels: ['in_app'], audience: { roles: ['student'] } };
  for (const [n, t] of [['student', ANN], ['teacher', tok.tina], ['finance', tok.finance]]) {
    check(`${n} cannot send a broadcast`, (await bc(t, okBody)).status === 403);
    check(`${n} cannot preview`, (await call('POST', '/notification-center/broadcasts/preview', { token: t, body: { audience: { roles: ['student'] } } })).status === 403);
    check(`${n} cannot list broadcasts`, (await call('GET', '/notification-center/broadcasts', { token: t })).status === 403);
    check(`${n} cannot read the outbox`, (await call('GET', '/notification-center/outbox', { token: t })).status === 403);
  }
  check('short title → 422', (await bc(OF, { ...okBody, title: 'ab' })).status === 422);
  check('empty message → 422', (await bc(OF, { ...okBody, body: ' ' })).status === 422);
  check('no channel → 422', (await bc(OF, { ...okBody, channels: [] })).status === 422);
  check('unknown channel → 422', (await bc(OF, { ...okBody, channels: ['sms'] })).status === 422);
  check('empty audience → 422', (await bc(OF, { ...okBody, audience: {} })).status === 422);
  check('unknown role → 422', (await bc(OF, { ...okBody, audience: { roles: ['wizard'] } })).status === 422);
  check('unknown programme → 422', (await bc(OF, { ...okBody, audience: { programme_ids: [uuid()] } })).status === 422);
  check('unknown class → 422', (await bc(OF, { ...okBody, audience: { class_ids: [uuid()] } })).status === 422);
  check('unknown offering → 422', (await bc(OF, { ...okBody, audience: { offering_ids: [uuid()] } })).status === 422);
  check('malformed audience → 422', (await bc(OF, { ...okBody, audience: { roles: 'student' } })).status === 422);
  check('too many ids → 422', (await bc(OF, { ...okBody, audience: { class_ids: Array.from({ length: 51 }, (_, i) => `c${i}`) } })).status === 422);
  check('audience with no recipients → 422', (await bc(OF, { ...okBody, audience: { roles: ['librarian'] } })).status === 422);
  check('e-mail-only while SMTP is not configured → 409 (never pretends)', (await bc(OF, { ...okBody, channels: ['email'] })).status === 409);
  check('nothing was created by the rejected requests', await db.broadcast.count() === 0);

  section('Audience resolution');
  const prog = await db.programme.create({ data: { id: uuid(), department_id: (await db.department.create({ data: { id: uuid(), faculty_id: (await db.faculty.create({ data: { id: uuid(), name: 'Sci', code: 'SCI' } })).id, name: 'CS', code: 'CS' } })).id, name: 'BSc CS', code: 'BSCCS' } });
  await db.class.update({ where: { id: S.cls.y1.id }, data: { programme_id: prog.id } });
  const subj = await db.subject.create({ data: { id: uuid(), name: 'Databases', code: 'DB1' } });
  const off = await db.courseOffering.create({ data: { id: uuid(), subject_id: subj.id, term_id: S.t1.id, section: 'A' } });
  await db.courseEnrollment.create({ data: { id: uuid(), student_id: S.students.cid.id, offering_id: off.id, term_id: S.t1.id, credits: 3, status: 'registered' } });
  const dropped = await S.addStudent('Dropped', S.cls.y2);
  await db.courseEnrollment.create({ data: { id: uuid(), student_id: dropped.s.id, offering_id: off.id, term_id: S.t1.id, credits: 3, status: 'dropped' } });
  const pv = (audience) => call('POST', '/notification-center/broadcasts/preview', { token: OF, body: { audience } });
  check('roles: student', (await pv({ roles: ['student'] })).body.recipients === 5, (await pv({ roles: ['student'] })).body);
  check('roles: teacher', (await pv({ roles: ['teacher'] })).body.recipients === 3);
  check('roles: several roles are a union', (await pv({ roles: ['teacher', 'finance_officer'] })).body.recipients === 4);
  check('roles: super_admin includes legacy head_teacher', (await pv({ roles: ['super_admin'] })).body.recipients === 1);
  check('class: only that class (Ann, Bob)', (await pv({ class_ids: [S.cls.y1.id] })).body.recipients === 2);
  check('programme: students of its classes', (await pv({ programme_ids: [prog.id] })).body.recipients === 2);
  check('offering: registered students only (dropped excluded)', (await pv({ offering_ids: [off.id] })).body.recipients === 1);
  const mix = (await pv({ class_ids: [S.cls.y1.id], programme_ids: [prog.id], offering_ids: [off.id], roles: ['teacher'] })).body;
  check('combination is a deduplicated union (Ann, Bob, Cid + 3 teachers)', mix.recipients === 6 && mix.breakdown.classes === 2 && mix.breakdown.offerings === 1, mix);
  const inactive = await S.addStudent('Gone', S.cls.y1); await db.student.update({ where: { id: inactive.s.id }, data: { is_active: false } });
  check('inactive students are excluded from class audiences', (await pv({ class_ids: [S.cls.y1.id] })).body.recipients === 2);
  check('preview reports e-mail coverage', (await pv({ roles: ['teacher'] })).body.with_email === 3);
  check('preview of an unknown class → 422', (await pv({ class_ids: ['nope'] })).status === 422);
  check('options endpoint lists programmes/classes/offerings', await (async () => { const o = (await call('GET', '/notification-center/broadcasts/options', { token: OF })).body; return o.programmes.length === 1 && o.classes.length === 3 && o.offerings.length === 1 && o.roles.includes('teacher') && o.email_configured === false; })());
  check('other school: our class is unknown there', (await call('POST', '/notification-center/broadcasts/preview', { token: O.tok.officer, body: { audience: { class_ids: [S.cls.y1.id] } } })).status === 422);
  // cap (module-level env read at load → use a fresh copy of the module)
  process.env.BROADCAST_MAX_RECIPIENTS = '3';
  delete require.cache[require.resolve('../src/services/audience')];
  const capped = require('../src/services/audience');
  let capErr; try { await capped.resolve(db, { roles: ['student'] }); } catch (e) { capErr = e; }
  check('recipient cap is enforced', capErr instanceof capped.AudienceError && /limit is 3/.test(capErr.message), capErr?.message);
  check('under the cap resolves', (await capped.resolve(db, { roles: ['finance_officer'] })).userIds.length === 1);
  process.env.BROADCAST_MAX_RECIPIENTS = '5000';

  section('Broadcast sending');
  await call('PUT', '/notification-center/preferences', { token: ANN, body: { in_app: true } });
  const sent = await bc(OF, { title: 'Exam timetable', body: 'The timetable is online.', channels: ['in_app', 'email'], audience: { class_ids: [S.cls.y1.id], roles: ['teacher'] } });
  check('officer sends a broadcast → 201', sent.status === 201 && sent.body.recipients === 5, sent.body);
  check('response warns that e-mail is not configured', /not configured/i.test(sent.body.warning || '') && sent.body.email_configured === false);
  check('in-app notifications created for recipients only', await db.notification.count({ where: { type: 'broadcast', title: 'Exam timetable' } }) === 5 && await db.notification.count({ where: { type: 'broadcast', title: 'Exam timetable', user_id: uid.cid.id } }) === 0);
  check('e-mails queued in the outbox', await db.emailOutbox.count({ where: { type: 'broadcast', subject: 'Exam timetable' } }) >= 3);
  const bcRow = await db.broadcast.findUnique({ where: { id: sent.body.id } });
  check('broadcast row stores audience, channels, recipients, author', bcRow.recipients === 5 && bcRow.channels.includes('email') && bcRow.audience.class_ids[0] === S.cls.y1.id && bcRow.created_by === uid.officer.id);
  check('recipient sees it in their centre', (await call('GET', '/notification-center?type=broadcast', { token: BOB })).body.items.some(n => n.title === 'Exam timetable'));
  check('broadcast audited', await db.academicAudit.count({ where: { action: 'broadcast.send', target_id: sent.body.id } }) === 1);
  const hist = await call('GET', '/notification-center/broadcasts', { token: AD });
  check('history lists it with delivery stats', hist.body.total === 1 && hist.body.items[0].delivered.in_app >= 1, hist.body);
  const inapp = await bc(AD, { title: 'In-app only', body: 'Just in-app.', channels: ['in_app'], audience: { roles: ['teacher'] } });
  check('in-app only: no e-mail, no warning', inapp.status === 201 && !inapp.body.warning && await db.emailOutbox.count({ where: { subject: 'In-app only' } }) === 0);
  await call('PUT', '/notification-center/preferences', { token: tok.tess, body: { in_app: false } });
  await call('PUT', '/notification-center/preferences', { token: tok.tom, body: { muted_types: ['broadcast'] } });
  await bc(OF, { title: 'Pref test', body: 'x', channels: ['in_app'], audience: { roles: ['teacher'] } });
  check('broadcast respects in_app=false and muting', await db.notification.count({ where: { title: 'Pref test' } }) === 1);
  const must = await bc(OF, { title: 'Must read', body: 'Important!', channels: ['in_app'], must_read: true, audience: { roles: ['teacher'] } });
  check('must_read broadcast reaches everyone, even muted', must.status === 201 && must.body.must_read === true && await db.notification.count({ where: { type: 'must_read', title: 'Must read' } }) === 3);
  check('other school sees none of our broadcasts', (await call('GET', '/notification-center/broadcasts', { token: O.tok.officer })).body.total === 0);

  section('Outbox without SMTP (honest)');
  const ob = await call('GET', '/notification-center/outbox', { token: OF });
  check('outbox reports smtp not configured; broadcast e-mails are recorded as skipped (never sent)', ob.status === 200 && ob.body.smtp.configured === false && ob.body.counts.skipped >= 3 && ob.body.counts.sent === 0, ob.body.counts);
  await db.emailOutbox.createMany({ data: [uuid(), uuid(), uuid()].map(id => ({ id, to_email: 'old@t.local', subject: 'legacy queued', body: 'x' })) });
  const proc = await call('POST', '/notification-center/outbox/process', { token: OF });
  check('processing rows queued before without SMTP marks them skipped, sends nothing', proc.body.configured === false && proc.body.skipped === 3 && proc.body.sent === 0, proc.body);
  const ob2 = await call('GET', '/notification-center/outbox?status=skipped', { token: OF });
  check('skipped rows carry the reason', ob2.body.items.length >= 3 && ob2.body.items.every(m => /not configured/i.test(m.error)) && ob2.body.counts.queued === 0 && ob2.body.counts.skipped >= 6);
  check('outbox filter by status + paging', (await call('GET', '/notification-center/outbox?status=skipped&limit=2', { token: OF })).body.items.length === 2);
  check('process is staff-only', (await call('POST', '/notification-center/outbox/process', { token: ANN })).status === 403);
  check('retry is staff-only', (await call('POST', '/notification-center/outbox/retry', { token: tok.tina })).status === 403);
  check('other school outbox is empty', (await call('GET', '/notification-center/outbox', { token: O.tok.officer })).body.total === 0);

  section('SMTP worker (local sink)');
  const sink = await startSink();
  await db.notificationPreference.deleteMany({});   // back to defaults for the delivery tests
  const run = () => mailWorker.runOnce(db);
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_FROM: 'EduTech <no-reply@test.local>', SMTP_SECURE: 'false' });
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  check('mailer is configured once SMTP_HOST is set', mailer.isConfigured() === true && mailer.status().port === sink.port);
  await db.emailOutbox.deleteMany({});
  const q1 = await notifyDetailed(db, [uid.cid.id], { type: 'results_published', title: 'Hello Cid', body: 'Body line', link: '/student/results' });
  check('queued', q1.email === 1);
  const w1 = await run();
  check('worker sends the queued mail', w1.sent === 1 && sink.box.messages.length === 1, w1);
  const msg = sink.box.messages[0];
  check('sink received right recipient, from and subject', msg.to[0] === uid.cid.email && /no-reply@test\.local/.test(msg.from) && /Subject: Hello Cid/.test(msg.raw) && /Body line/.test(msg.raw));
  const row1 = await db.emailOutbox.findFirst({});
  check('row marked sent with timestamp and one attempt', row1.status === 'sent' && row1.attempts === 1 && !!row1.sent_at && row1.error === null);
  check('a sent mail is not sent again', (await run()).sent === 0 && sink.box.messages.length === 1);

  await db.emailOutbox.deleteMany({});
  await notifyDetailed(db, [uid.cid.id], { type: 'exam_rescheduled', title: 'Retry me' });
  sink.box.fail = 2;
  const a1 = await run();
  let r = await db.emailOutbox.findFirst({});
  check('attempt 1 fails → stays queued, error stored', a1.retry === 1 && r.status === 'queued' && r.attempts === 1 && /451|Temporary/.test(r.error), r);
  await run(); r = await db.emailOutbox.findFirst({});
  check('attempt 2 fails → still queued', r.status === 'queued' && r.attempts === 2);
  const a3 = await run(); r = await db.emailOutbox.findFirst({});
  check('attempt 3 succeeds → sent (2 failures then success)', a3.sent === 1 && r.status === 'sent' && r.attempts === 3 && r.error === null, r);

  await db.emailOutbox.deleteMany({});
  await notifyDetailed(db, [uid.cid.id], { type: 'exam_rescheduled', title: 'Always failing' });
  sink.box.fail = 10; const sentBefore = sink.box.messages.length;
  for (let i = 0; i < 4; i++) await run();
  r = await db.emailOutbox.findFirst({});
  check('after 3 failed attempts → failed, error kept, no 4th try', r.status === 'failed' && r.attempts === 3 && !!r.error && sink.box.messages.length === sentBefore, [r, sink.box.messages.length, sentBefore]);
  const ob3 = await call('GET', '/notification-center/outbox', { token: OF });
  check('outbox endpoint shows the failure', ob3.body.counts.failed === 1 && ob3.body.items.find(m => m.status === 'failed').error);
  sink.box.fail = 0;
  const rt = await call('POST', '/notification-center/outbox/retry', { token: OF, body: {} });
  check('admin retry re-queues failed mails with a fresh counter', rt.body.requeued === 1 && (await db.emailOutbox.findFirst({})).attempts === 0);
  check('re-queued mail is delivered', (await run()).sent === 1 && (await db.emailOutbox.findFirst({})).status === 'sent');

  await db.emailOutbox.deleteMany({});
  await notifyDetailed(db, [uid.cid.id, uid.tina.id, uid.tom.id], { type: 'broadcast', title: 'Parallel workers' });
  const m0 = sink.box.messages.length;
  await Promise.all([run(), run(), run()]);
  check('concurrent workers never double-send', sink.box.messages.length - m0 === 3 && await db.emailOutbox.count({ where: { status: 'sent' } }) === 3, sink.box.messages.length - m0);

  // The API process has no SMTP (409 above); deliver a broadcast-style batch through the worker directly:
  await db.emailOutbox.deleteMany({});
  const stats = await notifyDetailed(db, (await db.user.findMany({ where: { role: 'teacher' } })).map(u => u.id), { type: 'broadcast', title: 'Teachers only', body: 'Hi', channels: ['email'] });
  const m1 = sink.box.messages.length;
  await run();
  check('batch of broadcast e-mails is delivered, one per recipient', stats.email === 3 && sink.box.messages.length - m1 === 3 && new Set(sink.box.messages.slice(m1).flatMap(x => x.to)).size === 3);

  delete process.env.SMTP_HOST;
  await db.emailOutbox.deleteMany({});
  await db.emailOutbox.create({ data: { id: uuid(), user_id: uid.cid.id, to_email: uid.cid.email, subject: 'After SMTP removed', body: 'b', type: 'broadcast' } });
  const w2 = await mailWorker.runOnce(db);
  const m2 = sink.box.messages.length;
  r = await db.emailOutbox.findFirst({});
  check('SMTP removed → worker marks skipped with reason, nothing sent', w2.skipped === 1 && r.status === 'skipped' && /not configured/i.test(r.error) && mailer.isConfigured() === false && sink.box.messages.length === m2);
  let sendErr; try { await mailer.send({ to: 'a@b.c', subject: 's', text: 't' }); } catch (e) { sendErr = e; }
  check('mailer.send refuses when not configured', /not configured/i.test(sendErr?.message || ''));
  const dead = await db.emailOutbox.create({ data: { id: uuid(), to_email: 'x@y.z', subject: 'dead', body: 'b' } });
  process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = '1';   // nothing listens there
  await mailWorker.runOnce(db);
  const dr = await db.emailOutbox.findUnique({ where: { id: dead.id } });
  check('connection refused is recorded as a failed attempt', dr.attempts === 1 && dr.status === 'queued' && /ECONNREFUSED|connect/i.test(dr.error), dr);
  delete process.env.SMTP_HOST;
  sink.server.close();

  await finish(platformClient);
})().catch(e => { console.error(e); process.exit(1); });
