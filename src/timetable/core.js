// Shared timetable/room helpers: time maths, weekday of a date, who occupies a room when.
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const overlap = (a1, a2, b1, b2) => toMin(a1) < toMin(b2) && toMin(b1) < toMin(a2);
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/** monday…friday for a YYYY-MM-DD date, null for a weekend. */
const weekdayOf = s => ['sunday', ...DAYS, 'saturday'][new Date(`${s}T00:00:00Z`).getUTCDay()];
const WEEKDAY_NUM = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
const norm = s => (s ?? '').trim().toLowerCase();

async function periodMap(db) {
  const rows = await db.timetablePeriod.findMany({ orderBy: [{ sort_order: 'asc' }, { start_time: 'asc' }] });
  return { list: rows, byKey: new Map(rows.map(p => [p.key, p])) };
}

async function resolveTerm(db, termId) {
  if (termId) return db.term.findUnique({ where: { id: String(termId) }, include: { academic_year: true } });
  return (await db.term.findFirst({ where: { is_current: true }, include: { academic_year: true } }))
    ?? db.term.findFirst({ orderBy: { start_date: 'desc' }, include: { academic_year: true } });
}

/** A legacy (string-only) room reference matches a room by code or name. */
const legacyMatches = (room, str) => !!str && [norm(room.code), norm(room.name)].includes(norm(str));
const usesRoom = (room, row) => row.room_id === room.id || (!row.room_id && legacyMatches(room, row.room));

const SLOT_INC = { offering: { include: { subject: { select: { name: true, code: true } }, teacher: { select: { id: true, first_name: true, last_name: true } }, term: true } } };

/** Everything that holds `room` at a concrete date/time window. */
async function occupancyAt(db, room, { date, start, end, excludeBookingId, excludeExamId }) {
  const out = [], day = weekdayOf(date);
  const [periods, exams, bookings] = await Promise.all([
    periodMap(db),
    db.examSession.findMany({ where: { date, status: { not: 'cancelled' }, ...(excludeExamId && { id: { not: excludeExamId } }), OR: [{ room_id: room.id }, { room_id: null, room: { not: null } }] }, include: { subject: { select: { name: true, code: true } } } }),
    db.roomBooking.findMany({ where: { room_id: room.id, date, status: 'confirmed', ...(excludeBookingId && { id: { not: excludeBookingId } }) } }),
  ]);
  if (day) {
    const slots = await db.offeringSlot.findMany({ where: { day, offering: { term: { start_date: { lte: date }, end_date: { gte: date } } }, OR: [{ room_id: room.id }, { room_id: null, room: { not: null } }] }, include: SLOT_INC });
    for (const s of slots.filter(s => usesRoom(room, s))) {
      const p = periods.byKey.get(s.period_key);
      if (p && overlap(start, end, p.start_time, p.end_time)) out.push({ kind: 'slot', id: s.id, title: `${s.offering.subject.code} ${s.offering.subject.name} (${s.offering.section})`, date, start_time: p.start_time, end_time: p.end_time });
    }
  }
  for (const e of exams.filter(e => usesRoom(room, e)).filter(e => overlap(start, end, e.start_time, e.end_time)))
    out.push({ kind: 'exam', id: e.id, title: `${e.subject.code} ${e.title}`, date, start_time: e.start_time, end_time: e.end_time });
  for (const b of bookings.filter(b => overlap(start, end, b.start_time, b.end_time)))
    out.push({ kind: 'booking', id: b.id, title: b.title, date, start_time: b.start_time, end_time: b.end_time });
  return out;
}

/** Everything that holds `room` during a weekly slot (term, day, period): other slots, plus exams and bookings falling on that weekday within the term. */
async function occupancyOfSlot(db, room, { term, day, period, excludeSlotId }) {
  const out = [], periods = await periodMap(db), p = periods.byKey.get(period);
  if (!p) return out;
  const slots = await db.offeringSlot.findMany({ where: { day, period_key: period, offering: { term_id: term.id }, ...(excludeSlotId && { id: { not: excludeSlotId } }), OR: [{ room_id: room.id }, { room_id: null, room: { not: null } }] }, include: SLOT_INC });
  for (const s of slots.filter(s => usesRoom(room, s))) out.push({ kind: 'slot', id: s.id, title: `${s.offering.subject.code} ${s.offering.subject.name} (${s.offering.section})`, day, period_key: period, start_time: p.start_time, end_time: p.end_time });
  const range = { gte: term.start_date, lte: term.end_date };
  const [exams, bookings] = await Promise.all([
    db.examSession.findMany({ where: { date: range, status: { not: 'cancelled' }, OR: [{ room_id: room.id }, { room_id: null, room: { not: null } }] }, include: { subject: { select: { code: true } } } }),
    db.roomBooking.findMany({ where: { room_id: room.id, date: range, status: 'confirmed' } }),
  ]);
  for (const e of exams.filter(e => usesRoom(room, e) && weekdayOf(e.date) === day && overlap(p.start_time, p.end_time, e.start_time, e.end_time)))
    out.push({ kind: 'exam', id: e.id, title: `${e.subject.code} ${e.title}`, date: e.date, start_time: e.start_time, end_time: e.end_time });
  for (const b of bookings.filter(b => weekdayOf(b.date) === day && overlap(p.start_time, p.end_time, b.start_time, b.end_time)))
    out.push({ kind: 'booking', id: b.id, title: b.title, date: b.date, start_time: b.start_time, end_time: b.end_time });
  return out;
}

const enrolledCount = (db, offeringId) => db.courseEnrollment.count({ where: { offering_id: offeringId, status: 'registered' } });

module.exports = { DAYS, TIME_RE, WEEKDAY_NUM, toMin, overlap, validDate, weekdayOf, norm, periodMap, resolveTerm, legacyMatches, usesRoom, occupancyAt, occupancyOfSlot, enrolledCount, SLOT_INC };
