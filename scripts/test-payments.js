// End-to-end test for the payment system against a LIVE API + a THROWAWAY local Postgres + LOCAL MOCK providers.
//
//   Start the API with the same env as below (providers pointed at 127.0.0.1:4101/4102/4103, JWT_SECRET, PAYMENT_*),
//   then:   node scripts/test-payments.js          (API_URL defaults to http://127.0.0.1:3099)
//
// The mock servers (scripts/lib/payment-mocks.js) imitate the provider HTTP APIs, so this verifies OUR logic —
// verification, idempotency, mismatch handling, timeouts, permissions, audit — not the real providers' sandboxes.
require('dotenv').config();
const Stripe = require('stripe');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to run: DATABASE_URL must be a local scratch database.'); process.exit(2); }
// Same provider configuration as the API under test (the test process also runs the reconciler/sweeps directly).
Object.assign(process.env, {
  API_PUBLIC_URL: 'http://127.0.0.1:3099', FRONTEND_URL: 'http://127.0.0.1:5197',
  MTN_MOMO_API_BASE: 'http://127.0.0.1:4101', MTN_MOMO_SUBSCRIPTION_KEY: 'sub', MTN_MOMO_API_USER: 'user', MTN_MOMO_API_KEY: 'key', MTN_MOMO_TARGET_ENV: 'sandbox',
  ORANGE_MONEY_API_BASE: 'http://127.0.0.1:4102', ORANGE_MONEY_CONSUMER_AUTH: 'Y29uc3VtZXI6c2VjcmV0', ORANGE_MONEY_MERCHANT_KEY: 'mk', ORANGE_MONEY_COUNTRY: 'cm',
  STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_testsecret', STRIPE_CURRENCIES: 'XAF', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: '4103', STRIPE_API_PROTOCOL: 'http',
  BANK_NAME: 'Test Bank', BANK_ACCOUNT_NAME: 'EduTech University', BANK_ACCOUNT_NUMBER: '10005 00001 12345678901 23', PAYMENT_PROVIDER_TIMEOUT_MS: '1500', PAYMENT_WEBHOOK_SECRET: 'whsec-internal', PAYMENT_MIN_AMOUNT: '500',
});
const platformClient = require('../src/db/platformClient');
const tenantPool = require('../src/db/tenantPool');
const { provisionTenantSchema } = require('../src/db/provisionTenant');
const svc = require('../src/payments/service');
const mocks = require('./lib/payment-mocks');

const BASE = process.env.API_URL || 'http://127.0.0.1:3099';
const SECRET = process.env.JWT_SECRET || 'dev_secret';
let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`  [OK]   ${label}`); } else { fail++; console.error(`  [FAIL] ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); } };
const section = t => console.log(`\n── ${t}`);

async function call(method, url, { token, body, form, raw, headers: extra, rawBody } = {}) {
  const headers = { ...(token && { Authorization: `Bearer ${token}` }), ...extra };
  let payload;
  if (form) payload = form; else if (rawBody !== undefined) payload = rawBody; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}/api${url}`, { method, headers, body: payload });
  if (raw) return res;
  let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const mkToken = (schoolId, u) => jwt.sign({ id: u.id, email: u.email, role: u.role, name: u.name, initials: 'XX', teacher_id: u.teacher_id || null, student_id: u.student_id || null, parent_id: null, school_id: schoolId, scope: 'tenant', must_change_password: false }, SECRET, { expiresIn: '1h' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function seed(label) {
  const schoolId = uuid();
  await platformClient.school.create({ data: { id: schoolId, name: `Pay ${label}`, email: `${schoolId}@t.local`, admin_name: 'A', admin_email: `a-${schoolId}@t.local`, status: 'active' } });
  await provisionTenantSchema(schoolId);
  const db = tenantPool.getOrOpen(schoolId);
  await db.school.create({ data: { id: 's1', name: 'EduTech University', email: 'u@t.local', head_teacher: 'H', address: 'Douala' } });
  await db.academicYear.create({ data: { id: uuid(), label: '2026-2027', start_date: '2026-09-01', end_date: '2027-07-31', is_current: true } });
  const cls = await db.class.create({ data: { id: uuid(), name: 'Licence 1' } });
  const mkS = (n, num) => db.student.create({ data: { id: uuid(), student_number: num, first_name: n, last_name: 'Student', class_id: cls.id, class_name: cls.name, is_active: true } });
  const s1 = await mkS('Ann', 'UNI-0001'), s2 = await mkS('Bob', 'UNI-0002'), s3 = await mkS('Cid', 'UNI-0003');
  const teacher = await db.teacher.create({ data: { id: uuid(), first_name: 'T', last_name: 'T', email: `t-${uuid()}@t.local` } });
  const mkU = (name, role, extra = {}) => db.user.create({ data: { id: uuid(), name, email: `${name.toLowerCase()}-${uuid()}@t.local`, password_hash: 'x', role, initials: 'XX', ...extra } });
  const users = { admin: await mkU('Admin', 'super_admin'), head: await mkU('Head', 'head_teacher'), fin: await mkU('Fin', 'finance_officer'), fin2: await mkU('Fin2', 'finance_officer'), teacher: await mkU('Teach', 'teacher', { teacher_id: teacher.id }), parent: await mkU('Par', 'parent'), a1: await mkU('Ann', 'student', { student_id: s1.id }), a2: await mkU('Bob', 'student', { student_id: s2.id }), a3: await mkU('Cid', 'student', { student_id: s3.id }) };
  const inv = async (stu, name, due, dueDate, extra = {}) => db.feeRecord.create({ data: { id: uuid(), student_id: stu.id, student_name: `${stu.first_name} ${stu.last_name}`, student_number: stu.student_number, class_id: cls.id, class_name: cls.name, fee_name: name, academic_year: '2026-2027', amount_due: due, amount_paid: 0, balance: due, status: 'pending', due_date: dueDate, currency: 'XAF', ...extra } });
  const invs = { A: await inv(s1, 'Tuition', 250000, '2099-01-01'), B: await inv(s1, 'Library', 100000, '2020-01-01', { status: 'overdue' }), W: await inv(s1, 'Waived fee', 50000, '2099-01-01', { status: 'waived' }), C: await inv(s2, 'Tuition', 80000, '2099-01-01') };
  const tok = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, mkToken(schoolId, u)]));
  return { schoolId, db, cls, s: { s1, s2, s3 }, users, invs, tok };
}
const fee = (S, id) => S.db.feeRecord.findUnique({ where: { id } });
const payments = (S, feeId) => S.db.payment.findMany({ where: { fee_record_id: feeId }, orderBy: { created_at: 'asc' } });
const stripeSig = payload => new Stripe('sk_test_mock').webhooks.generateTestHeaderString({ payload, secret: 'whsec_testsecret' });
const stripeEvent = (type, session, S, tx, id = `evt_${uuid().slice(0, 12)}`) => JSON.stringify({ id, object: 'event', type, data: { object: { object: 'checkout.session', id: session, metadata: { transaction_id: tx.id, school_id: S.schoolId, reference: tx.reference } } } });

(async () => {
  const MTN = await mocks.mtn(4101), ORA = await mocks.orange(4102), STR = await mocks.stripe(4103);
  const S = await seed('one'), O = await seed('two');
  const { tok, db, invs } = S;
  const start = (token, body) => call('POST', '/payments/me/transactions', { token, body: { idempotency_key: uuid(), ...body } });
  const getTx = (token, id) => call('GET', `/payments/me/transactions/${id}`, { token });

  section('Access control (money data is staff/owner only)');
  check('no token → 401', (await call('GET', '/payments/me/summary')).status === 401);
  check('teacher cannot use student payment API → 403', (await call('GET', '/payments/me/summary', { token: tok.teacher })).status === 403);
  check('parent cannot use student payment API → 403', (await call('GET', '/payments/me/summary', { token: tok.parent })).status === 403);
  check('student cannot read finance dashboard → 403', (await call('GET', '/finance/summary', { token: tok.a1 })).status === 403);
  check('teacher cannot read finance dashboard → 403', (await call('GET', '/finance/summary', { token: tok.teacher })).status === 403);
  check('finance officer CAN read finance dashboard', (await call('GET', '/finance/summary', { token: tok.fin })).status === 200);
  check('finance officer cannot use the student API → 403', (await call('GET', '/payments/me/summary', { token: tok.fin })).status === 403);
  check('finance officer cannot manage users → 403', (await call('GET', '/users', { token: tok.fin })).status === 403);
  check('REGRESSION: a student can no longer list every student\'s fees via /fees → 403', (await call('GET', '/fees', { token: tok.a1 })).status === 403);
  check('REGRESSION: a student cannot self-record a payment via /fees/:id/payments → 403', (await call('POST', `/fees/${invs.A.id}/payments`, { token: tok.a1, body: { amount: 250000, method: 'cash' } })).status === 403);
  check('teacher cannot list fees → 403', (await call('GET', '/fees', { token: tok.teacher })).status === 403);
  check('admin & finance can list fees', (await call('GET', '/fees', { token: tok.admin })).status === 200 && (await call('GET', '/fees', { token: tok.fin })).status === 200);

  section('Student summary (computed from verified records)');
  let r = await call('GET', '/payments/me/summary', { token: tok.a1 });
  check('summary 200 with student identity', r.status === 200 && r.body.student.matricule === 'UNI-0001' && r.body.student.class_name === 'Licence 1', r.body.student);
  check('current academic year used', r.body.academic_year === '2026-2027');
  check('totals exclude waived invoices: due 350000, paid 0, balance 350000', r.body.totals.due === 350000 && r.body.totals.paid === 0 && r.body.totals.balance === 350000, r.body.totals);
  check('overdue amount = the past-due Library invoice (100000)', r.body.totals.overdue === 100000, r.body.totals);
  check('invoices listed with numbers; other student\'s invoice absent', r.body.invoices.length === 3 && r.body.invoices.every(i => /^INV-/.test(i.number)) && !r.body.invoices.some(i => i.id === invs.C.id));
  check('upcoming deadlines include the overdue one first', r.body.upcoming[0]?.overdue === true);
  check('all 4 methods listed and configured (mock env)', r.body.methods.length === 4 && r.body.methods.every(m => m.configured), r.body.methods.map(m => [m.id, m.configured]));
  check('bank details exposed to students (public info), secrets are not', !!r.body.methods.find(m => m.id === 'bank_transfer').bank && !JSON.stringify(r.body).includes('sk_test') && !JSON.stringify(r.body).includes('whsec'));
  check('summary is never cacheable', /no-store/.test((await call('GET', '/payments/me/summary', { token: tok.a1, raw: true })).headers.get('cache-control') || ''));
  r = await call('GET', '/payments/me/summary', { token: tok.a3 });
  check('student with no invoices → zero totals', r.status === 200 && r.body.totals.balance === 0 && r.body.invoices.length === 0);

  section('Starting a payment: server-side validation');
  const bad = async (label, body, code, token = tok.a1) => { const x = await start(token, { provider: 'mtn_momo', phone: '670000001', ...body }); check(label, x.status === code, x); return x; };
  await bad('amount above balance → 422', { invoice_id: invs.A.id, amount: 250001 }, 422);
  await bad('zero / negative amount → 422', { invoice_id: invs.A.id, amount: 0 }, 422);
  await bad('non-integer XAF → 422', { invoice_id: invs.A.id, amount: 1000.5 }, 422);
  await bad('below minimum → 422', { invoice_id: invs.A.id, amount: 100 }, 422);
  await bad('NaN amount → 422', { invoice_id: invs.A.id, amount: 'abc' }, 422);
  await bad("someone else's invoice → 404", { invoice_id: invs.C.id, amount: 1000 }, 404);
  await bad('waived invoice → 422', { invoice_id: invs.W.id, amount: 1000 }, 422);
  await bad('unknown invoice → 404', { invoice_id: uuid(), amount: 1000 }, 404);
  await bad('unknown provider → 422', { invoice_id: invs.A.id, amount: 1000, provider: 'paypal' }, 422);
  await bad('MTN without a valid phone → 422', { invoice_id: invs.A.id, amount: 1000, phone: '12' }, 422);
  await bad('a student without invoice id → 404', { amount: 1000 }, 404);
  check('no transaction row was created by rejected requests', (await db.paymentTransaction.count()) === 0);

  section('MTN Mobile Money: full lifecycle');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 100000, provider: 'mtn_momo', phone: '6 70 00 00 01' });
  check('payment started → 201 pending with reference', r.status === 201 && r.body.status === 'pending' && /^EDU-\d{4}-[A-HJ-NP-Z2-9]{7}$/.test(r.body.reference), r.body);
  const mtn1 = r.body;
  check('phone normalised to MSISDN 237…; response hides provider internals', mtn1.payer_phone === '237670000001' && !('provider_secret' in mtn1) && !('receipt_data' in mtn1));
  const mreq = MTN.byExternal(mtn1.reference);
  check('provider got the right amount/currency/payer/callback', mreq && mreq.body.amount === '100000' && mreq.body.currency === 'XAF' && mreq.body.payer.partyId === '237670000001' && /\/api\/payments\/webhooks\/mtn_momo\/.+\/EDU-.+\?t=/.test(mreq.callback || ''), mreq);
  check('invoice NOT credited at initiation', (await fee(S, invs.A.id)).amount_paid === 0);
  r = await getTx(tok.a1, mtn1.id);
  check('status poll while provider says PENDING → still pending, not credited', r.body.status === 'pending' && (await fee(S, invs.A.id)).amount_paid === 0, r.body.status);
  check('summary shows the in-flight amount separately from paid', (await call('GET', '/payments/me/summary', { token: tok.a1 })).body.totals.pending === 100000);
  check('other student cannot see this transaction → 404', (await getTx(tok.a2, mtn1.id)).status === 404);
  check('idempotent retry with the same key returns the SAME transaction', await (async () => { const key = uuid(); const a = await start(tok.a1, { invoice_id: invs.B.id, amount: 1000, provider: 'mtn_momo', phone: '670000001', idempotency_key: key }); const b = await start(tok.a1, { invoice_id: invs.B.id, amount: 1000, provider: 'mtn_momo', phone: '670000001', idempotency_key: key }); await call('POST', `/payments/me/transactions/${a.body.id}/cancel`, { token: tok.a1 }); return a.status === 201 && b.status === 200 && a.body.id === b.body.id && (await db.paymentTransaction.count({ where: { idempotency_key: key } })) === 1; })());
  MTN.set(mtn1.reference, { status: 'SUCCESSFUL' });
  const results = await Promise.all(Array.from({ length: 10 }, () => getTx(tok.a1, mtn1.id)));
  check('10 CONCURRENT status checks after provider success → all see successful', results.every(x => x.status === 200 && x.body.status === 'successful'), results.map(x => x.body.status));
  const pA = await payments(S, invs.A.id);
  check('…yet exactly ONE payment/receipt was created (no double credit)', pA.length === 1 && pA[0].amount === 100000 && /^RC-\d{4}-\d{6}$/.test(pA[0].receipt_number) && pA[0].transaction_id === mtn1.id, pA);
  let fa = await fee(S, invs.A.id);
  check('invoice credited exactly once: paid 100000 / balance 150000 / partial', fa.amount_paid === 100000 && fa.balance === 150000 && fa.status === 'partial', fa);
  const dbtx = await db.paymentTransaction.findUnique({ where: { id: mtn1.id }, include: { events: true } });
  check('transaction links to its payment; provider txn id stored; history recorded', dbtx.payment_id === pA[0].id && /^fin-/.test(dbtx.provider_txn_id) && dbtx.events.map(e => e.to_status).includes('successful') && dbtx.events.length >= 3, dbtx.events.map(e => e.to_status));
  const cb = `/payments/webhooks/mtn_momo/${S.schoolId}/${mtn1.reference}?t=${svc.callbackToken(mtn1.reference)}`;
  r = await call('PUT', cb, { body: { status: 'SUCCESSFUL' } }); const r2 = await call('PUT', cb, { body: { status: 'SUCCESSFUL' } });
  check('duplicate / repeated provider callbacks are accepted but change nothing', r.status === 200 && r2.status === 200 && (await payments(S, invs.A.id)).length === 1 && (await fee(S, invs.A.id)).amount_paid === 100000);
  check('callbacks are recorded for audit', (await db.paymentWebhookEvent.count({ where: { provider: 'mtn_momo' } })) >= 1);
  check('callback with a wrong token → 401', (await call('PUT', `/payments/webhooks/mtn_momo/${S.schoolId}/${mtn1.reference}?t=deadbeef`, { body: {} })).status === 401);
  check('callback with no token → 401', (await call('PUT', `/payments/webhooks/mtn_momo/${S.schoolId}/${mtn1.reference}`, { body: {} })).status === 401);
  check('cannot cancel an already successful payment → 409', (await call('POST', `/payments/me/transactions/${mtn1.id}/cancel`, { token: tok.a1 })).status === 409);

  section('MTN: a forged "success" never credits');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 50000, provider: 'mtn_momo', phone: '670000001' });
  const mtn2 = r.body;
  const forged = `/payments/webhooks/mtn_momo/${S.schoolId}/${mtn2.reference}?t=${svc.callbackToken(mtn2.reference)}`;
  await call('PUT', forged, { body: { status: 'SUCCESSFUL', amount: 50000, financialTransactionId: 'FAKE' } });
  check('callback CLAIMING success while MTN still says PENDING → not credited', (await db.paymentTransaction.findUnique({ where: { id: mtn2.id } })).status === 'pending' && (await fee(S, invs.A.id)).amount_paid === 100000);
  MTN.set(mtn2.reference, { status: 'FAILED', reason: 'PAYER_LIMIT_REACHED' });
  r = await getTx(tok.a1, mtn2.id);
  check('provider FAILED → transaction failed, reason kept, invoice untouched', r.body.status === 'failed' && /LIMIT/.test(r.body.failure_reason || '') && (await fee(S, invs.A.id)).amount_paid === 100000, r.body);
  check('a failed attempt can be retried (new transaction)', (await start(tok.a1, { invoice_id: invs.A.id, amount: 50000, provider: 'mtn_momo', phone: '670000001' })).status === 201);

  section('MTN: provider problems');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 1000, provider: 'mtn_momo', phone: '670000098' });
  check('provider 500 → clean 502 message, transaction failed (not stuck)', r.status === 502 && !/upstream|stack/i.test(r.body.error), r);
  check('…and nothing leaked about the provider response', !JSON.stringify(r.body).includes('upstream failure'));
  const before = await db.paymentTransaction.count();
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 1000, provider: 'mtn_momo', phone: '670000099' });
  check('provider TIMEOUT → 202 "keep checking", transaction kept as pending (not failed)', r.status === 202 && r.body.code === 'provider_slow', r);
  const slowTx = await db.paymentTransaction.findFirst({ orderBy: { created_at: 'desc' } });
  check('timed-out attempt stays pending for the reconciler', slowTx.status === 'pending' && (await db.paymentTransaction.count()) === before + 1);
  await call('POST', `/payments/me/transactions/${slowTx.id}/cancel`, { token: tok.a1 });

  section('Open-transaction limits & rate limiting');
  const mk = i => start(tok.a2, { invoice_id: invs.C.id, amount: 1000 + i, provider: 'mtn_momo', phone: '670000002' });
  const many = [await mk(1), await mk(2), await mk(3), await mk(4)];
  check('3 open attempts per invoice allowed, the 4th → 409', many.slice(0, 3).every(x => x.status === 201) && many[3].status === 409 && many[3].body.code === 'too_many_open', many.map(x => x.status));
  for (const x of many.slice(0, 3)) await call('POST', `/payments/me/transactions/${x.body.id}/cancel`, { token: tok.a2 });
  check('cancelling frees the slots', (await mk(5)).status === 201);

  section('Expiry, late confirmation, reconciler');
  r = await start(tok.a1, { invoice_id: invs.B.id, amount: 40000, provider: 'mtn_momo', phone: '670000001' });
  const exp = r.body;
  await db.paymentTransaction.update({ where: { id: exp.id }, data: { expires_at: new Date(Date.now() - 60_000), created_at: new Date(Date.now() - 3600_000), updated_at: new Date(Date.now() - 600_000) } });
  await svc.sweepOpen(db);
  check('sweep: unconfirmed attempt past its deadline → expired', (await db.paymentTransaction.findUnique({ where: { id: exp.id } })).status === 'expired');
  check('…invoice untouched', (await fee(S, invs.B.id)).amount_paid === 0);
  MTN.set(exp.reference, { status: 'SUCCESSFUL' });
  await call('PUT', `/payments/webhooks/mtn_momo/${S.schoolId}/${exp.reference}?t=${svc.callbackToken(exp.reference)}`, { body: {} });
  const late = await db.paymentTransaction.findUnique({ where: { id: exp.id } });
  check('LATE success after expiry (money was taken) → credited, flagged for review', late.status === 'successful' && late.needs_review && /after the transaction was marked expired/.test(late.review_note || '') && (await fee(S, invs.B.id)).amount_paid === 40000, late);
  r = await start(tok.a1, { invoice_id: invs.B.id, amount: 10000, provider: 'mtn_momo', phone: '670000001' });
  await db.paymentTransaction.update({ where: { id: r.body.id }, data: { created_at: new Date(Date.now() - 3600_000), updated_at: new Date(Date.now() - 600_000) } });
  MTN.set(r.body.reference, { status: 'SUCCESSFUL' });
  await svc.sweepOpen(db);
  check('sweep also confirms payments whose callback was lost', (await db.paymentTransaction.findUnique({ where: { id: r.body.id } })).status === 'successful' && (await fee(S, invs.B.id)).amount_paid === 50000);

  section('Amount / currency mismatch from the provider');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 20000, provider: 'mtn_momo', phone: '670000001' });
  MTN.set(r.body.reference, { status: 'SUCCESSFUL', amount: '1000' });
  const paidBefore = (await fee(S, invs.A.id)).amount_paid;
  const mm = await getTx(tok.a1, r.body.id);
  const mmRow = await db.paymentTransaction.findUnique({ where: { id: r.body.id } });
  check('provider reports a DIFFERENT amount → NOT credited, flagged', mm.body.status !== 'successful' && mmRow.needs_review && /expected 20000/.test(mmRow.review_note || '') && (await fee(S, invs.A.id)).amount_paid === paidBefore, mmRow.review_note);
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 20000, provider: 'mtn_momo', phone: '670000001' });
  MTN.set(r.body.reference, { status: 'SUCCESSFUL', currency: 'EUR' });
  await getTx(tok.a1, r.body.id);
  check('provider reports a DIFFERENT currency → NOT credited', (await db.paymentTransaction.findUnique({ where: { id: r.body.id } })).status !== 'successful' && (await fee(S, invs.A.id)).amount_paid === paidBefore);

  section('Overpayment protection');
  const invD = await db.feeRecord.create({ data: { id: uuid(), student_id: S.s.s3.id, student_name: 'Cid Student', student_number: 'UNI-0003', fee_name: 'Lab', academic_year: '2026-2027', amount_due: 10000, amount_paid: 0, balance: 10000, status: 'pending', due_date: '2099-01-01', currency: 'XAF' } });
  const o1 = (await start(tok.a3, { invoice_id: invD.id, amount: 8000, provider: 'orange_money' })).body;
  const o2 = (await start(tok.a3, { invoice_id: invD.id, amount: 8000, provider: 'orange_money' })).body;
  check('two parallel attempts of 8000 on a 10000 invoice are allowed to START', !!o1.id && !!o2.id);
  ORA.set(o1.reference, 'SUCCESS'); ORA.set(o2.reference, 'SUCCESS');
  await Promise.all([getTx(tok.a3, o1.id), getTx(tok.a3, o2.id)]);
  const fd = await fee(S, invD.id);
  check('both settle (money really arrived): invoice paid, balance floors at 0, never negative', fd.balance === 0 && fd.amount_paid === 16000 && fd.status === 'paid', fd);
  check('the overpayment is FLAGGED for a finance officer to refund', (await db.paymentTransaction.count({ where: { fee_record_id: invD.id, needs_review: true } })) === 1);

  // housekeeping: earlier sections intentionally left a few attempts open — close them so the per-invoice limit doesn't interfere
  await db.paymentTransaction.updateMany({ where: { status: { in: ['initiated', 'pending', 'processing', 'awaiting_verification'] }, provider: { not: 'bank_transfer' } }, data: { status: 'cancelled' } });

  section('Orange Money (redirect flow)');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 60000, provider: 'orange_money' });
  const or1 = r.body;
  check('Orange payment started → redirect URL returned', r.status === 201 && /\/pay\/pt-/.test(or1.checkout_url), r.body);
  const oOrder = ORA.state.orders[or1.reference];
  check('provider got order id, amount, return/cancel/notify URLs', oOrder && oOrder.amount === 60000 && /\/student\/fees\?ref=/.test(oOrder.return_url) && /cancelled=1/.test(oOrder.cancel_url) && /webhooks\/orange_money/.test(oOrder.notif_url), oOrder);
  check('notif_token (secret) is NOT sent to the browser', !JSON.stringify(or1).includes(oOrder.notif_token));
  r = await getTx(tok.a1, or1.id);
  check('user "returns from Orange" while status is PENDING → nothing credited', r.body.status === 'pending' && (await fee(S, invs.A.id)).amount_paid === paidBefore);
  const ocb = `/payments/webhooks/orange_money/${S.schoolId}/${or1.reference}?t=${svc.callbackToken(or1.reference)}`;
  check('notification with a WRONG notif_token → 401', (await call('POST', ocb, { body: { status: 'SUCCESS', notif_token: 'nope', txnid: 'X' } })).status === 401);
  ORA.set(or1.reference, 'SUCCESS');
  check('notification with the right token triggers a server-side check', (await call('POST', ocb, { body: { status: 'SUCCESS', notif_token: oOrder.notif_token, txnid: 'MP1' } })).status === 200);
  const orow = await db.paymentTransaction.findUnique({ where: { id: or1.id } });
  check('→ successful, credited once, receipt issued', orow.status === 'successful' && (await fee(S, invs.A.id)).amount_paid === paidBefore + 60000 && (await payments(S, invs.A.id)).length === 2);
  await call('POST', ocb, { body: { status: 'SUCCESS', notif_token: oOrder.notif_token, txnid: 'MP1' } });
  check('replayed notification → no second credit', (await fee(S, invs.A.id)).amount_paid === paidBefore + 60000);
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 1000, provider: 'orange_money' });
  ORA.set(r.body.reference, 'EXPIRED'); const ex = await getTx(tok.a1, r.body.id);
  check('Orange EXPIRED → expired status with a helpful hint', ex.body.status === 'expired');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 1000, provider: 'orange_money' });
  const can = await call('POST', `/payments/me/transactions/${r.body.id}/cancel`, { token: tok.a1 });
  check('student can cancel a pending Orange payment → cancelled', can.body.status === 'cancelled');
  check('webhook for an unknown school/reference is acknowledged but harmless', (await call('POST', `/payments/webhooks/orange_money/${uuid()}/EDU-0000-AAAAAAA?t=${svc.callbackToken('EDU-0000-AAAAAAA')}`, { body: {} })).status === 200);

  section('Stripe Checkout');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 30000, provider: 'stripe' });
  const st1 = r.body;
  check('Stripe session created → hosted checkout URL', r.status === 201 && /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/.test(st1.checkout_url), r.body);
  const sess = STR.byReference(st1.reference);
  check('session has the right amount (zero-decimal XAF: 30000, not ×100), currency, metadata, expiry', sess.amount_total === 30000 && sess.currency === 'xaf' && sess.metadata.transaction_id === st1.id && sess.metadata.school_id === S.schoolId, sess);
  const payload1 = stripeEvent('checkout.session.completed', sess.id, S, st1);
  check('webhook with NO signature → 400', (await call('POST', '/payments/webhooks/stripe', { rawBody: payload1, headers: { 'Content-Type': 'application/json' } })).status === 400);
  check('webhook with a FORGED signature → 400', (await call('POST', '/payments/webhooks/stripe', { rawBody: payload1, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abcdef' } })).status === 400);
  check('webhook with a valid signature over a TAMPERED body → 400', (await call('POST', '/payments/webhooks/stripe', { rawBody: payload1.replace('completed', 'completeD'), headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSig(payload1) } })).status === 400);
  check('no credit from rejected webhooks', (await db.paymentTransaction.findUnique({ where: { id: st1.id } })).status === 'pending');
  const hook = (payload, id) => call('POST', '/payments/webhooks/stripe', { rawBody: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSig(payload) } });
  check('validly SIGNED "completed" event while Stripe says UNPAID → acknowledged, NOT credited', (await hook(payload1)).status === 200 && (await db.paymentTransaction.findUnique({ where: { id: st1.id } })).status === 'pending');
  const prePaid = (await fee(S, invs.A.id)).amount_paid;
  STR.pay(sess.id);
  const evId = `evt_${uuid().slice(0, 10)}`;
  const payload2 = stripeEvent('checkout.session.completed', sess.id, S, st1, evId);
  const h1 = await hook(payload2), h2 = await hook(payload2), h3 = await hook(payload2);
  check('signed event + session really paid → credited; re-delivered 3× → still ONE credit', h1.status === 200 && h2.status === 200 && h3.status === 200 && (await fee(S, invs.A.id)).amount_paid === prePaid + 30000 && (await db.payment.count({ where: { transaction_id: st1.id } })) === 1);
  check('Stripe events recorded exactly once (unique event id)', (await db.paymentWebhookEvent.count({ where: { provider: 'stripe', event_id: evId } })) === 1);
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 5000, provider: 'stripe' });
  const st2 = r.body; const sess2 = STR.byReference(st2.reference);
  STR.pay(sess2.id, { amount_total: 4000 });
  await hook(stripeEvent('checkout.session.completed', sess2.id, S, st2));
  const st2row = await db.paymentTransaction.findUnique({ where: { id: st2.id } });
  check('Stripe amount_total differs from what we asked → NOT credited, flagged', st2row.status !== 'successful' && st2row.needs_review);
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 5000, provider: 'stripe' });
  const sess3 = STR.byReference(r.body.reference);
  STR.set(sess3.id, { status: 'expired' });
  await hook(stripeEvent('checkout.session.expired', sess3.id, S, r.body));
  check('checkout.session.expired → expired', (await db.paymentTransaction.findUnique({ where: { id: r.body.id } })).status === 'expired');
  r = await start(tok.a1, { invoice_id: invs.A.id, amount: 5000, provider: 'stripe' });
  const c2 = await call('POST', `/payments/me/transactions/${r.body.id}/cancel`, { token: tok.a1 });
  check('student cancel → Stripe session is expired too', c2.body.status === 'cancelled' && STR.byReference(r.body.reference).status === 'expired');
  check('unrelated event types are ignored (200)', (await hook(JSON.stringify({ id: 'evt_x1', object: 'event', type: 'customer.created', data: { object: { object: 'customer', id: 'cus_1', metadata: { transaction_id: st1.id, school_id: S.schoolId } } } }))).status === 200);

  section('Bank transfer: manual verification, never auto-credited');
  r = await start(tok.a2, { invoice_id: invs.C.id, amount: 30000, provider: 'bank_transfer' });
  const bk = r.body;
  check('bank transfer → pending with official details + reference', r.status === 201 && bk.status === 'pending' && bk.bank?.account_name === 'EduTech University' && bk.bank?.swift === 'TESTCMCX', r.body);
  const slip = (name = 'slip.png', type = 'image/png', size = 500) => { const f = new FormData(); f.append('receipt', new Blob([Buffer.alloc(size, 1)], { type }), name); f.append('bank_reference', 'OP-7788'); return f; };
  check('student B cannot upload to A\'s transfer → 404', (await call('POST', `/payments/me/transactions/${bk.id}/receipt`, { token: tok.a1, form: slip() })).status === 404);
  check('.exe slip rejected → 422', (await call('POST', `/payments/me/transactions/${bk.id}/receipt`, { token: tok.a2, form: slip('x.exe', 'application/x-msdownload') })).status === 422);
  check('.html slip rejected → 422', (await call('POST', `/payments/me/transactions/${bk.id}/receipt`, { token: tok.a2, form: slip('x.html', 'text/html') })).status === 422);
  check('oversize slip (6 MB) → 413', (await call('POST', `/payments/me/transactions/${bk.id}/receipt`, { token: tok.a2, form: slip('big.pdf', 'application/pdf', 6 * 1024 * 1024) })).status === 413);
  r = await call('POST', `/payments/me/transactions/${bk.id}/receipt`, { token: tok.a2, form: slip() });
  check('valid slip → "awaiting_verification" and STILL not credited', r.status === 200 && r.body.status === 'awaiting_verification' && r.body.has_receipt && (await fee(S, invs.C.id)).amount_paid === 0, r.body);
  check('slip bytes are not returned to the student API', !JSON.stringify(r.body).includes('receipt_data'));
  check('student cannot approve own transfer (no such route for students) → 403', (await call('POST', `/finance/transactions/${bk.id}/review`, { token: tok.a2, body: { decision: 'approve' } })).status === 403);
  check('finance can list pending bank transfers', (await call('GET', '/finance/reconcile/pending', { token: tok.fin })).body.some(t => t.id === bk.id));
  const slipRes = await call('GET', `/finance/transactions/${bk.id}/receipt-file`, { token: tok.fin, raw: true });
  check('finance can view the uploaded slip (nosniff + sandbox CSP)', slipRes.status === 200 && slipRes.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(slipRes.headers.get('content-security-policy')));
  check('student cannot view slips via finance route → 403', (await call('GET', `/finance/transactions/${bk.id}/receipt-file`, { token: tok.a2 })).status === 403);
  check('reject WITHOUT a reason → 422', (await call('POST', `/finance/transactions/${bk.id}/review`, { token: tok.fin, body: { decision: 'reject' } })).status === 422);
  const apps = await Promise.all([call('POST', `/finance/transactions/${bk.id}/review`, { token: tok.fin, body: { decision: 'approve', reason: 'seen on statement' } }), call('POST', `/finance/transactions/${bk.id}/review`, { token: tok.fin2, body: { decision: 'approve' } })]);
  check('two finance officers approve at the same instant → exactly one wins (200 + 409)', apps.map(a => a.status).sort().join() === '200,409', apps.map(a => a.status));
  check('→ credited ONCE with a receipt', (await fee(S, invs.C.id)).amount_paid === 30000 && (await db.payment.count({ where: { transaction_id: bk.id } })) === 1);
  check('approval is audited with actor + reason', await db.financeAudit.count({ where: { action: 'bank_transfer.approve', target_id: bk.id } }) === 1);
  r = await start(tok.a2, { invoice_id: invs.C.id, amount: 20000, provider: 'bank_transfer' });
  r = await call('POST', `/finance/transactions/${r.body.id}/review`, { token: tok.fin, body: { decision: 'reject', reason: 'No such transfer on the statement' } });
  check('rejected transfer → failed with the reason shown to the student, no credit', r.body.transaction.status === 'failed' && (await fee(S, invs.C.id)).amount_paid === 30000);

  section('Bank reconciliation by statement import');
  const rb = (await start(tok.a2, { invoice_id: invs.C.id, amount: 10000, provider: 'bank_transfer' })).body;
  const rb2 = (await start(tok.a2, { invoice_id: invs.C.id, amount: 5000, provider: 'bank_transfer' })).body;
  const csv = `Date;Libellé;Crédit\n2026-10-12;VIR ${rb.reference} UNI-0002;10 000\n2026-10-12;VIR ${rb2.reference};4 000\n2026-10-13;VIR EDU-9999-ABCDEFG;5000\n2026-10-13;Frais bancaires;-500\n2026-10-14;VIR ${bk.reference};30000\n`;
  r = await call('POST', '/finance/reconcile/import', { token: tok.fin, body: { csv } });
  check('dry run classifies rows: 1 matched, 1 amount mismatch, 1 not found, 1 no reference, 1 already processed', r.status === 200 && r.body.counts.matched === 1 && r.body.counts.amount_mismatch === 1 && r.body.counts.not_found === 1 && r.body.counts.no_reference === 1 && r.body.counts.already_processed === 1, r.body.counts);
  check('dry run credits NOTHING', (await fee(S, invs.C.id)).amount_paid === 30000);
  r = await call('POST', '/finance/reconcile/import?apply=true', { token: tok.fin, body: { csv } });
  check('apply → the exact match is approved, the mismatch is NOT', r.body.counts.applied === 1 && (await fee(S, invs.C.id)).amount_paid === 40000 && (await db.paymentTransaction.findUnique({ where: { id: rb2.id } })).status === 'pending');
  r = await call('POST', '/finance/reconcile/import?apply=true', { token: tok.fin, body: { csv } });
  check('re-applying the same statement is harmless (idempotent)', r.body.counts.applied === 0 && (await fee(S, invs.C.id)).amount_paid === 40000);
  check('students cannot import statements → 403', (await call('POST', '/finance/reconcile/import', { token: tok.a2, body: { csv } })).status === 403);
  check('text/csv body also accepted', (await call('POST', '/finance/reconcile/import', { token: tok.fin, rawBody: csv, headers: { 'Content-Type': 'text/csv' } })).status === 200);

  section('Finance: manual payments, refunds, adjustments (audited & role-restricted)');
  r = await call('POST', '/finance/payments/manual', { token: tok.fin, body: { fee_record_id: invs.B.id, amount: 20000, method: 'cash' } });
  check('manual payment WITHOUT a reason → 422', r.status === 422);
  r = await call('POST', '/finance/payments/manual', { token: tok.fin, body: { fee_record_id: invs.B.id, amount: 20000, method: 'cash', reason: 'Cash at the bursar desk, slip 123' } });
  check('manual payment with a reason → 201, receipt issued, invoice updated', r.status === 201 && r.body.payment.receipt_number && (await fee(S, invs.B.id)).amount_paid === 70000, r.body);
  const manualPay = r.body.payment;
  check('manual payment audited (who, why, before/after)', await (async () => { const a = await db.financeAudit.findFirst({ where: { action: 'payment.manual', target_id: manualPay.id } }); return a && a.reason.includes('slip 123') && a.actor_role === 'finance_officer' && a.before.amount_paid === 50000 && a.after.amount_paid === 70000; })());
  check('legacy /fees/:id/payments goes through the same audited ledger', (await call('POST', `/fees/${invs.B.id}/payments`, { token: tok.admin, body: { amount: 1000, method: 'cash' } })).status === 201 && await db.financeAudit.count({ where: { action: 'payment.manual' } }) === 2);
  check('manual payment on a non-integer XAF amount → 422', (await call('POST', '/finance/payments/manual', { token: tok.fin, body: { fee_record_id: invs.B.id, amount: 10.5, method: 'cash', reason: 'x' } })).status === 422);
  const mt = await db.payment.findFirst({ where: { transaction_id: mtn1.id } });
  check('FINANCE OFFICER cannot refund → 403', (await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.fin, body: { reason: 'x' } })).status === 403);
  check('student cannot refund → 403', (await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.a1, body: { reason: 'x' } })).status === 403);
  check('refund without a reason → 422', (await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.admin, body: { amount: 1000 } })).status === 422);
  check('refund above the paid amount → 422', (await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.admin, body: { amount: 100001, reason: 'too much' } })).status === 422);
  const balBefore = (await fee(S, invs.A.id));
  r = await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.admin, body: { amount: 40000, reason: 'Duplicate payment by parent' } });
  check('partial refund → 201; invoice paid/balance corrected', r.status === 201 && (await fee(S, invs.A.id)).amount_paid === balBefore.amount_paid - 40000 && (await fee(S, invs.A.id)).balance === balBefore.balance + 40000, r.body);
  check('refund is a NEGATIVE ledger row linked to the original payment', await (async () => { const rf = await db.payment.findFirst({ where: { reverses_payment_id: mt.id } }); return rf && rf.amount === -40000 && rf.kind === 'refund'; })());
  check('refund audited with reason', await db.financeAudit.count({ where: { action: 'payment.refund', target_id: mt.id } }) === 1);
  check('over-refunding the remainder → 422 (only 60000 left)', (await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.head, body: { amount: 60001, reason: 'again' } })).status === 422);
  r = await call('POST', `/finance/payments/${mt.id}/refund`, { token: tok.head, body: { reason: 'Student withdrew (head teacher)' } });
  check('head_teacher (admin alias) can refund the rest → transaction becomes "refunded"', r.status === 201 && (await db.paymentTransaction.findUnique({ where: { id: mtn1.id } })).status === 'refunded');
  const stPay = await db.payment.findFirst({ where: { transaction_id: st1.id } });
  r = await call('POST', `/finance/payments/${stPay.id}/refund`, { token: tok.admin, body: { amount: 10000, reason: 'Goodwill', provider_refund: true } });
  check('Stripe payment refunded THROUGH Stripe (mock saw the refund call, correct minor amount)', r.status === 201 && STR.state.refunds.length === 1 && STR.state.refunds[0].amount === 10000 && r.body.provider?.providerRefundId);
  check('provider refund requested for a non-Stripe payment → 422', (await call('POST', `/finance/payments/${manualPay.id}/refund`, { token: tok.admin, body: { amount: 1000, reason: 'x', provider_refund: true } })).status === 422);
  check('invoice adjust: finance officer → 403', (await call('POST', `/finance/invoices/${invs.C.id}/adjust`, { token: tok.fin, body: { amount_due: 50000, reason: 'scholarship' } })).status === 403);
  r = await call('POST', `/finance/invoices/${invs.C.id}/adjust`, { token: tok.admin, body: { amount_due: 60000, reason: 'Scholarship discount' } });
  check('admin adjusts the invoice (reason mandatory) → balance recomputed, audited', r.status === 200 && r.body.amount_due === 60000 && r.body.balance === 20000 && await db.financeAudit.count({ where: { action: 'invoice.adjust' } }) === 1, r.body);
  check('adjust without a reason → 422', (await call('POST', `/finance/invoices/${invs.C.id}/adjust`, { token: tok.admin, body: { amount_due: 1 } })).status === 422);
  check('duplicate invoice (same student, fee, year) → 409', (await call('POST', '/fees', { token: tok.admin, body: { studentId: S.s.s1.id, feeName: 'tuition', academicYear: '2026-2027', amountDue: 1000 } })).status === 409);
  r = await call('POST', '/fees', { token: tok.fin, body: { studentId: S.s.s1.id, feeName: 'Sports', academicYear: '2026-2027', amountDue: 15000, dueDate: '2099-02-02' } });
  check('finance officer can create an invoice (currency stamped, audited)', r.status === 201 && r.body.currency === 'XAF' && await db.financeAudit.count({ where: { action: 'invoice.create' } }) === 1, r.body);

  section('Receipts');
  r = await call('GET', `/payments/me/payments/${mt.id}/receipt`, { token: tok.a1 });
  check('student gets receipt data for their payment', r.status === 200 && r.body.receipt_number === mt.receipt_number && r.body.student.matricule === 'UNI-0001' && r.body.school.name === 'EduTech University' && r.body.payment.amount === 100000, r.body);
  check("another student cannot read it → 404", (await call('GET', `/payments/me/payments/${mt.id}/receipt`, { token: tok.a2 })).status === 404);
  check('finance can read any receipt', (await call('GET', `/finance/payments/${mt.id}/receipt`, { token: tok.fin })).status === 200);
  check('student payment list shows refunds as negative rows', (await call('GET', '/payments/me/payments', { token: tok.a1 })).body.some(p => p.kind === 'refund' && p.amount < 0));
  const nums = (await db.payment.findMany({ select: { receipt_number: true } })).map(p => p.receipt_number).filter(Boolean);
  check('receipt numbers are unique across all payments', new Set(nums).size === nums.length, nums.length);

  section('Finance dashboard & reporting');
  r = await call('GET', '/finance/summary', { token: tok.fin });
  const dueAll = (await db.feeRecord.aggregate({ where: { status: { not: 'waived' } }, _sum: { amount_due: true, amount_paid: true, balance: true } }))._sum;
  check('summary totals equal the database ledger (expected / collected / outstanding)', r.body.expected === dueAll.amount_due && r.body.collected === dueAll.amount_paid && r.body.outstanding === dueAll.balance, [r.body.expected, dueAll]);
  const netPayments = (await db.payment.aggregate({ _sum: { amount: true } }))._sum.amount;
  check('"collected this year" = net of payments and refunds in the ledger', r.body.collections.year === netPayments, [r.body.collections, netPayments]);
  check('by_method breakdown sums to the net ledger', r.body.by_method.reduce((s, m) => s + m.amount, 0) === netPayments);
  check('needs_attention counts flagged items (overpayment, late, mismatch)', r.body.needs_attention.needs_review >= 3, r.body.needs_attention);
  check('by_class / by_academic_year present', r.body.by_class.length >= 1 && r.body.by_academic_year[0].academic_year === '2026-2027');
  check('provider status lists variable NAMES only', await (async () => { const p = await call('GET', '/finance/providers', { token: tok.fin }); return p.status === 200 && p.body.length === 4 && !JSON.stringify(p.body).match(/sk_test|whsec|Y29uc3VtZXI/); })());
  r = await call('GET', '/finance/transactions?limit=5&page=1', { token: tok.fin });
  check('transactions: paginated with total', r.status === 200 && r.body.items.length === 5 && r.body.total > 5 && r.body.limit === 5);
  check('transactions never expose secrets or slip bytes', !JSON.stringify(r.body).match(/provider_secret|receipt_data|idempotency/));
  r = await call('GET', `/finance/transactions?status=successful&provider=mtn_momo`, { token: tok.fin });
  check('filter by status + provider', r.body.items.length > 0 && r.body.items.every(t => t.status === 'successful' && t.provider === 'mtn_momo'), r.body.items.length);
  r = await call('GET', `/finance/transactions?q=${mtn1.reference}`, { token: tok.fin });
  check('search by reference', r.body.items.length === 1 && r.body.items[0].reference === mtn1.reference);
  r = await call('GET', '/finance/transactions?q=UNI-0002', { token: tok.fin });
  check('search by matricule', r.body.items.length > 0 && r.body.items.every(t => t.matricule === 'UNI-0002'));
  r = await call('GET', '/finance/transactions?needs_review=true', { token: tok.fin });
  check('filter: needs review', r.body.items.length >= 3 && r.body.items.every(t => t.needs_review));
  r = await call('GET', `/finance/transactions/${mtn1.id}`, { token: tok.fin });
  check('detail has invoice, student, full event history', r.body.invoice?.number && r.body.student_name === 'Ann Student' && r.body.events.length >= 4, r.body.events?.length);
  r = await call('POST', `/finance/transactions/${slowTx.id}/recheck`, { token: tok.fin });
  check('recheck on a cancelled mobile-money attempt asks the provider (no crash)', r.status === 200);
  check('recheck on a bank transfer is refused (manual only) → 422', (await call('POST', `/finance/transactions/${bk.id}/recheck`, { token: tok.fin })).status === 422);
  r = await call('POST', `/finance/transactions/${exp.id}/resolve-review`, { token: tok.fin, body: { reason: 'Confirmed with MTN statement' } });
  check('flagged transaction can be marked resolved (note audited)', r.status === 200 && (await db.paymentTransaction.findUnique({ where: { id: exp.id } })).needs_review === false && await db.financeAudit.count({ where: { action: 'transaction.review_resolved' } }) === 1);
  r = await call('GET', `/finance/students/${S.s.s1.id}/statement`, { token: tok.fin });
  check('student statement: invoices, payments (incl. refunds) and attempts', r.status === 200 && r.body.invoices.length >= 3 && r.body.payments.some(p => p.kind === 'refund') && r.body.transactions.length > 5 && r.body.totals.paid > 0);
  check('statement forbidden for students → 403', (await call('GET', `/finance/students/${S.s.s1.id}/statement`, { token: tok.a1 })).status === 403);

  section('CSV exports');
  await db.feeRecord.update({ where: { id: invs.C.id }, data: { student_name: '=HYPERLINK("http://evil","x")' } });
  const csvRes = await call('GET', '/finance/export/invoices.csv', { token: tok.fin, raw: true });
  const csvBuf = Buffer.from(await csvRes.arrayBuffer()); const csvText = csvBuf.toString('utf8').replace(/^﻿/, '');
  check('CSV: UTF-8 BOM (Excel accents) + header + attachment headers', csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF && csvText.startsWith('Invoice,') && /attachment; filename=.*invoices-/.test(csvRes.headers.get('content-disposition')) && /text\/csv/.test(csvRes.headers.get('content-type')));
  check('CSV injection neutralised (leading = is prefixed)', !/(^|,)=HYPERLINK/m.test(csvText) && /'=HYPERLINK/.test(csvText));
  const txCsv = await (await call('GET', '/finance/export/transactions.csv?status=successful', { token: tok.fin, raw: true })).text();
  check('transactions CSV respects filters', txCsv.split('\r\n').slice(1).filter(Boolean).every(l => l.includes('successful')) && txCsv.includes('Reference,Date'));
  check('exports need staff role → 403', (await call('GET', '/finance/export/payments.csv', { token: tok.a1 })).status === 403);
  check('unknown export → 404', (await call('GET', '/finance/export/secrets.csv', { token: tok.fin })).status === 404);
  check('exports are audited', await db.financeAudit.count({ where: { action: { startsWith: 'export.' } } }) >= 2);
  r = await call('GET', '/finance/audit?limit=100', { token: tok.fin });
  check('audit log readable by finance; entries have actor, action, target', r.status === 200 && r.body.total > 8 && r.body.items.every(a => a.actor_name && a.action && a.target_id));
  check('audit log forbidden for students → 403', (await call('GET', '/finance/audit', { token: tok.a1 })).status === 403);

  section('Tenant isolation');
  const oinv = await O.db.feeRecord.create({ data: { id: uuid(), student_id: O.s.s1.id, student_name: 'Ann', student_number: 'X-1', fee_name: 'Tuition', academic_year: '2026-2027', amount_due: 1000, amount_paid: 0, balance: 1000, status: 'pending', due_date: '2099-01-01', currency: 'XAF' } });
  check("school 2's finance officer sees none of school 1's transactions", (await call('GET', '/finance/transactions', { token: O.tok.fin })).body.total === 0);
  check("school 2 cannot open school 1's transaction → 404", (await call('GET', `/finance/transactions/${mtn1.id}`, { token: O.tok.fin })).status === 404);
  check("school 2 student cannot pay school 1's invoice → 404", (await start(O.tok.a1, { invoice_id: invs.A.id, amount: 1000, provider: 'bank_transfer' })).status === 404);
  check("school 2 summary contains only school 2's invoices (none of school 1's)", await (async () => { const ids = (await call('GET', '/payments/me/summary', { token: O.tok.a1 })).body.invoices.map(i => i.id); return ids.includes(oinv.id) && !ids.some(id => Object.values(invs).some(v => v.id === id)); })());
  check("webhook addressed to school 2 for school 1's reference changes nothing", (await call('PUT', `/payments/webhooks/mtn_momo/${O.schoolId}/${mtn1.reference}?t=${svc.callbackToken(mtn1.reference)}`, { body: {} })).status === 200);

  section('Existing features still work');
  for (const [p, t] of [['/classes', tok.admin], ['/students', tok.admin], ['/dashboard', tok.admin], ['/portal/student/fees', tok.a1], ['/portal/student/profile', tok.a1]]) check(`GET /api${p} → 200`, (await call('GET', p, { token: t })).status === 200);
  check('legacy student portal /portal/student/fees still shows own invoices only', (await call('GET', '/portal/student/fees', { token: tok.a2 })).body.every(f => f.student_id === S.s.s2.id));
  check('provider config endpoint works', (await call('GET', '/payments/me/summary', { token: tok.a1 })).body.rules.min_amount === 500);

  console.log(`\n${pass} passed, ${fail} failed`);
  [MTN, ORA, STR].forEach(m => m.close());
  await platformClient.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
