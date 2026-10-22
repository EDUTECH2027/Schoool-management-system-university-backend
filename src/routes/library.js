// Library: catalogue, loans, returns, renewals, fines, reservations. See docs/LIBRARY.md.
// Staff (librarian, super_admin, academic_officer) manage; students browse/reserve/renew their own; teachers browse read-only.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const lib = require('../library/service');

const staff = [authenticate, authorize('librarian', 'super_admin', 'academic_officer')];
const reader = [authenticate, authorize('librarian', 'super_admin', 'academic_officer', 'student', 'teacher')];
const student = [authenticate, authorize('student')];
const isStaff = u => ['librarian', 'super_admin', 'head_teacher', 'academic_officer'].includes(u.role);
const actorOf = u => ({ id: u.id, name: u.name, role: u.role === 'head_teacher' ? 'super_admin' : u.role });
const KINDS = ['book', 'journal', 'thesis', 'digital'];
const str = v => (typeof v === 'string' ? v.trim() : v);
const opt = v => { const s = str(v); return s === '' || s == null ? null : s; };
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const pageOf = q => { const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 20)); const page = Math.max(1, parseInt(q.page) || 1); return { limit, page, skip: (page - 1) * limit }; };

// Domain errors → HTTP
const wrap = fn => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e instanceof lib.LibError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
};

const itemView = (it, c, extra = {}) => ({ ...it, available: lib.availableOf(it, c), active_loans: c.active, lost_copies: c.lost, held_for_reservation: c.ready, waiting: c.waiting, ...extra });
const loanView = (l, settings, now = new Date()) => {
  const active = l.status === 'active';
  return {
    id: l.id, item_id: l.item_id, title: l.item?.title ?? null, authors: l.item?.authors ?? null, student_id: l.student_id,
    student: l.student ? `${l.student.first_name} ${l.student.last_name}` : null, matricule: l.student?.student_number ?? null,
    borrowed_at: l.borrowed_at, due_at: l.due_at, returned_at: l.returned_at, renewals: l.renewals, status: l.status,
    fine_amount: l.fine_amount, fine_paid: l.fine_paid, fine_waived: l.fine_waived, fine_open: lib.unpaidFine(l),
    overdue_days: active ? lib.overdueDays(l, now) : 0, accrued_fine: active ? lib.fineFor(l, settings, now) : 0,
    days_left: active ? Math.ceil((new Date(l.due_at) - now) / lib.DAY) : null,
  };
};
const LOAN_INC = { item: { select: { title: true, authors: true } }, student: { select: { first_name: true, last_name: true, student_number: true } } };

// ── Settings ────────────────────────────────────────────────────────────────
router.get('/settings', ...reader, wrap(async (req, res) => res.json(await lib.getSettings(req.db))));
router.put('/settings', ...staff, wrap(async (req, res) => {
  const b = req.body, cur = await lib.getSettings(req.db), data = {};
  const num = (k, ok) => { if (b[k] !== undefined) { if (!ok(b[k])) throw new lib.LibError(`Invalid ${k}`); data[k] = b[k]; } };
  num('loan_days', v => intIn(v, 1, 365)); num('max_loans', v => intIn(v, 0, 100)); num('max_renewals', v => intIn(v, 0, 20));
  num('fine_per_day', v => typeof v === 'number' && v >= 0 && v <= 1e7); num('block_on_fines', v => typeof v === 'boolean');
  if (b.currency !== undefined) { if (!/^[A-Za-z]{2,6}$/.test(b.currency || '')) throw new lib.LibError('Invalid currency'); data.currency = b.currency.toUpperCase(); }
  const row = await req.db.librarySettings.update({ where: { id: 'main' }, data: { ...data, updated_at: new Date() } });
  await audit(req.db, actorOf(req.user), 'library.settings', 'library_settings', 'main', { before: cur, after: row });
  res.json(row);
}));

// ── Catalogue ───────────────────────────────────────────────────────────────
router.get('/categories', ...reader, wrap(async (req, res) => {
  const rows = await req.db.libraryItem.findMany({ where: { category: { not: null }, ...(isStaff(req.user) ? {} : { is_active: true }) }, distinct: ['category'], select: { category: true }, orderBy: { category: 'asc' } });
  res.json(rows.map(r => r.category));
}));

router.get('/items', ...reader, wrap(async (req, res) => {
  await lib.sweep(req.db);
  const q = req.query, { limit, page, skip } = pageOf(q), staffUser = isStaff(req.user);
  const and = [];
  if (!staffUser || q.active === 'true') and.push({ is_active: true }); else if (q.active === 'false') and.push({ is_active: false });
  if (q.title) and.push({ title: { contains: String(q.title), mode: 'insensitive' } });
  if (q.author) and.push({ authors: { contains: String(q.author), mode: 'insensitive' } });
  if (q.isbn) and.push({ isbn: { contains: String(q.isbn).replace(/[\s-]/g, ''), mode: 'insensitive' } });
  if (q.q) { const s = String(q.q); and.push({ OR: [{ title: { contains: s, mode: 'insensitive' } }, { authors: { contains: s, mode: 'insensitive' } }, { isbn: { contains: s.replace(/[\s-]/g, ''), mode: 'insensitive' } }, { category: { contains: s, mode: 'insensitive' } }, { publisher: { contains: s, mode: 'insensitive' } }] }); }
  if (q.category) and.push({ category: String(q.category) });
  if (q.kind) and.push({ kind: String(q.kind) });
  if (q.available === 'true') {
    const ids = await req.db.$queryRaw`SELECT i.id FROM library_items i WHERE i.kind = 'digital' OR i.copies_total
      - (SELECT count(*) FROM library_loans l WHERE l.item_id = i.id AND l.status IN ('active','lost'))
      - (SELECT count(*) FROM library_reservations r WHERE r.item_id = i.id AND r.status = 'ready') > 0`;
    and.push({ id: { in: ids.map(r => r.id) } });
  }
  const where = and.length ? { AND: and } : {};
  const [total, rows] = await Promise.all([req.db.libraryItem.count({ where }), req.db.libraryItem.findMany({ where, orderBy: [{ title: 'asc' }, { id: 'asc' }], skip, take: limit })]);
  const c = await lib.counts(req.db, rows.map(r => r.id));
  let mine = {};
  if (req.user.role === 'student' && req.user.student_id) {
    const [loans, resv] = await Promise.all([
      req.db.libraryLoan.findMany({ where: { student_id: req.user.student_id, status: 'active', item_id: { in: rows.map(r => r.id) } } }),
      req.db.libraryReservation.findMany({ where: { student_id: req.user.student_id, status: { in: ['waiting', 'ready'] }, item_id: { in: rows.map(r => r.id) } } }),
    ]);
    mine = { loans: new Map(loans.map(l => [l.item_id, l])), resv: new Map(resv.map(r => [r.item_id, r])) };
  }
  res.json({ total, page, limit, items: rows.map(it => itemView(it, c.get(it.id), mine.loans ? { my_loan: mine.loans.get(it.id) ? { id: mine.loans.get(it.id).id, due_at: mine.loans.get(it.id).due_at } : null, my_reservation: mine.resv.get(it.id) ? { id: mine.resv.get(it.id).id, status: mine.resv.get(it.id).status } : null } : {})) });
}));

router.get('/items/:id', ...reader, wrap(async (req, res) => {
  const it = await req.db.libraryItem.findUnique({ where: { id: req.params.id } });
  if (!it || (!it.is_active && !isStaff(req.user))) return res.status(404).json({ error: 'Item not found' });
  res.json(itemView(it, (await lib.counts(req.db, [it.id])).get(it.id)));
}));

function itemData(b, partial) {
  const d = {};
  const need = (k, v) => { if (!partial || b[k] !== undefined) d[k] = v; };
  if (!partial || b.title !== undefined) { const t = str(b.title); if (!t) throw new lib.LibError('title is required'); d.title = t.slice(0, 300); }
  for (const k of ['authors', 'publisher', 'category', 'location', 'description']) if (b[k] !== undefined) d[k] = opt(b[k]);
  if (b.isbn !== undefined) d.isbn = opt(b.isbn) ? String(b.isbn).replace(/[\s-]/g, '').toUpperCase() : null;
  if (d.isbn && !/^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(d.isbn)) throw new lib.LibError('isbn must be a valid ISBN-10 or ISBN-13');
  if (b.year !== undefined && b.year !== null && b.year !== '') { if (!intIn(b.year, 1000, 2100)) throw new lib.LibError('year must be between 1000 and 2100'); d.year = b.year; } else if (b.year !== undefined) d.year = null;
  if (b.kind !== undefined || !partial) { const k = b.kind ?? 'book'; if (!KINDS.includes(k)) throw new lib.LibError(`kind must be one of ${KINDS.join(', ')}`); need('kind', k); }
  if (b.copies_total !== undefined || !partial) { const n = b.copies_total ?? 1; if (!intIn(n, 0, 10000)) throw new lib.LibError('copies_total must be a whole number ≥ 0'); d.copies_total = n; }
  if (b.digital_url !== undefined) { const u = opt(b.digital_url); if (u && !/^https?:\/\/\S+$/i.test(u)) throw new lib.LibError('digital_url must be an http(s) URL'); d.digital_url = u; }
  if (b.is_active !== undefined) { if (typeof b.is_active !== 'boolean') throw new lib.LibError('is_active must be a boolean'); d.is_active = b.is_active; }
  return d;
}
const isbnWarning = async (db, isbn, exceptId) => {
  if (!isbn) return [];
  const dup = await db.libraryItem.findFirst({ where: { isbn, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true, title: true } });
  return dup ? [{ code: 'duplicate_isbn', message: `Another item ("${dup.title}") already has this ISBN`, item_id: dup.id }] : [];
};

router.post('/items', ...staff, wrap(async (req, res) => {
  const d = itemData(req.body, false);
  const row = await req.db.libraryItem.create({ data: { id: uuid(), ...d } });
  await audit(req.db, actorOf(req.user), 'library.item.create', 'library_item', row.id, { after: { title: row.title, isbn: row.isbn, copies_total: row.copies_total } });
  res.status(201).json({ ...row, warnings: await isbnWarning(req.db, row.isbn, row.id) });
}));

router.put('/items/:id', ...staff, wrap(async (req, res) => {
  const it0 = await req.db.libraryItem.findUnique({ where: { id: req.params.id } });
  if (!it0) return res.status(404).json({ error: 'Item not found' });
  const d = itemData(req.body, true);
  const row = await req.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM library_items WHERE id = ${it0.id} FOR UPDATE`;
    if (d.copies_total !== undefined) {
      const c = (await lib.counts(tx, [it0.id])).get(it0.id);
      if (d.copies_total < c.active + c.lost) throw new lib.LibError(`copies_total cannot be below the ${c.active + c.lost} copies on loan or lost`, 409);
    }
    return tx.libraryItem.update({ where: { id: it0.id }, data: { ...d, updated_at: new Date() } });
  });
  await audit(req.db, actorOf(req.user), 'library.item.update', 'library_item', row.id, { before: { title: it0.title, copies_total: it0.copies_total, is_active: it0.is_active }, after: { title: row.title, copies_total: row.copies_total, is_active: row.is_active } });
  await lib.promote(req.db, row.id);
  res.json({ ...row, warnings: await isbnWarning(req.db, row.isbn, row.id) });
}));

router.delete('/items/:id', ...staff, wrap(async (req, res) => {
  const it = await req.db.libraryItem.findUnique({ where: { id: req.params.id } });
  if (!it) return res.status(404).json({ error: 'Item not found' });
  const [l, r] = await Promise.all([req.db.libraryLoan.count({ where: { item_id: it.id } }), req.db.libraryReservation.count({ where: { item_id: it.id } })]);
  if (l || r) return res.status(409).json({ error: `This item has loan/reservation history (${l} loans, ${r} reservations). Deactivate it instead.` });
  await req.db.libraryItem.delete({ where: { id: it.id } });
  await audit(req.db, actorOf(req.user), 'library.item.delete', 'library_item', it.id, { before: { title: it.title } });
  res.status(204).end();
}));

// ── Student lookup (quick issue) ────────────────────────────────────────────
router.get('/student-lookup', ...staff, wrap(async (req, res) => {
  const m = String(req.query.matricule || req.query.q || '').trim();
  if (!m) return res.status(422).json({ error: 'matricule is required' });
  const s = await req.db.student.findFirst({ where: { OR: [{ student_number: m }, { student_number: { equals: m, mode: 'insensitive' } }] } });
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const settings = await lib.getSettings(req.db);
  const [loans, fines] = await Promise.all([req.db.libraryLoan.count({ where: { student_id: s.id, status: 'active' } }), lib.studentFinesTotal(req.db, s.id)]);
  res.json({ id: s.id, name: `${s.first_name} ${s.last_name}`, matricule: s.student_number, is_active: s.is_active, active_loans: loans, max_loans: settings.max_loans, unpaid_fines: fines, currency: settings.currency, blocked: settings.block_on_fines && fines > 0 });
}));

// ── Loans ───────────────────────────────────────────────────────────────────
router.get('/loans', ...staff, wrap(async (req, res) => {
  const q = req.query, { limit, page, skip } = pageOf(q), settings = await lib.getSettings(req.db), and = [];
  if (q.status && ['active', 'returned', 'lost'].includes(q.status)) and.push({ status: q.status });
  if (q.status === 'overdue') and.push({ status: 'active', due_at: { lt: new Date() } });
  if (q.student_id) and.push({ student_id: String(q.student_id) });
  if (q.item_id) and.push({ item_id: String(q.item_id) });
  if (q.q) { const s = String(q.q); and.push({ OR: [{ item: { title: { contains: s, mode: 'insensitive' } } }, { student: { student_number: { contains: s, mode: 'insensitive' } } }, { student: { first_name: { contains: s, mode: 'insensitive' } } }, { student: { last_name: { contains: s, mode: 'insensitive' } } }] }); }
  const where = and.length ? { AND: and } : {};
  const [total, rows] = await Promise.all([req.db.libraryLoan.count({ where }), req.db.libraryLoan.findMany({ where, include: LOAN_INC, orderBy: [{ borrowed_at: 'desc' }, { id: 'asc' }], skip, take: limit })]);
  res.json({ total, page, limit, items: rows.map(l => loanView(l, settings)) });
}));

router.post('/loans', ...staff, wrap(async (req, res) => {
  const { item_id, due_at } = req.body;
  if (!item_id) return res.status(422).json({ error: 'item_id is required' });
  let due;
  if (due_at !== undefined && due_at !== null) { due = new Date(due_at); if (isNaN(due) || due <= new Date()) return res.status(422).json({ error: 'due_at must be a future date' }); }
  const st = await lib.resolveStudent(req.db, req.body);
  const loan = await lib.issue(req.db, { itemId: String(item_id), student: st, dueAt: due, by: req.user });
  await audit(req.db, actorOf(req.user), 'library.loan.issue', 'library_loan', loan.id, { after: { item_id, student_id: st.id, due_at: loan.due_at } });
  const full = await req.db.libraryLoan.findUnique({ where: { id: loan.id }, include: LOAN_INC });
  res.status(201).json(loanView(full, await lib.getSettings(req.db)));
}));

const loanAction = (name, fn, audited = true) => wrap(async (req, res) => {
  const before = await req.db.libraryLoan.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: 'Loan not found' });
  const row = await fn(req, before);
  if (audited) await audit(req.db, actorOf(req.user), `library.loan.${name}`, 'library_loan', row.id, { before: { status: before.status, due_at: before.due_at, fine_amount: before.fine_amount }, after: { status: row.status, due_at: row.due_at, fine_amount: row.fine_amount }, reason: req.body?.reason });
  const full = await req.db.libraryLoan.findUnique({ where: { id: row.id }, include: LOAN_INC });
  res.json(loanView(full, await lib.getSettings(req.db)));
});
router.post('/loans/:id/return', ...staff, loanAction('return', (req) => lib.returnLoan(req.db, req.params.id)));
router.post('/loans/:id/lost', ...staff, loanAction('lost', (req) => {
  const a = req.body?.fine_amount;
  if (a !== undefined && !(typeof a === 'number' && a >= 0)) throw new lib.LibError('fine_amount must be a number ≥ 0');
  return lib.markLost(req.db, req.params.id, a);
}));
// A student renews their own loan; staff may renew any.
router.post('/loans/:id/renew', authenticate, authorize('librarian', 'super_admin', 'academic_officer', 'student'), loanAction('renew', (req, before) => {
  if (req.user.role === 'student' && before.student_id !== req.user.student_id) throw new lib.LibError('Loan not found', 404);
  return lib.renew(req.db, req.params.id);
}));
const fineAction = (name, mk) => loanAction(`fine.${name}`, async (req, before) => {
  if (!lib.unpaidFine(before)) throw new lib.LibError(before.fine_amount > 0 ? `This fine is already ${before.fine_waived ? 'waived' : 'paid'}` : 'This loan has no fine', 409);
  const data = mk(req);
  return req.db.libraryLoan.update({ where: { id: before.id }, data });
});
router.post('/loans/:id/fine/pay', ...staff, fineAction('pay', () => ({ fine_paid: true })));
router.post('/loans/:id/fine/waive', ...staff, fineAction('waive', req => {
  const reason = str(req.body?.reason);
  if (!reason || reason.length < 3) throw new lib.LibError('A reason is required to waive a fine');
  return { fine_waived: true };
}));

router.get('/overdue', ...staff, wrap(async (req, res) => {
  const settings = await lib.getSettings(req.db), now = new Date();
  const rows = await req.db.libraryLoan.findMany({ where: { status: 'active', due_at: { lt: now } }, include: LOAN_INC, orderBy: { due_at: 'asc' } });
  const items = rows.map(l => loanView(l, settings, now));
  res.json({ total: items.length, accrued_total: items.reduce((s, l) => s + l.accrued_fine, 0), currency: settings.currency, items });
}));

router.get('/fines', ...staff, wrap(async (req, res) => {
  const settings = await lib.getSettings(req.db), status = req.query.status || 'unpaid';
  const where = { fine_amount: { gt: 0 }, ...(status === 'unpaid' ? { fine_paid: false, fine_waived: false } : status === 'paid' ? { fine_paid: true } : status === 'waived' ? { fine_waived: true } : {}) };
  const rows = await req.db.libraryLoan.findMany({ where, include: LOAN_INC, orderBy: { borrowed_at: 'desc' } });
  const items = rows.map(l => loanView(l, settings));
  res.json({ total: items.length, amount: items.reduce((s, l) => s + l.fine_amount, 0), currency: settings.currency, items });
}));

// ── Reservations ────────────────────────────────────────────────────────────
const resView = (r, pos) => ({ id: r.id, item_id: r.item_id, title: r.item?.title ?? null, student_id: r.student_id, student: r.student ? `${r.student.first_name} ${r.student.last_name}` : null, matricule: r.student?.student_number ?? null, status: r.status, created_at: r.created_at, notified_at: r.notified_at, expires_at: r.status === 'ready' && r.notified_at ? new Date(new Date(r.notified_at).getTime() + lib.READY_HOURS * 3_600_000) : null, position: pos ?? null });
const RES_INC = { item: { select: { title: true } }, student: { select: { first_name: true, last_name: true, student_number: true } } };

router.get('/reservations', ...staff, wrap(async (req, res) => {
  await lib.sweep(req.db);
  const status = req.query.status;
  const where = status && status !== 'all' ? { status: String(status) } : status === 'all' ? {} : { status: { in: ['waiting', 'ready'] } };
  const rows = await req.db.libraryReservation.findMany({ where, include: RES_INC, orderBy: { created_at: 'asc' } });
  const pos = {};
  res.json(rows.map(r => resView(r, r.status === 'waiting' ? (pos[r.item_id] = (pos[r.item_id] ?? 0) + 1) : null)));
}));

router.post('/reservations', authenticate, authorize('student', 'librarian', 'super_admin', 'academic_officer'), wrap(async (req, res) => {
  const itemId = req.body.item_id;
  if (!itemId) return res.status(422).json({ error: 'item_id is required' });
  let studentId = req.user.student_id;
  if (req.user.role !== 'student') studentId = (await lib.resolveStudent(req.db, req.body)).id;
  else if (!studentId) return res.status(403).json({ error: 'No student profile linked to this account' });
  const r = await lib.reserve(req.db, String(itemId), studentId);
  const full = await req.db.libraryReservation.findUnique({ where: { id: r.id }, include: RES_INC });
  res.status(201).json(resView(full));
}));

router.post('/reservations/:id/cancel', authenticate, authorize('student', 'librarian', 'super_admin', 'academic_officer'), wrap(async (req, res) => {
  const r = await req.db.libraryReservation.findUnique({ where: { id: req.params.id } });
  if (!r || (req.user.role === 'student' && r.student_id !== req.user.student_id)) return res.status(404).json({ error: 'Reservation not found' });
  await lib.cancelReservation(req.db, r.id);
  if (isStaff(req.user)) await audit(req.db, actorOf(req.user), 'library.reservation.cancel', 'library_reservation', r.id);
  res.json({ ok: true });
}));

// ── Student's own library ───────────────────────────────────────────────────
router.get('/me', ...student, wrap(async (req, res) => {
  const sid = req.user.student_id;
  if (!sid) return res.status(403).json({ error: 'No student profile linked to this account' });
  await lib.sweep(req.db);
  const settings = await lib.getSettings(req.db), now = new Date();
  const [loans, resv] = await Promise.all([
    req.db.libraryLoan.findMany({ where: { student_id: sid }, include: LOAN_INC, orderBy: { borrowed_at: 'desc' } }),
    req.db.libraryReservation.findMany({ where: { student_id: sid, status: { in: ['waiting', 'ready'] } }, include: RES_INC, orderBy: { created_at: 'asc' } }),
  ]);
  const views = loans.map(l => loanView(l, settings, now));
  const positions = await Promise.all(resv.map(async r => (r.status === 'waiting' ? 1 + await req.db.libraryReservation.count({ where: { item_id: r.item_id, status: 'waiting', created_at: { lt: r.created_at } } }) : null)));
  res.json({
    settings: { loan_days: settings.loan_days, max_loans: settings.max_loans, max_renewals: settings.max_renewals, fine_per_day: settings.fine_per_day, currency: settings.currency, block_on_fines: settings.block_on_fines },
    loans: views.filter(l => l.status === 'active'), history: views.filter(l => l.status !== 'active'),
    fines: views.filter(l => l.fine_amount > 0), fines_total: views.filter(l => l.fine_open).reduce((s, l) => s + l.fine_amount, 0) + views.filter(l => l.status === 'active').reduce((s, l) => s + l.accrued_fine, 0),
    fines_unpaid: views.filter(l => l.fine_open).reduce((s, l) => s + l.fine_amount, 0),
    reservations: resv.map((r, i) => resView(r, positions[i])),
  });
}));

router.get('/stats', ...staff, wrap(async (req, res) => {
  await lib.sweep(req.db);
  const now = new Date();
  const [items, active, overdue, waiting, ready, unpaid] = await Promise.all([
    req.db.libraryItem.count({ where: { is_active: true } }), req.db.libraryLoan.count({ where: { status: 'active' } }), req.db.libraryLoan.count({ where: { status: 'active', due_at: { lt: now } } }),
    req.db.libraryReservation.count({ where: { status: 'waiting' } }), req.db.libraryReservation.count({ where: { status: 'ready' } }),
    req.db.libraryLoan.aggregate({ where: { fine_amount: { gt: 0 }, fine_paid: false, fine_waived: false }, _sum: { fine_amount: true }, _count: { _all: true } }),
  ]);
  res.json({ items, active_loans: active, overdue, reservations_waiting: waiting, reservations_ready: ready, unpaid_fines: unpaid._sum.fine_amount ?? 0, unpaid_fine_count: unpaid._count._all });
}));

router.post('/sweep', ...staff, wrap(async (req, res) => res.json({ expired: await lib.sweep(req.db) })));

module.exports = router;
