const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { v4: uuid } = require('uuid');
const svc = require('../payments/service');
const cfg = require('../payments/config');

// Fee data is financial: only school administrators and finance officers may read or change it.
// (Students/parents use their own portal endpoints; teachers have no access.)
const staff = [authenticate, authorize('super_admin', 'finance_officer')];
const adminOnly = [authenticate, authorize('super_admin')];
const actorOf = req => ({ id: req.user.id, name: req.user.name, role: req.user.role === 'head_teacher' ? 'super_admin' : req.user.role });

const flattenPayments = rec => rec ? { ...rec, payments: rec.payments } : null;
const PAYMENTS_INCLUDE = { payments: { orderBy: { payment_date: 'asc' } } };

const recalcStatus = (rec) => {
  if (rec.balance <= 0) return 'paid';
  if (rec.amount_paid > 0) return 'partial';
  const today = new Date().toISOString().slice(0, 10);
  if (rec.due_date && rec.due_date < today) return 'overdue';
  return 'pending';
};

// GET /api/fees?classId=c1&status=overdue&studentId=st1
router.get('/', ...staff, async (req, res) => {
  const { classId, status, studentId, academicYear } = req.query;
  const where = {};
  if (classId) where.class_id = classId;
  if (status) where.status = status;
  if (studentId) where.student_id = studentId;
  if (academicYear) where.academic_year = academicYear;
  const rows = await req.db.feeRecord.findMany({ where, include: PAYMENTS_INCLUDE, orderBy: { student_name: 'asc' } });
  res.json(rows.map(flattenPayments));
});

// GET /api/fees/summary  — aggregated stats
router.get('/summary', ...staff, async (req, res) => {
  const { academicYear } = req.query;
  const where = academicYear ? { academic_year: academicYear } : {};
  const [sums, paid, partial, overdue, total] = await Promise.all([
    req.db.feeRecord.aggregate({ where, _sum: { amount_due: true, amount_paid: true, balance: true } }),
    req.db.feeRecord.count({ where: { ...where, status: 'paid' } }),
    req.db.feeRecord.count({ where: { ...where, status: 'partial' } }),
    req.db.feeRecord.count({ where: { ...where, status: 'overdue' } }),
    req.db.feeRecord.count({ where }),
  ]);
  res.json({
    total_due: sums._sum.amount_due,
    total_collected: sums._sum.amount_paid,
    total_pending: sums._sum.balance,
    paid_count: paid,
    partial_count: partial,
    overdue_count: overdue,
    total_records: total,
  });
});

// GET /api/fees/:id
router.get('/:id', ...staff, async (req, res) => {
  const row = await req.db.feeRecord.findUnique({ where: { id: req.params.id }, include: PAYMENTS_INCLUDE });
  if (!row) return res.status(404).json({ error: 'Fee record not found' });
  res.json(flattenPayments(row));
});

// POST /api/fees
router.post('/', ...staff, async (req, res) => {
  const { studentId, feeName, academicYear, amountDue, dueDate } = req.body;
  if (!studentId || !feeName || !amountDue) return res.status(422).json({ error: 'studentId, feeName and amountDue required' });
  if (!(Number(amountDue) > 0)) return res.status(422).json({ error: 'amountDue must be positive' });
  const student = await req.db.student.findUnique({ where: { id: studentId } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  // Protection against duplicate invoices: same student + fee name + academic year.
  const dupe = await req.db.feeRecord.findFirst({ where: { student_id: studentId, fee_name: { equals: String(feeName).trim(), mode: 'insensitive' }, academic_year: academicYear || null }, select: { id: true } });
  if (dupe) return res.status(409).json({ error: 'This student already has an invoice with the same fee name for that academic year.' });
  const id = uuid();
  const created = await req.db.feeRecord.create({
    data: {
      id, student_id: studentId, student_name: `${student?.first_name} ${student?.last_name}`, student_number: student?.student_number ?? null,
      class_id: student?.class_id ?? null, class_name: student?.class_name ?? null, fee_name: String(feeName).trim(), academic_year: academicYear || null, currency: cfg.currency(),
      amount_due: amountDue, amount_paid: 0, balance: amountDue, status: 'pending', due_date: dueDate || null,
    },
    include: PAYMENTS_INCLUDE,
  });
  await svc.audit(req.db, actorOf(req), 'invoice.create', 'fee_record', id, { after: { student_id: studentId, fee_name: created.fee_name, amount_due: created.amount_due } });
  res.status(201).json(flattenPayments(created));
});

// POST /api/fees/:id/payments — manual (cash / counter) payment. Goes through the same locked, audited
// ledger code as online payments; the old body shape is still accepted.
router.post('/:id/payments', ...staff, async (req, res) => {
  const { amount, method, reference, paymentDate, reason } = req.body;
  if (!amount) return res.status(422).json({ error: 'amount required' });
  try {
    await svc.recordManualPayment(req.db, { feeId: req.params.id, amount, method, reference, paymentDate, reason: reason || 'Recorded at the finance desk', actor: actorOf(req) });
  } catch (e) { if (e instanceof svc.PaymentError) return res.status(e.status).json({ error: e.message }); throw e; }
  res.status(201).json(flattenPayments(await req.db.feeRecord.findUnique({ where: { id: req.params.id }, include: PAYMENTS_INCLUDE })));
});

// PUT /api/fees/:id
router.put('/:id', ...adminOnly, async (req, res) => {
  const { feeName, amountDue, dueDate, status } = req.body;
  const fee = await req.db.feeRecord.findUnique({ where: { id: req.params.id } });
  if (!fee) return res.status(404).json({ error: 'Not found' });
  const newDue = amountDue ?? fee.amount_due;
  const newBal = Math.max(0, newDue - fee.amount_paid);
  const updated = await req.db.feeRecord.update({
    where: { id: req.params.id },
    data: {
      fee_name: feeName || fee.fee_name, amount_due: newDue, balance: newBal, due_date: dueDate || fee.due_date,
      status: status || recalcStatus({ ...fee, amount_due: newDue, balance: newBal }), updated_at: new Date(),
    },
    include: PAYMENTS_INCLUDE,
  });
  await svc.audit(req.db, actorOf(req), 'invoice.update', 'fee_record', fee.id, { before: { fee_name: fee.fee_name, amount_due: fee.amount_due, status: fee.status }, after: { fee_name: updated.fee_name, amount_due: updated.amount_due, status: updated.status } });
  res.json(flattenPayments(updated));
});

module.exports = router;
