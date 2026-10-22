// Timetable engine: builds weekly timetables from offering slots + periods, detects conflicts, renders iCalendar.
const T = require('./core');

const fullName = t => (t ? `${t.first_name} ${t.last_name}` : null);
const todayStr = () => new Date().toISOString().slice(0, 10);

function entryOf(s, periods, extra = {}) {
  const p = periods.byKey.get(s.period_key), o = s.offering;
  return {
    slot_id: s.id, offering_id: s.offering_id, day: s.day, period_key: s.period_key, start_time: p?.start_time ?? null, end_time: p?.end_time ?? null, period_known: !!p,
    course: o.subject.name, code: o.subject.code, section: o.section, lecturer: fullName(o.teacher), lecturer_id: o.teacher_id,
    room: s.room_ref?.code ?? s.room ?? null, room_id: s.room_id, room_name: s.room_ref?.name ?? null, building: s.room_ref?.building ?? null, ...extra,
  };
}
const sortEntries = es => es.sort((a, b) => T.DAYS.indexOf(a.day) - T.DAYS.indexOf(b.day) || (a.start_time ?? '99').localeCompare(b.start_time ?? '99') || a.code.localeCompare(b.code));
const examOf = e => ({ id: e.id, title: e.title, kind: e.kind, course: e.subject.name, code: e.subject.code, date: e.date, start_time: e.start_time, end_time: e.end_time, room: e.room_ref?.code ?? e.room ?? null, room_id: e.room_id, status: e.status, offering_id: e.offering_id });
const EXAM_INC = { subject: { select: { name: true, code: true } }, room_ref: { select: { code: true } } };
const SLOT_FULL = { ...T.SLOT_INC, room_ref: true };

async function slotsOfOfferings(db, offeringIds) {
  return offeringIds.length ? db.offeringSlot.findMany({ where: { offering_id: { in: offeringIds } }, include: SLOT_FULL }) : [];
}
const examWhere = (term, past) => ({ status: { not: 'cancelled' }, ...(past ? { term_id: term.id } : { date: { gte: todayStr() } }) });

/** Build a view. kind: student | lecturer | room | programme. */
async function buildView(db, kind, id, { termId, levelId, past } = {}) {
  const term = await T.resolveTerm(db, termId);
  if (!term) return { error: 'Semester not found', status: 404 };
  const periods = await T.periodMap(db);
  let subject, slots = [], exams = [], bookings = [];
  if (kind === 'student') {
    const st = await db.student.findUnique({ where: { id }, include: { class: { select: { name: true } } } });
    if (!st) return { error: 'Student not found', status: 404 };
    subject = { id: st.id, name: `${st.first_name} ${st.last_name}`, matricule: st.student_number };
    const enr = await db.courseEnrollment.findMany({ where: { student_id: id, term_id: term.id, status: 'registered' }, select: { offering_id: true } });
    const ids = enr.map(e => e.offering_id);
    slots = await slotsOfOfferings(db, ids);
    exams = await db.examSession.findMany({ where: { ...examWhere(term, past), OR: [{ candidates: { some: { student_id: id } } }, ...(ids.length ? [{ offering_id: { in: ids } }] : [])] }, include: EXAM_INC, orderBy: [{ date: 'asc' }, { start_time: 'asc' }] });
  } else if (kind === 'lecturer') {
    const t = await db.teacher.findUnique({ where: { id } });
    if (!t) return { error: 'Lecturer not found', status: 404 };
    subject = { id: t.id, name: fullName(t) };
    const offs = await db.courseOffering.findMany({ where: { teacher_id: id, term_id: term.id }, select: { id: true } });
    slots = await slotsOfOfferings(db, offs.map(o => o.id));
    exams = await db.examSession.findMany({ where: { ...examWhere(term, past), OR: [{ offering: { teacher_id: id } }, { invigilators: { some: { teacher_id: id } } }] }, include: EXAM_INC, orderBy: [{ date: 'asc' }, { start_time: 'asc' }] });
  } else if (kind === 'room') {
    const room = await db.room.findUnique({ where: { id } });
    if (!room) return { error: 'Room not found', status: 404 };
    subject = { id: room.id, name: `${room.code} — ${room.name}`, capacity: room.capacity };
    const cand = await db.offeringSlot.findMany({ where: { offering: { term_id: term.id }, OR: [{ room_id: id }, { room_id: null, room: { not: null } }] }, include: SLOT_FULL });
    slots = cand.filter(s => T.usesRoom(room, s));
    exams = (await db.examSession.findMany({ where: { ...examWhere(term, past), OR: [{ room_id: id }, { room_id: null, room: { not: null } }] }, include: EXAM_INC, orderBy: [{ date: 'asc' }, { start_time: 'asc' }] })).filter(e => T.usesRoom(room, e));
    bookings = await db.roomBooking.findMany({ where: { room_id: id, status: 'confirmed', date: { gte: past ? term.start_date : todayStr() } }, orderBy: [{ date: 'asc' }, { start_time: 'asc' }], take: 200 });
  } else {
    const prog = await db.programme.findUnique({ where: { id } });
    if (!prog) return { error: 'Programme not found', status: 404 };
    subject = { id: prog.id, name: prog.name, level_id: levelId ?? null };
    const pcs = await db.programmeCourse.findMany({ where: { programme_id: id, semester: term.name, ...(levelId && { level_id: levelId }) }, select: { subject_id: true } });
    const offs = pcs.length ? await db.courseOffering.findMany({ where: { term_id: term.id, subject_id: { in: pcs.map(p => p.subject_id) } }, select: { id: true } }) : [];
    slots = await slotsOfOfferings(db, offs.map(o => o.id));
    exams = offs.length ? await db.examSession.findMany({ where: { ...examWhere(term, past), offering_id: { in: offs.map(o => o.id) } }, include: EXAM_INC, orderBy: [{ date: 'asc' }, { start_time: 'asc' }] }) : [];
  }
  return {
    view: kind, subject, term: { id: term.id, name: term.name, academic_year: term.academic_year?.label ?? null, start_date: term.start_date, end_date: term.end_date },
    periods: periods.list.map(p => ({ key: p.key, label: p.label, start_time: p.start_time, end_time: p.end_time })),
    entries: sortEntries(slots.map(s => entryOf(s, periods))), exams: exams.map(examOf),
    bookings: bookings.map(b => ({ id: b.id, title: b.title, date: b.date, start_time: b.start_time, end_time: b.end_time })),
  };
}

// ── Conflicts ───────────────────────────────────────────────────────────────
const link = (label, to) => ({ label, to });
async function conflictsReport(db, termId) {
  const term = await T.resolveTerm(db, termId);
  if (!term) return { error: 'Semester not found', status: 404 };
  const [periods, rooms, slots, enr, exams] = await Promise.all([
    T.periodMap(db), db.room.findMany(),
    db.offeringSlot.findMany({ where: { offering: { term_id: term.id } }, include: SLOT_FULL }),
    db.courseEnrollment.findMany({ where: { term_id: term.id, status: 'registered' }, select: { offering_id: true, student_id: true, student: { select: { first_name: true, last_name: true, student_number: true } } } }),
    db.examSession.findMany({ where: { term_id: term.id, status: { not: 'cancelled' } }, include: { subject: { select: { code: true, name: true } }, candidates: { select: { student_id: true, student: { select: { first_name: true, last_name: true } } } } } }),
  ]);
  const roomOf = r => (r.room_id ? rooms.find(x => x.id === r.room_id) : r.room ? rooms.find(x => T.legacyMatches(x, r.room)) : null) ?? null;
  const enrolled = new Map(), studentsOf = new Map();
  for (const e of enr) { enrolled.set(e.offering_id, (enrolled.get(e.offering_id) ?? 0) + 1); (studentsOf.get(e.offering_id) ?? studentsOf.set(e.offering_id, []).get(e.offering_id)).push(e); }
  const out = [], label = s => `${s.offering.subject.code} (${s.offering.section})`;
  const push = c => out.push({ id: `${c.type}:${[...(c.slot_ids ?? []), ...(c.exam_ids ?? [])].join('+')}${c.day ? ':' + c.day : ''}${c.period_key ? ':' + c.period_key : ''}`, ...c });
  const groups = (items, keyFn) => { const m = new Map(); for (const i of items) { const k = keyFn(i); if (k) (m.get(k) ?? m.set(k, []).get(k)).push(i); } return [...m.values()].filter(g => g.length > 1); };

  for (const s of slots.filter(s => !periods.byKey.has(s.period_key)))
    push({ type: 'unknown_period', severity: 'error', message: `${label(s)} uses period ${s.period_key} on ${s.day}, which is not defined`, slot_ids: [s.id], offering_ids: [s.offering_id], day: s.day, period_key: s.period_key, links: [link('Periods', '/academics/rooms?tab=periods'), link('Offerings', '/academics/offerings')] });
  const known = slots.filter(s => periods.byKey.has(s.period_key));

  for (const g of groups(known, s => s.offering.teacher_id && `${s.offering.teacher_id}|${s.day}|${s.period_key}`))
    push({ type: 'lecturer_double_booked', severity: 'error', message: `${fullName(g[0].offering.teacher)} teaches ${g.map(label).join(' and ')} at the same time (${g[0].day} ${g[0].period_key})`, slot_ids: g.map(s => s.id), offering_ids: g.map(s => s.offering_id), day: g[0].day, period_key: g[0].period_key, links: [link('Offerings', '/academics/offerings')] });

  for (const g of groups(known, s => { const r = roomOf(s); return r ? `${r.id}|${s.day}|${s.period_key}` : null; }))
    push({ type: 'room_double_booked', severity: 'error', message: `Room ${roomOf(g[0]).code} is used by ${g.map(label).join(' and ')} at the same time (${g[0].day} ${g[0].period_key})`, slot_ids: g.map(s => s.id), offering_ids: g.map(s => s.offering_id), room_id: roomOf(g[0]).id, day: g[0].day, period_key: g[0].period_key, links: [link('Assign rooms', '/academics/rooms?tab=assignments')] });

  // a student registered in two offerings that meet at the same time
  const clash = new Map();
  const byStudent = new Map();
  for (const s of known) for (const e of studentsOf.get(s.offering_id) ?? []) { const k = `${e.student_id}|${s.day}|${s.period_key}`; (byStudent.get(k) ?? byStudent.set(k, []).get(k)).push({ s, e }); }
  for (const g of byStudent.values()) {
    const offs = [...new Set(g.map(x => x.s.offering_id))]; if (offs.length < 2) continue;
    const key = offs.sort().join('+') + `|${g[0].s.day}|${g[0].s.period_key}`;
    const c = clash.get(key) ?? { slots: [...new Map(g.map(x => [x.s.offering_id, x.s])).values()], students: [] };
    c.students.push(g[0].e.student); clash.set(key, c);
  }
  for (const c of clash.values())
    push({ type: 'student_clash', severity: 'error', message: `${c.students.length} student(s) (${c.students.slice(0, 3).map(s => `${s.first_name} ${s.last_name}`).join(', ')}${c.students.length > 3 ? '…' : ''}) are registered in ${c.slots.map(label).join(' and ')}, which meet at the same time (${c.slots[0].day} ${c.slots[0].period_key})`, slot_ids: c.slots.map(s => s.id), offering_ids: c.slots.map(s => s.offering_id), student_count: c.students.length, day: c.slots[0].day, period_key: c.slots[0].period_key, links: [link('Registration', '/academics/registration'), link('Offerings', '/academics/offerings')] });

  for (const s of slots) {
    const r = roomOf(s), n = enrolled.get(s.offering_id) ?? 0;
    if (r && n > r.capacity) push({ type: 'room_over_capacity', severity: 'warning', message: `${label(s)} has ${n} students in ${r.code} (capacity ${r.capacity}) on ${s.day} ${s.period_key}`, slot_ids: [s.id], offering_ids: [s.offering_id], room_id: r.id, day: s.day, period_key: s.period_key, enrolled: n, capacity: r.capacity, links: [link('Assign rooms', '/academics/rooms?tab=assignments')] });
    if (r && !r.is_active) push({ type: 'room_inactive', severity: 'warning', message: `${label(s)} is placed in ${r.code}, which is deactivated`, slot_ids: [s.id], offering_ids: [s.offering_id], room_id: r.id, day: s.day, period_key: s.period_key, links: [link('Assign rooms', '/academics/rooms?tab=assignments')] });
    if (!s.room_id && !s.room) push({ type: 'no_room', severity: 'info', message: `${label(s)} on ${s.day} ${s.period_key} has no room`, slot_ids: [s.id], offering_ids: [s.offering_id], day: s.day, period_key: s.period_key, links: [link('Assign rooms', '/academics/rooms?tab=assignments')] });
  }

  // exams: same room overlapping, same student overlapping, and exam vs weekly class in the room
  const withRoom = exams.map(e => ({ e, r: roomOf(e) }));
  for (let i = 0; i < withRoom.length; i++) for (let j = i + 1; j < withRoom.length; j++) {
    const a = withRoom[i], b = withRoom[j];
    if (a.e.date !== b.e.date || !T.overlap(a.e.start_time, a.e.end_time, b.e.start_time, b.e.end_time)) continue;
    if (a.r && b.r && a.r.id === b.r.id) push({ type: 'exam_room_double_booked', severity: 'error', message: `Room ${a.r.code} hosts ${a.e.subject.code} and ${b.e.subject.code} exams that overlap on ${a.e.date}`, exam_ids: [a.e.id, b.e.id], slot_ids: [], offering_ids: [], room_id: a.r.id, links: [link('Assign rooms', '/academics/rooms?tab=assignments'), link('Exams', '/academics/exams')] });
    const shared = a.e.candidates.filter(c => b.e.candidates.some(d => d.student_id === c.student_id));
    if (shared.length) push({ type: 'exam_student_clash', severity: 'error', message: `${shared.length} candidate(s) have overlapping ${a.e.subject.code} and ${b.e.subject.code} exams on ${a.e.date}`, exam_ids: [a.e.id, b.e.id], slot_ids: [], offering_ids: [], student_count: shared.length, links: [link('Exams', '/academics/exams')] });
  }
  for (const { e, r } of withRoom) {
    if (!r) continue;
    const day = T.weekdayOf(e.date);
    for (const s of known.filter(s => s.day === day && T.usesRoom(r, s))) {
      const p = periods.byKey.get(s.period_key);
      if (T.overlap(e.start_time, e.end_time, p.start_time, p.end_time) && e.date >= term.start_date && e.date <= term.end_date)
        push({ type: 'room_double_booked', severity: 'error', message: `Room ${r.code} has the ${e.subject.code} exam on ${e.date} while ${label(s)} meets (${s.day} ${s.period_key})`, slot_ids: [s.id], offering_ids: [s.offering_id], exam_ids: [e.id], room_id: r.id, day: s.day, period_key: s.period_key, links: [link('Assign rooms', '/academics/rooms?tab=assignments'), link('Exams', '/academics/exams')] });
    }
    const bks = await db.roomBooking.findMany({ where: { room_id: r.id, date: e.date, status: 'confirmed' } });
    for (const b of bks.filter(b => T.overlap(e.start_time, e.end_time, b.start_time, b.end_time)))
      push({ type: 'room_double_booked', severity: 'error', message: `Room ${r.code} is booked ("${b.title}") during the ${e.subject.code} exam on ${e.date}`, slot_ids: [], offering_ids: [], exam_ids: [e.id], room_id: r.id, links: [link('Bookings', '/academics/rooms?tab=bookings')] });
    const n = e.candidates.length;
    if (n > r.capacity) push({ type: 'room_over_capacity', severity: 'warning', message: `The ${e.subject.code} exam has ${n} candidates in ${r.code} (capacity ${r.capacity})`, exam_ids: [e.id], slot_ids: [], offering_ids: [], room_id: r.id, enrolled: n, capacity: r.capacity, links: [link('Assign rooms', '/academics/rooms?tab=assignments')] });
  }

  const order = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity] || a.type.localeCompare(b.type));
  return { term: { id: term.id, name: term.name, academic_year: term.academic_year?.label ?? null }, summary: { error: out.filter(c => c.severity === 'error').length, warning: out.filter(c => c.severity === 'warning').length, info: out.filter(c => c.severity === 'info').length }, conflicts: out };
}

// ── iCalendar (RFC 5545) ────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const parts = []; let i = 0, first = true;
  while (i < buf.length) {
    let len = first ? 75 : 74; let end = Math.min(buf.length, i + len);
    while (end < buf.length && (buf[end] & 0xC0) === 0x80) end--;        // never split a UTF-8 sequence
    parts.push((first ? '' : ' ') + buf.subarray(i, end).toString('utf8')); i = end; first = false;
  }
  return parts.join('\r\n');
}
const dt = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** First date ≥ `from` falling on `day` (UTC arithmetic on YYYY-MM-DD strings). */
function firstOn(from, day) {
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < 7; i++) { if (T.weekdayOf(d.toISOString().slice(0, 10)) === day) return d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 1); }
  return null;
}
function renderIcs(view, { includeExams = true, now = new Date() } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EduTech//Timetable//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(`Timetable — ${view.subject.name}`)}`];
  const term = view.term;
  for (const e of view.entries) {
    if (!e.period_known) continue;
    const first = firstOn(term.start_date, e.day);
    if (!first || first > term.end_date) continue;
    L.push('BEGIN:VEVENT', `UID:${e.slot_id}-${view.subject.id}@edutech`, `DTSTAMP:${stamp(now)}`, `DTSTART:${dt(first, e.start_time)}`, `DTEND:${dt(first, e.end_time)}`,
      `RRULE:FREQ=WEEKLY;UNTIL=${dt(term.end_date, '23:59')}`, `SUMMARY:${esc(`${e.code} ${e.course}`)}`);
    if (e.room) L.push(`LOCATION:${esc([e.room, e.building].filter(Boolean).join(', '))}`);
    L.push(`DESCRIPTION:${esc([e.course, `Section ${e.section}`, e.lecturer && `Lecturer: ${e.lecturer}`].filter(Boolean).join('\n'))}`, 'END:VEVENT');
  }
  if (includeExams) for (const x of view.exams) {
    L.push('BEGIN:VEVENT', `UID:exam-${x.id}-${view.subject.id}@edutech`, `DTSTAMP:${stamp(now)}`, `DTSTART:${dt(x.date, x.start_time)}`, `DTEND:${dt(x.date, x.end_time)}`, `SUMMARY:${esc(`EXAM ${x.code}: ${x.title}`)}`);
    if (x.room) L.push(`LOCATION:${esc(x.room)}`);
    L.push(`DESCRIPTION:${esc(`${x.course} (${x.kind})`)}`, 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildView, conflictsReport, renderIcs, fold, firstOn };
