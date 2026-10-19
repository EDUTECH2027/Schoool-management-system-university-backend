// Student payment portal API. Every figure comes from the verified ledger (fee_records / payments /
// payment_transactions) — never from values sent by the browser.
const router = require('express').Router();
const multer = require('multer');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const providers = require('../payments/providers');
const cfg = require('../payments/config');
const svc = require('../payments/service');

router.use(authenticate, authorize('student'));
// Financial data must never be stored by browsers or shared caches.
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/^(image\/(png|jpe?g|webp)|application\/pdf)$/.test(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('Upload a PDF, PNG or JPG image'), { status: 422 }))),
});
const uploadReceipt = (req, res, next) => receiptUpload.single('receipt')(req, res, err => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 5 MB)' });
  return res.status(err.status || 400).json({ error: err.message });
});

async function loadStudent(req, res) {
  const student = req.user.student_id && await req.db.student.findUnique({ where: { id: req.user.student_id }, include: { class: { include: { grade_level: true } } } });
  if (!student) { res.status(404).json({ error: 'Student profile not found' }); return null; }
  return student;
}
async function ownTx(req, res) {
  const tx = await req.db.paymentTransaction.findUnique({ where: { id: req.params.id } });
  if (!tx || tx.student_id !== req.user.student_id) { res.status(404).json({ error: 'Transaction not found' }); return null; }
  return tx;
}
const fail = (res, e) => {
  if (e instanceof svc.PaymentError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
};

// GET /api/payments/me/summary
router.get('/me/summary', async (req, res) => {
  const student = await loadStudent(req, res); if (!student) return;
  const [fees, year, openTx] = await Promise.all([
    req.db.feeRecord.findMany({ where: { student_id: student.id }, orderBy: [{ due_date: 'asc' }, { created_at: 'asc' }] }),
    req.db.academicYear.findFirst({ where: { is_current: true } }),
    req.db.paymentTransaction.findMany({ where: { student_id: student.id, status: { in: svc.OPEN } }, select: { fee_record_id: true, amount: true } }),
  ]);
  const wanted = req.query.year || year?.label;
  const inYear = wanted ? fees.filter(f => f.academic_year === wanted) : [];
  const scope = inYear.length ? inYear : fees;
  const live = scope.filter(f => f.status !== 'waived');
  const sum = k => svc.round(live.reduce((s, f) => s + f[k], 0));
  const pendingByInvoice = {};
  for (const t of openTx) pendingByInvoice[t.fee_record_id] = (pendingByInvoice[t.fee_record_id] || 0) + t.amount;
  const today = new Date().toISOString().slice(0, 10);

  res.json({
    student: {
      id: student.id, name: `${student.first_name} ${student.last_name}`, matricule: student.student_number,
      class_name: student.class?.name ?? student.class_name ?? null, level: student.class?.grade_level?.name ?? student.grade_level_name ?? null,
      // The platform's data model has classes/levels, not faculties/departments: show what exists.
      faculty: null, department: null,
    },
    academic_year: inYear.length ? wanted : (fees[0]?.academic_year ?? wanted ?? null),
    currency: cfg.currency(),
    totals: { due: sum('amount_due'), paid: sum('amount_paid'), balance: sum('balance'), overdue: svc.round(live.filter(f => f.balance > 0 && f.due_date && f.due_date < today).reduce((s, f) => s + f.balance, 0)), pending: svc.round(Object.values(pendingByInvoice).reduce((a, b) => a + b, 0)) },
    invoices: scope.map(f => ({
      id: f.id, number: svc.invoiceNumber(f), fee_name: f.fee_name, academic_year: f.academic_year, currency: f.currency,
      amount_due: f.amount_due, amount_paid: f.amount_paid, balance: f.balance, status: f.status, due_date: f.due_date,
      pending_amount: pendingByInvoice[f.id] || 0,
    })),
    upcoming: live.filter(f => f.balance > 0 && f.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5).map(f => ({ invoice_id: f.id, fee_name: f.fee_name, due_date: f.due_date, balance: f.balance, overdue: f.due_date < today })),
    methods: providers.all().map(providers.publicInfo),
    rules: { min_amount: cfg.minAmount(), allow_partial: cfg.allowPartial() },
  });
});

// GET /api/payments/me/transactions
router.get('/me/transactions', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const where = { student_id: req.user.student_id };
  const [rows, total] = await Promise.all([
    req.db.paymentTransaction.findMany({
      where, orderBy: { created_at: 'desc' }, take: limit, skip: (page - 1) * limit, omit: { receipt_data: true, provider_secret: true, idempotency_key: true },
      include: { fee_record: { select: { fee_name: true, academic_year: true, currency: true } }, payment: { select: { id: true, receipt_number: true } } },
    }),
    req.db.paymentTransaction.count({ where }),
  ]);
  res.json({ total, page, limit, items: rows.map(r => ({ ...svc.txDto(r), fee_name: r.fee_record.fee_name, academic_year: r.fee_record.academic_year, receipt_number: r.payment?.receipt_number ?? null })) });
});

// POST /api/payments/me/transactions — start a payment
router.post('/me/transactions', async (req, res) => {
  const student = await loadStudent(req, res); if (!student) return;
  const { invoice_id, amount, provider, phone, idempotency_key, lang } = req.body;
  try {
    const { tx, reused } = await svc.createTransaction(req.db, {
      student, invoiceId: invoice_id, amount, providerId: provider, phone, idempotencyKey: idempotency_key ? String(idempotency_key).slice(0, 80) : null,
      actor: { id: req.user.id, name: req.user.name }, schoolId: req.user.school_id, lang,
    });
    const info = providers.publicInfo(providers.get(tx.provider));
    res.status(reused ? 200 : 201).json({ ...svc.txDto(tx), checkout_url: tx.checkout_url, bank: info.bank ?? null });
  } catch (e) { return fail(res, e); }
});

// GET /api/payments/me/transactions/:id — current status; asks the provider if it is still open
router.get('/me/transactions/:id', async (req, res) => {
  let tx = await ownTx(req, res); if (!tx) return;
  if (['initiated', 'pending', 'processing'].includes(tx.status) && tx.provider !== 'bank_transfer') {
    const r = await svc.verifyAndApply(req.db, tx, 'provider_poll');
    tx = r.tx || tx;
  }
  const full = await req.db.paymentTransaction.findUnique({
    where: { id: tx.id }, omit: { receipt_data: true, provider_secret: true, idempotency_key: true },
    include: { events: { orderBy: { created_at: 'asc' }, select: { id: true, to_status: true, from_status: true, source: true, note: true, created_at: true } }, payment: { select: { id: true, receipt_number: true } }, fee_record: { select: { fee_name: true } } },
  });
  const info = providers.publicInfo(providers.get(full.provider));
  res.json({ ...svc.txDto(full), checkout_url: ['pending', 'initiated'].includes(full.status) ? full.checkout_url : null, fee_name: full.fee_record.fee_name, receipt_number: full.payment?.receipt_number ?? null, payment_id: full.payment?.id ?? null, bank: info.bank ?? null, events: full.events });
});

router.post('/me/transactions/:id/cancel', async (req, res) => {
  const tx = await ownTx(req, res); if (!tx) return;
  try { res.json(svc.txDto(await svc.cancelByStudent(req.db, tx, { id: req.user.id, name: req.user.name }))); } catch (e) { return fail(res, e); }
});

// Bank-transfer proof: stays "awaiting verification" until a finance officer decides.
router.post('/me/transactions/:id/receipt', uploadReceipt, async (req, res) => {
  const tx = await ownTx(req, res); if (!tx) return;
  if (!req.file) return res.status(422).json({ error: 'Choose a PDF or image of your bank slip' });
  try { res.json(svc.txDto(await svc.attachBankReceipt(req.db, tx, req.file, req.body.bank_reference, { id: req.user.id, name: req.user.name }))); } catch (e) { return fail(res, e); }
});

// GET /api/payments/me/payments — confirmed payments (receipts)
router.get('/me/payments', async (req, res) => {
  const rows = await req.db.payment.findMany({
    where: { fee_record: { student_id: req.user.student_id } }, orderBy: { created_at: 'desc' }, take: 200,
    include: { fee_record: { select: { fee_name: true, academic_year: true, currency: true } } },
  });
  res.json(rows.map(p => ({ id: p.id, amount: p.amount, kind: p.kind, method: p.method, reference: p.reference, payment_date: p.payment_date, receipt_number: p.receipt_number, fee_name: p.fee_record.fee_name, academic_year: p.fee_record.academic_year, currency: p.fee_record.currency })));
});

// GET /api/payments/me/payments/:id/receipt — data for the printable / downloadable receipt
router.get('/me/payments/:id/receipt', async (req, res) => {
  const receipt = await buildReceipt(req.db, req.params.id, req.user.student_id);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  res.json(receipt);
});

async function buildReceipt(db, paymentId, onlyStudentId) {
  const p = await db.payment.findUnique({ where: { id: paymentId }, include: { fee_record: true } });
  if (!p || p.kind !== 'payment') return null;
  if (onlyStudentId && p.fee_record.student_id !== onlyStudentId) return null;
  const [student, school] = await Promise.all([
    db.student.findUnique({ where: { id: p.fee_record.student_id }, select: { first_name: true, last_name: true, student_number: true, class_name: true } }),
    db.school.findFirst(),
  ]);
  const tx = p.transaction_id ? await db.paymentTransaction.findUnique({ where: { id: p.transaction_id }, select: { reference: true, provider: true, provider_txn_id: true, bank_reference: true } }) : null;
  return {
    receipt_number: p.receipt_number, issued_at: p.created_at, payment_date: p.payment_date,
    school: { name: school?.name ?? '', address: school?.address ?? null, phone: school?.phone ?? null, email: school?.email ?? null },
    student: { name: `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim(), matricule: student?.student_number ?? p.fee_record.student_number, class_name: student?.class_name ?? p.fee_record.class_name },
    invoice: { number: svc.invoiceNumber(p.fee_record), fee_name: p.fee_record.fee_name, academic_year: p.fee_record.academic_year, amount_due: p.fee_record.amount_due, amount_paid_to_date: p.fee_record.amount_paid, balance: p.fee_record.balance },
    payment: { amount: p.amount, currency: p.fee_record.currency, method: p.method, reference: tx?.reference ?? p.reference, provider_transaction: tx?.provider_txn_id ?? null },
    footer: cfg.receiptFooter(),
  };
}

module.exports = router;
module.exports.buildReceipt = buildReceipt;
