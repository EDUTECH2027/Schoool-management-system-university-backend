// Library rules: availability, loan lifecycle, reservation queue. Every state change that touches copies runs inside a
// transaction holding a row lock on the item (same technique as academics/registration.js), so two simultaneous issues of
// the last copy can never both succeed.
const { v4: uuid } = require('uuid');
const { notifyUsers, safe } = require('../utils/notify');

const DAY = 86_400_000;
const READY_HOURS = 72;                               // a "ready" reservation is held for 3 days
class LibError extends Error { constructor(message, status = 422, code) { super(message); this.status = status; this.code = code; } }

async function getSettings(db) {
  return (await db.librarySettings.findUnique({ where: { id: 'main' } }))
    ?? db.librarySettings.create({ data: { id: 'main' } });
}

const readyCutoff = () => new Date(Date.now() - READY_HOURS * 3_600_000);
const lockItem = (tx, id) => tx.$queryRaw`SELECT id FROM library_items WHERE id = ${id} FOR UPDATE`;
const lockStudent = (tx, id) => tx.$queryRaw`SELECT id FROM students WHERE id = ${id} FOR UPDATE`;

/** Counts per item: active loans, lost copies, ready (held) reservations, waiting reservations. */
async function counts(db, itemIds) {
  const out = new Map(itemIds.map(id => [id, { active: 0, lost: 0, ready: 0, waiting: 0 }]));
  if (!itemIds.length) return out;
  const loans = await db.libraryLoan.groupBy({ by: ['item_id', 'status'], where: { item_id: { in: itemIds }, status: { in: ['active', 'lost'] } }, _count: { _all: true } });
  for (const l of loans) out.get(l.item_id)[l.status] = l._count._all;
  const res = await db.libraryReservation.groupBy({ by: ['item_id', 'status'], where: { item_id: { in: itemIds }, status: { in: ['ready', 'waiting'] } }, _count: { _all: true } });
  for (const r of res) out.get(r.item_id)[r.status] = r._count._all;
  return out;
}
/** Copies a borrower without a reservation could take: total − active loans − lost copies − copies held for a "ready" reservation. */
const availableOf = (item, c) => (item.kind === 'digital' ? item.copies_total : Math.max(0, item.copies_total - c.active - c.lost - c.ready));

const studentUserIds = async (db, studentId) => (await db.user.findMany({ where: { student_id: studentId }, select: { id: true } })).map(u => u.id);

/** Ready reservations older than 3 days expire; the freed copy goes to the next waiting student. Safe to call at any time. */
async function sweep(db, itemId) {
  const stale = await db.libraryReservation.findMany({ where: { status: 'ready', notified_at: { lt: readyCutoff() }, ...(itemId && { item_id: itemId }) } });
  if (!stale.length) return 0;
  await db.libraryReservation.updateMany({ where: { id: { in: stale.map(r => r.id) } }, data: { status: 'expired' } });
  for (const r of stale) {
    const item = await db.libraryItem.findUnique({ where: { id: r.item_id }, select: { title: true } });
    await safe(async () => notifyUsers(db, await studentUserIds(db, r.student_id), { type: 'library', title: 'Library reservation expired', body: `Your reserved copy of "${item?.title}" was not collected within 3 days.`, link: '/student/library' }));
  }
  for (const id of new Set(stale.map(r => r.item_id))) await promote(db, id);
  return stale.length;
}

/** Hand free copies to the longest-waiting reservations (FIFO): waiting → ready, student notified. */
async function promote(db, itemId) {
  const item = await db.libraryItem.findUnique({ where: { id: itemId } });
  if (!item || !item.is_active || item.kind === 'digital') return 0;
  let n = 0;
  for (;;) {
    const c = (await counts(db, [itemId])).get(itemId);
    if (availableOf(item, c) < 1) break;
    const next = await db.libraryReservation.findFirst({ where: { item_id: itemId, status: 'waiting' }, orderBy: { created_at: 'asc' } });
    if (!next) break;
    await db.libraryReservation.update({ where: { id: next.id }, data: { status: 'ready', notified_at: new Date() } });
    n++;
    await safe(async () => notifyUsers(db, await studentUserIds(db, next.student_id), { type: 'library', title: 'Reserved item ready for pick-up', body: `"${item.title}" is waiting for you at the library desk. It is held for 3 days.`, link: '/student/library' }));
  }
  return n;
}

const overdueDays = (loan, at = new Date()) => Math.max(0, Math.floor((at.getTime() - new Date(loan.due_at).getTime()) / DAY));
const fineFor = (loan, settings, at) => overdueDays(loan, at) * settings.fine_per_day;
const unpaidFine = l => l.fine_amount > 0 && !l.fine_paid && !l.fine_waived;

async function resolveStudent(db, { student_id, matricule }) {
  const where = student_id ? { id: String(student_id) } : matricule ? { student_number: String(matricule).trim() } : null;
  if (!where) throw new LibError('student_id or matricule is required');
  const s = await db.student.findUnique({ where });
  if (!s) throw new LibError('Student not found', 404);
  return s;
}

async function studentFinesTotal(db, studentId) {
  const rows = await db.libraryLoan.findMany({ where: { student_id: studentId, fine_amount: { gt: 0 }, fine_paid: false, fine_waived: false } });
  return rows.reduce((s, l) => s + l.fine_amount, 0);
}

/** Issue a copy to a student. `by` = staff user. */
async function issue(db, { itemId, student, dueAt, by }) {
  await sweep(db, itemId);
  return db.$transaction(async tx => {
    await lockItem(tx, itemId);
    await lockStudent(tx, student.id);
    const item = await tx.libraryItem.findUnique({ where: { id: itemId } });
    if (!item) throw new LibError('Item not found', 404);
    if (!item.is_active) throw new LibError('This item is not active', 409, 'inactive');
    if (item.kind === 'digital') throw new LibError('Digital items are not loaned: open them online', 409, 'digital');
    if (!student.is_active || student.academic_status === 'withdrawn' || student.academic_status === 'graduated') throw new LibError('Student account is not active', 409, 'student_inactive');
    const settings = await getSettings(tx);
    const mine = await tx.libraryLoan.findMany({ where: { student_id: student.id, status: 'active' } });
    if (mine.some(l => l.item_id === itemId)) throw new LibError('The student already holds a copy of this item', 409, 'already_holding');
    if (mine.length >= settings.max_loans) throw new LibError(`Loan limit reached (${settings.max_loans} items)`, 409, 'max_loans');
    if (settings.block_on_fines) {
      const fines = await studentFinesTotal(tx, student.id);
      if (fines > 0) throw new LibError(`The student has unpaid fines (${fines} ${settings.currency}). Settle or waive them first.`, 409, 'unpaid_fines');
    }
    const c = (await counts(tx, [itemId])).get(itemId);
    const myRes = await tx.libraryReservation.findFirst({ where: { item_id: itemId, student_id: student.id, status: { in: ['ready', 'waiting'] } } });
    const free = item.copies_total - c.active - c.lost;           // physically on the shelf
    const ok = myRes?.status === 'ready' ? free >= 1 : free - c.ready >= 1;
    if (!ok) throw new LibError('No copy is available', 409, 'unavailable');
    if (myRes?.status === 'waiting') {
      const head = await tx.libraryReservation.findFirst({ where: { item_id: itemId, status: 'waiting' }, orderBy: { created_at: 'asc' } });
      if (head && head.id !== myRes.id) throw new LibError('Other students are ahead in the reservation queue', 409, 'queue');
    } else if (!myRes && c.waiting > 0 && free - c.ready >= 1) {
      // free copy with a queue: promote() should already have handed it over; never let it be taken by someone else.
      throw new LibError('This copy is reserved for the students waiting in the queue', 409, 'queue');
    }
    const due = dueAt ?? new Date(Date.now() + settings.loan_days * DAY);
    const loan = await tx.libraryLoan.create({ data: { id: uuid(), item_id: itemId, student_id: student.id, due_at: due, issued_by: by?.id ?? null } });
    if (myRes) await tx.libraryReservation.update({ where: { id: myRes.id }, data: { status: 'fulfilled' } });
    return loan;
  });
}

async function returnLoan(db, loanId) {
  const l0 = await db.libraryLoan.findUnique({ where: { id: loanId } });
  if (!l0) throw new LibError('Loan not found', 404);
  const loan = await db.$transaction(async tx => {
    await lockItem(tx, l0.item_id);
    const loan = await tx.libraryLoan.findUnique({ where: { id: loanId } });
    if (loan.status !== 'active') throw new LibError(`Loan is already ${loan.status}`, 409);
    const settings = await getSettings(tx);
    const now = new Date();
    return tx.libraryLoan.update({ where: { id: loanId }, data: { status: 'returned', returned_at: now, fine_amount: fineFor(loan, settings, now) } });
  });
  await promote(db, loan.item_id);
  return loan;
}

async function renew(db, loanId) {
  const l0 = await db.libraryLoan.findUnique({ where: { id: loanId } });
  if (!l0) throw new LibError('Loan not found', 404);
  return db.$transaction(async tx => {
    await lockItem(tx, l0.item_id);
    const loan = await tx.libraryLoan.findUnique({ where: { id: loanId } });
    if (loan.status !== 'active') throw new LibError(`Loan is already ${loan.status}`, 409);
    const settings = await getSettings(tx);
    if (loan.due_at < new Date()) throw new LibError('Overdue loans cannot be renewed: return the item', 409, 'overdue');
    if (loan.renewals >= settings.max_renewals) throw new LibError(`Renewal limit reached (${settings.max_renewals})`, 409, 'max_renewals');
    const waiting = await tx.libraryReservation.count({ where: { item_id: loan.item_id, status: { in: ['waiting', 'ready'] }, student_id: { not: loan.student_id } } });
    if (waiting) throw new LibError('Another student is waiting for this item', 409, 'reserved');
    return tx.libraryLoan.update({ where: { id: loanId }, data: { renewals: { increment: 1 }, due_at: new Date(new Date(loan.due_at).getTime() + settings.loan_days * DAY) } });
  });
}

/** Lost: the copy leaves circulation. Fine = overdue fine accrued so far, or the replacement amount the librarian enters (never lower than the accrued fine). */
async function markLost(db, loanId, amount) {
  const l0 = await db.libraryLoan.findUnique({ where: { id: loanId } });
  if (!l0) throw new LibError('Loan not found', 404);
  return db.$transaction(async tx => {
    await lockItem(tx, l0.item_id);
    const loan = await tx.libraryLoan.findUnique({ where: { id: loanId } });
    if (loan.status !== 'active') throw new LibError(`Loan is already ${loan.status}`, 409);
    const settings = await getSettings(tx);
    const accrued = fineFor(loan, settings);
    return tx.libraryLoan.update({ where: { id: loanId }, data: { status: 'lost', returned_at: new Date(), fine_amount: Math.max(accrued, amount ?? 0) } });
  });
}

async function reserve(db, itemId, studentId) {
  await sweep(db, itemId);
  return db.$transaction(async tx => {
    await lockItem(tx, itemId);
    const item = await tx.libraryItem.findUnique({ where: { id: itemId } });
    if (!item || !item.is_active) throw new LibError('Item not found', 404);
    if (item.kind === 'digital') throw new LibError('Digital items are always available online', 409, 'digital');
    if (await tx.libraryReservation.findFirst({ where: { item_id: itemId, student_id: studentId, status: { in: ['waiting', 'ready'] } } })) throw new LibError('You already reserved this item', 409, 'duplicate');
    if (await tx.libraryLoan.findFirst({ where: { item_id: itemId, student_id: studentId, status: 'active' } })) throw new LibError('You already hold a copy of this item', 409, 'already_holding');
    const c = (await counts(tx, [itemId])).get(itemId);
    if (availableOf(item, c) > 0 && c.waiting === 0) throw new LibError('A copy is available: ask for it at the library desk', 409, 'available');
    return tx.libraryReservation.create({ data: { id: uuid(), item_id: itemId, student_id: studentId } });
  });
}

async function cancelReservation(db, id) {
  const r = await db.libraryReservation.findUnique({ where: { id } });
  if (!r) throw new LibError('Reservation not found', 404);
  if (!['waiting', 'ready'].includes(r.status)) throw new LibError(`Reservation is already ${r.status}`, 409);
  await db.libraryReservation.update({ where: { id }, data: { status: 'cancelled' } });
  await promote(db, r.item_id);                         // a cancelled "ready" hold frees the copy for the next student
  return r;
}

module.exports = { LibError, DAY, READY_HOURS, getSettings, counts, availableOf, sweep, promote, overdueDays, fineFor, unpaidFine, resolveStudent, studentFinesTotal, issue, returnLoan, renew, markLost, reserve, cancelReservation, readyCutoff };
