// Rooms, ad-hoc bookings, timetable periods and room assignment of weekly slots / exam sessions. See docs/TIMETABLE.md.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const T = require('../timetable/core');

const manage = [authenticate, authorize('super_admin', 'academic_officer')];
const read = [authenticate, authorize('super_admin', 'academic_officer', 'teacher')];
const actorOf = u => ({ id: u.id, name: u.name, role: u.role === 'head_teacher' ? 'super_admin' : u.role });
const KINDS = ['classroom', 'lab', 'lecture_hall', 'exam_hall', 'other'];
const str = v => (typeof v === 'string' ? v.trim() : v);
const opt = v => { const s = str(v); return s === '' || s == null ? null : s; };
const bad = (res, error, status = 422, extra) => res.status(status).json({ error, ...extra });
const lockRoom = (tx, id) => tx.$queryRaw`SELECT id FROM rooms WHERE id = ${id} FOR UPDATE`;

// ── Periods ─────────────────────────────────────────────────────────────────
router.get('/periods', authenticate, async (req, res) => res.json((await T.periodMap(req.db)).list));

async function periodCheck(db, { key, start_time, end_time }, excludeId) {
  if (!T.TIME_RE.test(start_time || '') || !T.TIME_RE.test(end_time || '')) return 'start_time and end_time must be HH:MM';
  if (T.toMin(end_time) <= T.toMin(start_time)) return 'end_time must be after start_time';
  const others = await db.timetablePeriod.findMany({ where: excludeId ? { id: { not: excludeId } } : {} });
  const clash = others.find(p => T.overlap(start_time, end_time, p.start_time, p.end_time));
  return clash ? `Overlaps period ${clash.key} (${clash.start_time}–${clash.end_time})` : null;
}
router.post('/periods', ...manage, async (req, res) => {
  const key = str(req.body.key)?.toUpperCase(), label = str(req.body.label) || key;
  if (!key || !/^[A-Z0-9_-]{1,12}$/.test(key)) return bad(res, 'key is required (letters/digits, e.g. P9)');
  const err = await periodCheck(req.db, req.body); if (err) return bad(res, err, err.startsWith('Overlaps') ? 409 : 422);
  const sort = Number.isInteger(req.body.sort_order) ? req.body.sort_order : (await req.db.timetablePeriod.count()) + 1;
  try {
    const row = await req.db.timetablePeriod.create({ data: { id: uuid(), key, label, start_time: req.body.start_time, end_time: req.body.end_time, sort_order: sort } });
    await audit(req.db, actorOf(req.user), 'period.create', 'timetable_period', row.id, { after: row });
    res.status(201).json(row);
  } catch (e) { if (e.code === 'P2002') return bad(res, 'A period with this key already exists', 409); throw e; }
});
router.put('/periods/:id', ...manage, async (req, res) => {
  const p = await req.db.timetablePeriod.findUnique({ where: { id: req.params.id } });
  if (!p) return bad(res, 'Period not found', 404);
  if (req.body.key !== undefined && String(req.body.key).toUpperCase() !== p.key) return bad(res, 'A period key cannot be changed (slots reference it)', 422);
  const next = { start_time: req.body.start_time ?? p.start_time, end_time: req.body.end_time ?? p.end_time };
  const err = await periodCheck(req.db, next, p.id); if (err) return bad(res, err, err.startsWith('Overlaps') ? 409 : 422);
  const row = await req.db.timetablePeriod.update({ where: { id: p.id }, data: { ...next, label: str(req.body.label) || p.label, sort_order: Number.isInteger(req.body.sort_order) ? req.body.sort_order : p.sort_order } });
  await audit(req.db, actorOf(req.user), 'period.update', 'timetable_period', p.id, { before: p, after: row });
  res.json(row);
});
router.delete('/periods/:id', ...manage, async (req, res) => {
  const p = await req.db.timetablePeriod.findUnique({ where: { id: req.params.id } });
  if (!p) return bad(res, 'Period not found', 404);
  const n = await req.db.offeringSlot.count({ where: { period_key: p.key } });
  if (n) return bad(res, `${n} weekly slot(s) use this period. Move them first.`, 409);
  await req.db.timetablePeriod.delete({ where: { id: p.id } });
  await audit(req.db, actorOf(req.user), 'period.delete', 'timetable_period', p.id, { before: p });
  res.status(204).end();
});

// ── Bookings ────────────────────────────────────────────────────────────────
router.get('/bookings', ...read, async (req, res) => {
  const q = req.query, where = {};
  if (q.room_id) where.room_id = String(q.room_id);
  if (q.status) where.status = String(q.status);
  if (q.from || q.to) where.date = { ...(q.from && { gte: String(q.from) }), ...(q.to && { lte: String(q.to) }) };
  const rows = await req.db.roomBooking.findMany({ where, include: { room: { select: { code: true, name: true } } }, orderBy: [{ date: 'asc' }, { start_time: 'asc' }], take: 500 });
  res.json(rows.map(({ room, ...b }) => ({ ...b, room_code: room.code, room_name: room.name })));
});
router.post('/bookings', ...manage, async (req, res) => {
  const b = req.body, title = str(b.title);
  if (!b.room_id || !title) return bad(res, 'room_id and title are required');
  if (!T.validDate(b.date)) return bad(res, 'date must be YYYY-MM-DD');
  if (!T.TIME_RE.test(b.start_time || '') || !T.TIME_RE.test(b.end_time || '') || T.toMin(b.end_time) <= T.toMin(b.start_time)) return bad(res, 'start_time/end_time must be HH:MM with end after start');
  const out = await req.db.$transaction(async tx => {
    await lockRoom(tx, String(b.room_id));
    const room = await tx.room.findUnique({ where: { id: String(b.room_id) } });
    if (!room) return { s: 404, e: 'Room not found' };
    if (!room.is_active) return { s: 409, e: 'This room is not active' };
    const conflicts = await T.occupancyAt(tx, room, { date: b.date, start: b.start_time, end: b.end_time });
    if (conflicts.length) return { s: 409, e: 'The room is already in use at that time', conflicts, code: 'room_conflict' };
    return { row: await tx.roomBooking.create({ data: { id: uuid(), room_id: room.id, title: title.slice(0, 200), date: b.date, start_time: b.start_time, end_time: b.end_time, booked_by: req.user.name } }) };
  });
  if (out.e) return bad(res, out.e, out.s, { conflicts: out.conflicts, code: out.code });
  await audit(req.db, actorOf(req.user), 'booking.create', 'room_booking', out.row.id, { after: out.row });
  res.status(201).json(out.row);
});
router.post('/bookings/:id/cancel', ...manage, async (req, res) => {
  const b = await req.db.roomBooking.findUnique({ where: { id: req.params.id } });
  if (!b) return bad(res, 'Booking not found', 404);
  if (b.status === 'cancelled') return bad(res, 'Booking is already cancelled', 409);
  const row = await req.db.roomBooking.update({ where: { id: b.id }, data: { status: 'cancelled' } });
  await audit(req.db, actorOf(req.user), 'booking.cancel', 'room_booking', b.id, { before: { status: b.status }, after: { status: 'cancelled' }, reason: req.body?.reason });
  res.json(row);
});

// ── Availability finder ─────────────────────────────────────────────────────
router.get('/available', ...read, async (req, res) => {
  const q = req.query, minCap = parseInt(q.min_capacity) || 0;
  const where = { is_active: true, capacity: { gte: minCap }, ...(q.kind && { kind: String(q.kind) }) };
  const rooms = await req.db.room.findMany({ where, orderBy: [{ capacity: 'asc' }, { code: 'asc' }] });
  let busy;
  if (q.date) {
    if (!T.validDate(q.date) || !T.TIME_RE.test(q.start_time || '') || !T.TIME_RE.test(q.end_time || '') || T.toMin(q.end_time) <= T.toMin(q.start_time)) return bad(res, 'date (YYYY-MM-DD), start_time and end_time (HH:MM, end after start) are required');
    busy = await Promise.all(rooms.map(r => T.occupancyAt(req.db, r, { date: q.date, start: q.start_time, end: q.end_time })));
  } else if (q.day && q.period_key) {
    if (!T.DAYS.includes(q.day)) return bad(res, 'day must be monday…friday');
    if (!(await T.periodMap(req.db)).byKey.has(q.period_key)) return bad(res, 'Unknown period', 404);
    const term = await T.resolveTerm(req.db, q.term_id);
    if (!term) return bad(res, 'Semester not found', 404);
    busy = await Promise.all(rooms.map(r => T.occupancyOfSlot(req.db, r, { term, day: q.day, period: q.period_key })));
  } else return bad(res, 'Give date+start_time+end_time, or day+period_key');
  res.json(rooms.map((r, i) => ({ ...r, available: busy[i].length === 0, busy: busy[i] })).filter(r => q.all === 'true' || r.available));
});

// ── Assignments (slots + exams) ─────────────────────────────────────────────
router.get('/assignments', ...manage, async (req, res) => {
  const term = await T.resolveTerm(req.db, req.query.term_id);
  if (!term) return bad(res, 'Semester not found', 404);
  const periods = await T.periodMap(req.db);
  const [slots, exams] = await Promise.all([
    req.db.offeringSlot.findMany({ where: { offering: { term_id: term.id } }, include: { ...T.SLOT_INC, room_ref: true } }),
    req.db.examSession.findMany({ where: { term_id: term.id }, include: { subject: { select: { name: true, code: true } }, room_ref: true, _count: { select: { candidates: true } } }, orderBy: [{ date: 'asc' }, { start_time: 'asc' }] }),
  ]);
  const enr = await req.db.courseEnrollment.groupBy({ by: ['offering_id'], where: { term_id: term.id, status: 'registered' }, _count: { _all: true } });
  const enrolled = new Map(enr.map(e => [e.offering_id, e._count._all]));
  res.json({
    term: { id: term.id, name: term.name, academic_year: term.academic_year?.label, start_date: term.start_date, end_date: term.end_date },
    slots: slots.map(s => {
      const p = periods.byKey.get(s.period_key), n = enrolled.get(s.offering_id) ?? 0;
      return { id: s.id, offering_id: s.offering_id, course: s.offering.subject.name, code: s.offering.subject.code, section: s.offering.section, lecturer: s.offering.teacher ? `${s.offering.teacher.first_name} ${s.offering.teacher.last_name}` : null, day: s.day, period_key: s.period_key, start_time: p?.start_time ?? null, end_time: p?.end_time ?? null, room: s.room, room_id: s.room_id, room_code: s.room_ref?.code ?? null, room_capacity: s.room_ref?.capacity ?? null, enrolled: n, offering_capacity: s.offering.capacity, over_capacity: !!s.room_ref && s.room_ref.capacity < n };
    }).sort((a, b) => T.DAYS.indexOf(a.day) - T.DAYS.indexOf(b.day) || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.code.localeCompare(b.code)),
    exams: exams.map(e => ({ id: e.id, title: e.title, kind: e.kind, course: e.subject.name, code: e.subject.code, date: e.date, start_time: e.start_time, end_time: e.end_time, status: e.status, room: e.room, room_id: e.room_id, room_code: e.room_ref?.code ?? null, room_capacity: e.room_ref?.capacity ?? null, candidates: e._count.candidates, over_capacity: !!e.room_ref && e.room_ref.capacity < e._count.candidates })),
  });
});

const overrideOf = body => { const r = str(body.override_reason); return r && r.length >= 3 ? r : null; };

router.post('/assign-slot', ...manage, async (req, res) => {
  const b = req.body;
  let slot = b.slot_id ? await req.db.offeringSlot.findUnique({ where: { id: String(b.slot_id) }, include: T.SLOT_INC })
    : b.offering_id && b.day && b.period_key ? await req.db.offeringSlot.findUnique({ where: { offering_id_day_period_key: { offering_id: String(b.offering_id), day: b.day, period_key: b.period_key } }, include: T.SLOT_INC }) : null;
  if (!slot) return bad(res, 'Slot not found', 404);
  const before = { room_id: slot.room_id, room: slot.room };
  if (b.room_id === null || b.room_id === '') {                       // unassign
    const row = await req.db.offeringSlot.update({ where: { id: slot.id }, data: { room_id: null, room: null } });
    await audit(req.db, actorOf(req.user), 'slot.unassign-room', 'offering_slot', slot.id, { before });
    return res.json({ slot: row, room: null, warnings: [] });
  }
  if (!b.room_id) return bad(res, 'room_id is required (null to unassign)');
  const out = await req.db.$transaction(async tx => {
    await lockRoom(tx, String(b.room_id));
    const room = await tx.room.findUnique({ where: { id: String(b.room_id) } });
    if (!room) return { s: 404, e: 'Room not found' };
    if (!room.is_active) return { s: 409, e: 'This room is not active', code: 'room_inactive' };
    const periods = await T.periodMap(tx);
    if (!periods.byKey.has(slot.period_key)) return { s: 422, e: `Unknown period ${slot.period_key}`, code: 'unknown_period' };
    const conflicts = await T.occupancyOfSlot(tx, room, { term: slot.offering.term, day: slot.day, period: slot.period_key, excludeSlotId: slot.id });
    if (conflicts.length) return { s: 409, e: `${room.code} is already in use at that time`, conflicts, code: 'room_conflict' };
    const enrolled = await T.enrolledCount(tx, slot.offering_id), cap = slot.offering.capacity;
    const needed = Math.max(enrolled, cap ?? 0), override = overrideOf(b);
    let overridden = false;
    if (room.capacity < needed) {
      if (!override) return { s: 409, e: `${room.code} seats ${room.capacity} but ${enrolled} students are enrolled${cap ? ` (course capacity ${cap})` : ''}. Choose a larger room or give an override_reason.`, code: 'capacity', details: { room_capacity: room.capacity, enrolled, offering_capacity: cap } };
      overridden = true;
    }
    const row = await tx.offeringSlot.update({ where: { id: slot.id }, data: { room_id: room.id, room: room.code } });
    return { row, room, overridden, override, enrolled };
  });
  if (out.e) return bad(res, out.e, out.s, { code: out.code, conflicts: out.conflicts, details: out.details });
  await audit(req.db, actorOf(req.user), 'slot.assign-room', 'offering_slot', slot.id, { before, after: { room_id: out.room.id, room: out.room.code }, reason: out.overridden ? `capacity override: ${out.override}` : undefined });
  res.json({ slot: out.row, room: out.room, capacity_overridden: out.overridden, warnings: out.overridden ? [`Room capacity (${out.room.capacity}) is below enrolment (${out.enrolled}) — override recorded`] : [] });
});

router.post('/assign-exam', ...manage, async (req, res) => {
  const b = req.body;
  const exam = b.exam_id ? await req.db.examSession.findUnique({ where: { id: String(b.exam_id) } }) : null;
  if (!exam) return bad(res, 'Exam session not found', 404);
  if (exam.status === 'cancelled' || exam.status === 'held') return bad(res, `A ${exam.status} exam cannot be given a room`, 409);
  const before = { room_id: exam.room_id, room: exam.room };
  if (b.room_id === null || b.room_id === '') {
    const row = await req.db.examSession.update({ where: { id: exam.id }, data: { room_id: null, room: null } });
    await audit(req.db, actorOf(req.user), 'exam.unassign-room', 'exam_session', exam.id, { before });
    return res.json({ exam: row, room: null, warnings: [] });
  }
  if (!b.room_id) return bad(res, 'room_id is required (null to unassign)');
  const out = await req.db.$transaction(async tx => {
    await lockRoom(tx, String(b.room_id));
    const room = await tx.room.findUnique({ where: { id: String(b.room_id) } });
    if (!room) return { s: 404, e: 'Room not found' };
    if (!room.is_active) return { s: 409, e: 'This room is not active', code: 'room_inactive' };
    const conflicts = await T.occupancyAt(tx, room, { date: exam.date, start: exam.start_time, end: exam.end_time, excludeExamId: exam.id });
    if (conflicts.length) return { s: 409, e: `${room.code} is already in use at that time`, conflicts, code: 'room_conflict' };
    let seats = await tx.examCandidate.count({ where: { exam_id: exam.id } });
    if (!seats && exam.offering_id) seats = await T.enrolledCount(tx, exam.offering_id);
    const override = overrideOf(b);
    let overridden = false;
    if (room.capacity < seats) {
      if (!override) return { s: 409, e: `${room.code} seats ${room.capacity} but ${seats} candidates are expected. Choose a larger room or give an override_reason.`, code: 'capacity', details: { room_capacity: room.capacity, candidates: seats } };
      overridden = true;
    }
    return { row: await tx.examSession.update({ where: { id: exam.id }, data: { room_id: room.id, room: room.code } }), room, overridden, override, seats };
  });
  if (out.e) return bad(res, out.e, out.s, { code: out.code, conflicts: out.conflicts, details: out.details });
  await audit(req.db, actorOf(req.user), 'exam.assign-room', 'exam_session', exam.id, { before, after: { room_id: out.room.id, room: out.room.code }, reason: out.overridden ? `capacity override: ${out.override}` : undefined });
  res.json({ exam: out.row, room: out.room, capacity_overridden: out.overridden, warnings: out.overridden ? [`Room capacity (${out.room.capacity}) is below the expected ${out.seats} candidates — override recorded`] : [] });
});

// ── Rooms CRUD ──────────────────────────────────────────────────────────────
function roomData(b, partial) {
  const d = {};
  if (!partial || b.code !== undefined) { const c = str(b.code)?.toUpperCase(); if (!c || !/^[A-Z0-9][A-Z0-9 ._/-]{0,19}$/.test(c)) throw new Error('code is required (letters/digits, max 20)'); d.code = c; }
  if (!partial || b.name !== undefined) { const n = str(b.name) || d.code; if (!n) throw new Error('name is required'); d.name = n.slice(0, 120); }
  if (b.building !== undefined) d.building = opt(b.building);
  if (b.equipment !== undefined) d.equipment = opt(b.equipment);
  if (b.capacity !== undefined || !partial) { const c = b.capacity ?? 30; if (!Number.isInteger(c) || c < 1 || c > 10000) throw new Error('capacity must be a whole number between 1 and 10000'); d.capacity = c; }
  if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`); d.kind = b.kind; }
  if (b.is_active !== undefined) { if (typeof b.is_active !== 'boolean') throw new Error('is_active must be a boolean'); d.is_active = b.is_active; }
  return d;
}
const withCounts = r => { const { _count, ...x } = r; return { ...x, slot_count: _count.slots, exam_count: _count.exams, booking_count: _count.bookings }; };

router.get('/', ...read, async (req, res) => {
  const q = req.query, where = {};
  if (q.active === 'true') where.is_active = true; else if (q.active === 'false') where.is_active = false;
  if (q.kind) where.kind = String(q.kind);
  if (q.q) where.OR = [{ code: { contains: String(q.q), mode: 'insensitive' } }, { name: { contains: String(q.q), mode: 'insensitive' } }, { building: { contains: String(q.q), mode: 'insensitive' } }];
  const rows = await req.db.room.findMany({ where, orderBy: { code: 'asc' }, include: { _count: { select: { slots: true, exams: true, bookings: true } } } });
  res.json(rows.map(withCounts));
});
router.post('/', ...manage, async (req, res) => {
  let d; try { d = roomData(req.body, false); } catch (e) { return bad(res, e.message); }
  try {
    const row = await req.db.room.create({ data: { id: uuid(), ...d } });
    await audit(req.db, actorOf(req.user), 'room.create', 'room', row.id, { after: d });
    res.status(201).json(row);
  } catch (e) { if (e.code === 'P2002') return bad(res, 'A room with this code already exists', 409); throw e; }
});
router.get('/:id', ...read, async (req, res) => {
  const r = await req.db.room.findUnique({ where: { id: req.params.id }, include: { _count: { select: { slots: true, exams: true, bookings: true } } } });
  if (!r) return bad(res, 'Room not found', 404);
  res.json(withCounts(r));
});
router.put('/:id', ...manage, async (req, res) => {
  const r0 = await req.db.room.findUnique({ where: { id: req.params.id } });
  if (!r0) return bad(res, 'Room not found', 404);
  let d; try { d = roomData(req.body, true); } catch (e) { return bad(res, e.message); }
  try {
    const row = await req.db.room.update({ where: { id: r0.id }, data: d });
    // keep the legacy room string of assigned slots/exams in sync with a renamed code
    if (d.code && d.code !== r0.code) { await req.db.offeringSlot.updateMany({ where: { room_id: r0.id }, data: { room: d.code } }); await req.db.examSession.updateMany({ where: { room_id: r0.id }, data: { room: d.code } }); }
    await audit(req.db, actorOf(req.user), 'room.update', 'room', r0.id, { before: r0, after: row });
    res.json(row);
  } catch (e) { if (e.code === 'P2002') return bad(res, 'A room with this code already exists', 409); throw e; }
});
router.delete('/:id', ...manage, async (req, res) => {
  const r = await req.db.room.findUnique({ where: { id: req.params.id }, include: { _count: { select: { slots: true, exams: true, bookings: true } } } });
  if (!r) return bad(res, 'Room not found', 404);
  const n = r._count.slots + r._count.exams + r._count.bookings;
  if (n) return bad(res, `This room is referenced by ${r._count.slots} slot(s), ${r._count.exams} exam(s) and ${r._count.bookings} booking(s). Deactivate it instead.`, 409);
  await req.db.room.delete({ where: { id: r.id } });
  await audit(req.db, actorOf(req.user), 'room.delete', 'room', r.id, { before: r });
  res.status(204).end();
});

module.exports = router;
