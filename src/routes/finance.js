// Finance back-office API (finance officers + school administrators).
//   Read / verify / record : super_admin, head_teacher, finance_officer
//   Refunds                : super_admin, head_teacher only (finance officers cannot reverse money)
// Every state-changing action is written to finance_audit (who, when, why, before/after).
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const providers = require('../payments/providers');
const cfg = require('../payments/config');
const svc = require('../payments/service');
const { buildReceipt } = require('./payments');

const STAFF = authorize('super_admin', 'finance_officer');
const ADMIN_ONLY = authorize('super_admin');
router.use(authenticate, STAFF);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const actorOf = req => ({ id: req.user.id, name: req.user.name, role: req.user.role === 'head_teacher' ? 'super_admin' : req.user.role });
const fail = (res, e) => { if (e instanceof svc.PaymentError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; };
const page = req => ({ limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200), page: Math.max(parseInt(req.query.page, 10) || 1, 1) });

// ── time windows (school-local midnight; default Africa/Douala = UTC+1) ──────────────
const offsetMs = () => Number(process.env.FINANCE_TZ_OFFSET_MIN ?? 60) * 60_000;
function windows(now = new Date()) {
  const local = new Date(now.getTime() + offsetMs());
  const startOfDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const dow = (startOfDay.getUTCDay() + 6) % 7;   // Monday = 0
  const fix = d => new Date(d.getTime() - offsetMs());
  return {
    today: fix(startOfDay),
    week: fix(new Date(startOfDay.getTime() - dow * 86400_000)),
    month: fix(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1))),
    year: fix(new Date(Date.UTC(local.getUTCFullYear(), 0, 1))),
  };
}

// GET /api/finance/summary?academicYear=
router.get('/summary', async (req, res) => {
  const db = req.db;
  const ay = req.query.academicYear ? { academic_year: String(req.query.academicYear) } : {};
  const live = { ...ay, status: { not: 'waived' } };
  const w = windows();
  const net = async since => ((await db.payment.aggregate({ where: { created_at: { gte: since }, ...(req.query.academicYear ? { fee_record: ay } : {}) }, _sum: { amount: true } }))._sum.amount) || 0;

  const [inv, overdue, byStatus, today, week, month, year, awaiting, pendingN, processingN, failed7, review, byMethodRaw, byClass, byYear, recent] = await Promise.all([
    db.feeRecord.aggregate({ where: live, _sum: { amount_due: true, amount_paid: true, balance: true }, _count: { _all: true } }),
    db.feeRecord.aggregate({ where: { ...live, balance: { gt: 0 }, due_date: { lt: new Date().toISOString().slice(0, 10) } }, _sum: { balance: true }, _count: { _all: true } }),
    db.feeRecord.groupBy({ by: ['status'], where: ay, _count: { _all: true } }),
    net(w.today), net(w.week), net(w.month), net(w.year),
    db.paymentTransaction.count({ where: { status: 'awaiting_verification' } }),
    db.paymentTransaction.count({ where: { status: 'pending' } }),
    db.paymentTransaction.count({ where: { status: 'processing' } }),
    db.paymentTransaction.count({ where: { status: { in: ['failed', 'expired'] }, created_at: { gte: new Date(Date.now() - 7 * 86400_000) } } }),
    db.paymentTransaction.count({ where: { needs_review: true } }),
    db.payment.groupBy({ by: ['method'], where: req.query.academicYear ? { fee_record: ay } : {}, _sum: { amount: true }, _count: { _all: true } }),
    db.feeRecord.groupBy({ by: ['class_name'], where: live, _sum: { amount_due: true, amount_paid: true, balance: true }, _count: { _all: true } }),
    db.feeRecord.groupBy({ by: ['academic_year'], where: { status: { not: 'waived' } }, _sum: { amount_due: true, amount_paid: true, balance: true } }),
    db.payment.findMany({ where: { created_at: { gte: new Date(Date.now() - 30 * 86400_000) } }, select: { amount: true, created_at: true }, take: 5000 }),
  ]);
  const series = {};
  for (const p of recent) { const d = new Date(p.created_at.getTime() + offsetMs()).toISOString().slice(0, 10); series[d] = (series[d] || 0) + p.amount; }
  res.json({
    currency: cfg.currency(), academic_year: req.query.academicYear || null,
    expected: inv._sum.amount_due || 0, collected: inv._sum.amount_paid || 0, outstanding: inv._sum.balance || 0, invoices: inv._count._all,
    overdue: { amount: overdue._sum.balance || 0, count: overdue._count._all },
    collections: { today, week, month, year },
    invoice_status: Object.fromEntries(byStatus.map(r => [r.status, r._count._all])),
    needs_attention: { awaiting_verification: awaiting, pending: pendingN, processing: processingN, failed_7d: failed7, needs_review: review },
    by_method: byMethodRaw.map(r => ({ method: r.method || 'unknown', amount: r._sum.amount || 0, count: r._count._all })).sort((a, b) => b.amount - a.amount),
    by_class: byClass.map(r => ({ class_name: r.class_name || '—', expected: r._sum.amount_due || 0, collected: r._sum.amount_paid || 0, outstanding: r._sum.balance || 0, invoices: r._count._all })).sort((a, b) => b.outstanding - a.outstanding),
    by_academic_year: byYear.map(r => ({ academic_year: r.academic_year || '—', expected: r._sum.amount_due || 0, collected: r._sum.amount_paid || 0, outstanding: r._sum.balance || 0 })),
    daily: Object.entries(series).sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount })),
  });
});

// GET /api/finance/providers — configuration status (variable NAMES only, never values)
router.get('/providers', (_req, res) => {
  res.json(providers.all().map(p => ({ ...providers.publicInfo(p), missing: p.missing(), ...(p.id === 'orange_money' || p.id === 'mtn_momo' ? { callbacks_need_public_url: !cfg.apiPublicUrl() } : {}) })));
});

// ── transactions ───────────────────────────────────────────────────────────────
function txWhere(q) {
  const where = {};
  if (q.status) where.status = q.status;
  if (q.provider) where.provider = q.provider;
  if (q.needs_review === 'true') where.needs_review = true;
  if (q.from || q.to) where.created_at = { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lt: new Date(new Date(q.to).getTime() + 86400_000) }) };
  if (q.q) {
    const s = String(q.q).trim();
    where.OR = [
      { reference: { contains: s, mode: 'insensitive' } },
      { provider_txn_id: { contains: s, mode: 'insensitive' } },
      { payer_phone: { contains: s } },
      { student: { OR: [{ first_name: { contains: s, mode: 'insensitive' } }, { last_name: { contains: s, mode: 'insensitive' } }, { student_number: { contains: s, mode: 'insensitive' } }] } },
    ];
  }
  return where;
}
const TX_LIST_INCLUDE = { student: { select: { first_name: true, last_name: true, student_number: true, class_name: true } }, fee_record: { select: { fee_name: true, academic_year: true } }, payment: { select: { receipt_number: true } } };
const txRow = r => ({ ...svc.txDto(r, { staff: true }), student_name: `${r.student.first_name} ${r.student.last_name}`, matricule: r.student.student_number, class_name: r.student.class_name, fee_name: r.fee_record.fee_name, academic_year: r.fee_record.academic_year, receipt_number: r.payment?.receipt_number ?? null });

router.get('/transactions', async (req, res) => {
  const { limit, page: pg } = page(req);
  const where = txWhere(req.query);
  const [rows, total] = await Promise.all([
    req.db.paymentTransaction.findMany({ where, orderBy: { created_at: 'desc' }, take: limit, skip: (pg - 1) * limit, omit: { receipt_data: true, provider_secret: true }, include: TX_LIST_INCLUDE }),
    req.db.paymentTransaction.count({ where }),
  ]);
  res.json({ total, page: pg, limit, items: rows.map(txRow) });
});

router.get('/transactions/:id', async (req, res) => {
  const r = await req.db.paymentTransaction.findUnique({
    where: { id: req.params.id }, omit: { receipt_data: true, provider_secret: true },
    include: { ...TX_LIST_INCLUDE, events: { orderBy: { created_at: 'asc' } }, fee_record: true },
  });
  if (!r) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ ...txRow({ ...r, fee_record: r.fee_record }), invoice: { id: r.fee_record.id, number: svc.invoiceNumber(r.fee_record), amount_due: r.fee_record.amount_due, amount_paid: r.fee_record.amount_paid, balance: r.fee_record.balance, status: r.fee_record.status, currency: r.fee_record.currency }, events: r.events });
});

// Uploaded bank slip, viewable only by staff.
router.get('/transactions/:id/receipt-file', async (req, res) => {
  const r = await req.db.paymentTransaction.findUnique({ where: { id: req.params.id }, select: { receipt_data: true, receipt_mime: true, receipt_name: true } });
  if (!r?.receipt_data) return res.status(404).json({ error: 'No proof uploaded' });
  res.setHeader('Content-Type', r.receipt_mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.receipt_name || 'proof')}`);
  res.end(Buffer.from(r.receipt_data));
});

router.post('/transactions/:id/review', async (req, res) => {
  const tx = await req.db.paymentTransaction.findUnique({ where: { id: req.params.id } });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  try {
    const r = await svc.reviewBankTransfer(req.db, tx, { decision: req.body.decision, reason: req.body.reason, bankReference: req.body.bank_reference, actor: actorOf(req) });
    res.json({ transaction: svc.txDto(r.tx, { staff: true }), receipt_number: r.payment?.receipt_number ?? null });
  } catch (e) { return fail(res, e); }
});

// Ask the provider again (e.g. a mobile-money payment stuck in "pending").
router.post('/transactions/:id/recheck', async (req, res) => {
  const tx = await req.db.paymentTransaction.findUnique({ where: { id: req.params.id } });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.provider === 'bank_transfer') return res.status(422).json({ error: 'Bank transfers are verified manually' });
  const r = await svc.verifyAndApply(req.db, tx, 'finance_officer', actorOf(req));
  await svc.audit(req.db, actorOf(req), 'transaction.recheck', 'payment_transaction', tx.id, { after: { status: r.tx.status } });
  res.json({ transaction: svc.txDto(r.tx, { staff: true }), changed: !!r.changed, error: r.error || null });
});

router.post('/transactions/:id/resolve-review', async (req, res) => {
  const tx = await req.db.paymentTransaction.findUnique({ where: { id: req.params.id } });
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (!req.body.reason?.trim()) return res.status(422).json({ error: 'Describe how this was resolved' });
  await req.db.paymentTransaction.update({ where: { id: tx.id }, data: { needs_review: false, review_note: `Resolved: ${req.body.reason.trim()}`, updated_at: new Date() } });
  await svc.audit(req.db, actorOf(req), 'transaction.review_resolved', 'payment_transaction', tx.id, { reason: req.body.reason, before: { note: tx.review_note } });
  res.json({ ok: true });
});

// ── ledger: payments / manual / refunds ────────────────────────────────────────────
router.get('/payments', async (req, res) => {
  const { limit, page: pg } = page(req);
  const where = {};
  if (req.query.method) where.method = req.query.method;
  if (req.query.kind) where.kind = req.query.kind;
  if (req.query.from || req.query.to) where.created_at = { ...(req.query.from && { gte: new Date(req.query.from) }), ...(req.query.to && { lt: new Date(new Date(req.query.to).getTime() + 86400_000) }) };
  if (req.query.q) { const s = String(req.query.q); where.OR = [{ receipt_number: { contains: s, mode: 'insensitive' } }, { reference: { contains: s, mode: 'insensitive' } }, { fee_record: { OR: [{ student_name: { contains: s, mode: 'insensitive' } }, { student_number: { contains: s, mode: 'insensitive' } }] } }]; }
  const [rows, total] = await Promise.all([
    req.db.payment.findMany({ where, orderBy: { created_at: 'desc' }, take: limit, skip: (pg - 1) * limit, include: { fee_record: { select: { student_name: true, student_number: true, fee_name: true, currency: true, academic_year: true } } } }),
    req.db.payment.count({ where }),
  ]);
  res.json({ total, page: pg, limit, items: rows.map(p => ({ id: p.id, receipt_number: p.receipt_number, amount: p.amount, kind: p.kind, method: p.method, reference: p.reference, payment_date: p.payment_date, created_at: p.created_at, transaction_id: p.transaction_id, student_name: p.fee_record.student_name, matricule: p.fee_record.student_number, fee_name: p.fee_record.fee_name, academic_year: p.fee_record.academic_year, currency: p.fee_record.currency })) });
});

router.get('/payments/:id/receipt', async (req, res) => {
  const r = await buildReceipt(req.db, req.params.id, null);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  res.json(r);
});

router.post('/payments/manual', async (req, res) => {
  const { fee_record_id, amount, method, reference, reason, payment_date } = req.body;
  try { res.status(201).json(await svc.recordManualPayment(req.db, { feeId: fee_record_id, amount, method, reference, reason, paymentDate: payment_date, actor: actorOf(req) })); }
  catch (e) { return fail(res, e); }
});

router.post('/payments/:id/refund', ADMIN_ONLY, async (req, res) => {
  try { res.status(201).json(await svc.refund(req.db, { paymentId: req.params.id, amount: req.body.amount, reason: req.body.reason, providerRefund: !!req.body.provider_refund, actor: actorOf(req) })); }
  catch (e) { return fail(res, e); }
});

// Invoice adjustments (waive / change amount) — admin only, reason mandatory, audited.
router.post('/invoices/:id/adjust', ADMIN_ONLY, async (req, res) => {
  const { amount_due, waive, reason } = req.body;
  if (!reason?.trim()) return res.status(422).json({ error: 'A reason is required' });
  const fee = await req.db.feeRecord.findUnique({ where: { id: req.params.id } });
  if (!fee) return res.status(404).json({ error: 'Invoice not found' });
  const data = { updated_at: new Date() };
  if (waive !== undefined) data.status = waive ? 'waived' : svc.invoiceStatus({ ...fee, status: 'pending' });
  if (amount_due !== undefined) {
    const n = Number(amount_due);
    if (!Number.isFinite(n) || n < 0) return res.status(422).json({ error: 'Invalid amount' });
    data.amount_due = svc.round(n, fee.currency); data.balance = Math.max(0, svc.round(n - fee.amount_paid, fee.currency));
    if (!waive && fee.status !== 'waived') data.status = svc.invoiceStatus({ ...fee, amount_due: n, balance: data.balance });
  }
  const updated = await req.db.feeRecord.update({ where: { id: fee.id }, data });
  await svc.audit(req.db, actorOf(req), 'invoice.adjust', 'fee_record', fee.id, { reason, before: { amount_due: fee.amount_due, balance: fee.balance, status: fee.status }, after: { amount_due: updated.amount_due, balance: updated.balance, status: updated.status } });
  res.json(updated);
});

// ── student statement ─────────────────────────────────────────────────────────────
router.get('/students/:id/statement', async (req, res) => {
  const student = await req.db.student.findUnique({ where: { id: req.params.id }, select: { id: true, first_name: true, last_name: true, student_number: true, class_name: true } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const [invoices, payments, txs] = await Promise.all([
    req.db.feeRecord.findMany({ where: { student_id: student.id }, orderBy: { created_at: 'asc' } }),
    req.db.payment.findMany({ where: { fee_record: { student_id: student.id } }, orderBy: { created_at: 'asc' }, include: { fee_record: { select: { fee_name: true } } } }),
    req.db.paymentTransaction.findMany({ where: { student_id: student.id }, orderBy: { created_at: 'desc' }, take: 100, omit: { receipt_data: true, provider_secret: true } }),
  ]);
  const live = invoices.filter(i => i.status !== 'waived');
  res.json({
    student: { id: student.id, name: `${student.first_name} ${student.last_name}`, matricule: student.student_number, class_name: student.class_name },
    totals: { due: live.reduce((s, i) => s + i.amount_due, 0), paid: live.reduce((s, i) => s + i.amount_paid, 0), balance: live.reduce((s, i) => s + i.balance, 0) },
    invoices: invoices.map(i => ({ id: i.id, number: svc.invoiceNumber(i), fee_name: i.fee_name, academic_year: i.academic_year, amount_due: i.amount_due, amount_paid: i.amount_paid, balance: i.balance, status: i.status, due_date: i.due_date, currency: i.currency })),
    payments: payments.map(p => ({ id: p.id, receipt_number: p.receipt_number, amount: p.amount, kind: p.kind, method: p.method, reference: p.reference, payment_date: p.payment_date, fee_name: p.fee_record.fee_name })),
    transactions: txs.map(t => svc.txDto(t, { staff: true })),
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────────
// Cells starting with = + - @ are prefixed so Excel cannot execute them as formulas (CSV injection).
const cell = v => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => `﻿${[header.join(','), ...rows.map(r => r.map(cell).join(','))].join('\r\n')}\r\n`;

router.get('/export/:kind.csv', async (req, res) => {
  const kind = req.params.kind;
  let header, rows;
  if (kind === 'transactions') {
    const list = await req.db.paymentTransaction.findMany({ where: txWhere(req.query), orderBy: { created_at: 'desc' }, take: 20000, omit: { receipt_data: true, provider_secret: true }, include: TX_LIST_INCLUDE });
    header = ['Reference', 'Date', 'Matricule', 'Student', 'Class', 'Invoice', 'Academic year', 'Provider', 'Amount', 'Currency', 'Status', 'Provider transaction', 'Receipt no.', 'Needs review'];
    rows = list.map(t => [t.reference, t.created_at, t.student.student_number, `${t.student.first_name} ${t.student.last_name}`, t.student.class_name, t.fee_record.fee_name, t.fee_record.academic_year, t.provider, t.amount, t.currency, t.status, t.provider_txn_id, t.payment?.receipt_number, t.needs_review ? 'yes' : '']);
  } else if (kind === 'payments') {
    const list = await req.db.payment.findMany({ orderBy: { created_at: 'desc' }, take: 20000, include: { fee_record: { select: { student_name: true, student_number: true, fee_name: true, academic_year: true, class_name: true, currency: true } } } });
    header = ['Receipt no.', 'Date', 'Matricule', 'Student', 'Class', 'Invoice', 'Academic year', 'Type', 'Method', 'Amount', 'Currency', 'Reference'];
    rows = list.map(p => [p.receipt_number, p.payment_date || p.created_at, p.fee_record.student_number, p.fee_record.student_name, p.fee_record.class_name, p.fee_record.fee_name, p.fee_record.academic_year, p.kind, p.method, p.amount, p.fee_record.currency, p.reference]);
  } else if (kind === 'invoices') {
    const list = await req.db.feeRecord.findMany({ where: req.query.academicYear ? { academic_year: String(req.query.academicYear) } : {}, orderBy: [{ class_name: 'asc' }, { student_name: 'asc' }], take: 50000 });
    header = ['Invoice', 'Matricule', 'Student', 'Class', 'Fee', 'Academic year', 'Due date', 'Amount due', 'Paid', 'Balance', 'Currency', 'Status'];
    rows = list.map(f => [svc.invoiceNumber(f), f.student_number, f.student_name, f.class_name, f.fee_name, f.academic_year, f.due_date, f.amount_due, f.amount_paid, f.balance, f.currency, f.status]);
  } else return res.status(404).json({ error: 'Unknown export' });
  await svc.audit(req.db, actorOf(req), `export.${kind}`, 'export', kind, { after: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(header, rows));
});

// ── reconciliation ───────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
const toNumber = s => { const n = Number(String(s).replace(/[\s ]/g, '').replace(/[^\d.,-]/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

// Awaiting a decision — the reconciliation work-list.
router.get('/reconcile/pending', async (req, res) => {
  const rows = await req.db.paymentTransaction.findMany({
    where: { provider: 'bank_transfer', status: { in: ['pending', 'awaiting_verification'] } }, orderBy: { created_at: 'asc' }, take: 300,
    omit: { receipt_data: true, provider_secret: true }, include: TX_LIST_INCLUDE,
  });
  res.json(rows.map(txRow));
});

// Match a bank-statement CSV against bank-transfer references. Dry run by default; apply=true approves exact matches.
router.post('/reconcile/import', express_json_text(), async (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
  const apply = req.query.apply === 'true' || req.body?.apply === true;
  if (!csv || !String(csv).trim()) return res.status(422).json({ error: 'Paste or upload the bank statement CSV' });
  const rows = parseCsv(String(csv));
  if (rows.length < 2) return res.status(422).json({ error: 'The file has no data rows' });
  const header = rows[0].map(h => h.trim().toLowerCase());
  const amountCol = header.findIndex(h => /^(amount|montant|credit|crédit|cr)$/.test(h) || /amount|montant|cr[eé]dit/.test(h));
  const out = []; const counts = { matched: 0, applied: 0, amount_mismatch: 0, not_found: 0, no_reference: 0, already_processed: 0 };
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i]; const text = line.join(' ');
    const m = text.toUpperCase().match(/EDU-\d{4}-[A-HJ-NP-Z2-9]{7}/);
    const amount = amountCol >= 0 ? toNumber(line[amountCol]) : Math.max(...line.map(toNumber).filter(Number.isFinite), NaN);
    if (!m) { counts.no_reference++; out.push({ line: i + 1, status: 'no_reference', amount: Number.isFinite(amount) ? amount : null, text: text.slice(0, 120) }); continue; }
    const tx = await req.db.paymentTransaction.findUnique({ where: { reference: m[0] }, omit: { receipt_data: true, provider_secret: true }, include: TX_LIST_INCLUDE });
    if (!tx || tx.provider !== 'bank_transfer') { counts.not_found++; out.push({ line: i + 1, status: 'not_found', reference: m[0], amount, text: text.slice(0, 120) }); continue; }
    if (!['pending', 'awaiting_verification'].includes(tx.status)) { counts.already_processed++; out.push({ line: i + 1, status: 'already_processed', reference: tx.reference, transaction_status: tx.status, amount }); continue; }
    if (!Number.isFinite(amount) || !svc.sameAmount(amount, tx.amount, tx.currency)) { counts.amount_mismatch++; out.push({ line: i + 1, status: 'amount_mismatch', reference: tx.reference, expected: tx.amount, amount, student_name: `${tx.student.first_name} ${tx.student.last_name}` }); continue; }
    counts.matched++;
    const item = { line: i + 1, status: 'matched', reference: tx.reference, amount: tx.amount, student_name: `${tx.student.first_name} ${tx.student.last_name}`, transaction_id: tx.id };
    if (apply) {
      try { await svc.reviewBankTransfer(req.db, tx, { decision: 'approve', reason: `Matched in bank statement import (line ${i + 1})`, actor: actorOf(req) }); item.status = 'applied'; counts.applied++; }
      catch (e) { item.status = 'error'; item.error = e.message; }
    }
    out.push(item);
  }
  await svc.audit(req.db, actorOf(req), apply ? 'reconcile.apply' : 'reconcile.dry_run', 'reconciliation', 'bank_statement', { after: counts });
  res.json({ applied: apply, counts, rows: out });
});
// Accepts either JSON {csv} or a raw text/csv body.
function express_json_text() {
  const express = require('express');
  const j = express.json({ limit: '5mb' }), t = express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' });
  return (req, res, next) => t(req, res, err => (err ? next(err) : j(req, res, next)));
}

router.get('/audit', async (req, res) => {
  const { limit, page: pg } = page(req);
  const where = {};
  if (req.query.action) where.action = { contains: String(req.query.action) };
  if (req.query.target_id) where.target_id = String(req.query.target_id);
  const [rows, total] = await Promise.all([
    req.db.financeAudit.findMany({ where, orderBy: { created_at: 'desc' }, take: limit, skip: (pg - 1) * limit }),
    req.db.financeAudit.count({ where }),
  ]);
  res.json({ total, page: pg, limit, items: rows });
});

module.exports = router;
