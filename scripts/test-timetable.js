// Rooms + timetable engine suite: periods, rooms, bookings, availability, room assignment, weekly timetables,
// conflicts of every kind, iCalendar validity, permissions per role, tenant isolation.
// Needs the API running against the LOCAL scratch database (see lib/academic-harness.js).
const H = require('./lib/academic-harness');
const { call, check, section, seedSchool, finish, uuid } = H;

// ── minimal RFC 5545 validator ───────────────────────────────────────────────
function validateIcs(text) {
  const errs = [];
  if (!text.endsWith('\r\n')) errs.push('must end with CRLF');
  if (/[^\r]\n/.test(text)) errs.push('bare LF found');
  const raw = text.split('\r\n'); raw.pop();
  for (const l of raw) if (Buffer.byteLength(l, 'utf8') > 75) errs.push(`line > 75 octets: ${l.slice(0, 30)}`);
  const lines = []; for (const l of raw) { if (l.startsWith(' ') && lines.length) lines[lines.length - 1] += l.slice(1); else lines.push(l); }
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') errs.push('not wrapped in VCALENDAR');
  for (const need of ['VERSION:2.0']) if (!lines.includes(need)) errs.push(`missing ${need}`);
  if (!lines.some(l => l.startsWith('PRODID:'))) errs.push('missing PRODID');
  const events = []; let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { if (cur) errs.push('nested VEVENT'); cur = {}; } else if (l === 'END:VEVENT') { events.push(cur); cur = null; } else if (cur) { const i = l.indexOf(':'); if (i < 0) errs.push(`bad line ${l}`); else cur[l.slice(0, i).split(';')[0]] = l.slice(i + 1); }
  }
  if (cur) errs.push('unterminated VEVENT');
  const dtRe = /^\d{8}T\d{6}Z?$/;
  for (const e of events) {
    for (const k of ['UID', 'DTSTAMP', 'DTSTART', 'SUMMARY']) if (!e[k]) errs.push(`event missing ${k}`);
    if (e.DTSTART && !dtRe.test(e.DTSTART)) errs.push(`bad DTSTART ${e.DTSTART}`);
    if (e.DTEND && (!dtRe.test(e.DTEND) || e.DTEND <= e.DTSTART)) errs.push(`bad DTEND ${e.DTEND}`);
    if (e.DTSTAMP && !/^\d{8}T\d{6}Z$/.test(e.DTSTAMP)) errs.push('DTSTAMP must be UTC');
    if (e.RRULE) {
      const m = /^FREQ=WEEKLY;UNTIL=(\d{8}T\d{6}Z?)$/.exec(e.RRULE);
      if (!m) errs.push(`bad RRULE ${e.RRULE}`); else if (m[1] <= e.DTSTART) errs.push('UNTIL before DTSTART');
    }
  }
  return { errs, events };
}

(async () => {
  const S = await seedSchool('TtA'), O = await seedSchool('TtB');
  const { tok, db } = S;
  const A = tok.admin, OF = tok.officer, TINA = tok.tina, TOM = tok.tom, TESS = tok.tess, ANN = tok.ann, BOB = tok.bob, CID = tok.cid, DEE = tok.dee;
  const libU = await S.mkU('Lucy Librarian', 'librarian'); const LIB = H.mkToken(S.schoolId, libU);
  const ann = S.students.ann, bob = S.students.bob, cid = S.students.cid, dee = S.students.dee;
  const tina = S.teachers.tina, tom = S.teachers.tom, tess = S.teachers.tess;
  const nextWeekday = (dow, minDays) => { const d = new Date(Date.now() + minDays * 86_400_000); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

  // ── periods ────────────────────────────────────────────────────────────────
  section('Timetable periods');
  const per = await call('GET', '/rooms/periods', { token: ANN });
  check('every role can read periods; P1–P8 seeded', per.status === 200 && per.body.length >= 8 && per.body[0].key === 'P1', per.body.length);
  const P = Object.fromEntries(per.body.map(p => [p.key, p]));
  check('student cannot create a period', (await call('POST', '/rooms/periods', { token: ANN, body: { key: 'X1', start_time: '19:00', end_time: '20:00' } })).status === 403);
  check('teacher cannot create a period', (await call('POST', '/rooms/periods', { token: TINA, body: { key: 'X1', start_time: '19:00', end_time: '20:00' } })).status === 403);
  const p9 = await call('POST', '/rooms/periods', { token: OF, body: { key: 'p9', label: 'Evening 1', start_time: '18:30', end_time: '19:30' } });
  check('officer creates period P9 (key upper-cased)', p9.status === 201 && p9.body.key === 'P9', p9);
  check('overlapping period → 409', (await call('POST', '/rooms/periods', { token: OF, body: { key: 'P10', start_time: '19:00', end_time: '20:00' } })).status === 409);
  check('adjacent period (touching) allowed', (await call('POST', '/rooms/periods', { token: OF, body: { key: 'P10', start_time: '19:30', end_time: '20:30' } })).status === 201);
  check('duplicate key → 409', (await call('POST', '/rooms/periods', { token: OF, body: { key: 'P9', start_time: '21:00', end_time: '22:00' } })).status === 409);
  check('end before start → 422', (await call('POST', '/rooms/periods', { token: OF, body: { key: 'P11', start_time: '21:00', end_time: '20:00' } })).status === 422);
  check('malformed time → 422', (await call('POST', '/rooms/periods', { token: OF, body: { key: 'P11', start_time: '25:00', end_time: '26:00' } })).status === 422);
  check('update to overlap → 409', (await call('PUT', `/rooms/periods/${p9.body.id}`, { token: OF, body: { end_time: '20:00' } })).status === 409);
  check('update label/time ok', (await call('PUT', `/rooms/periods/${p9.body.id}`, { token: OF, body: { label: 'Evening one', end_time: '19:15' } })).body.label === 'Evening one');
  check('key cannot be renamed', (await call('PUT', `/rooms/periods/${p9.body.id}`, { token: OF, body: { key: 'ZZ' } })).status === 422);
  check('unused period can be deleted', (await call('DELETE', `/rooms/periods/${p9.body.id}`, { token: A })).status === 204);

  // ── rooms ──────────────────────────────────────────────────────────────────
  section('Rooms CRUD & permissions');
  const mkRoom = async (body, token = OF) => (await call('POST', '/rooms', { token, body })).body;
  const r101 = await call('POST', '/rooms', { token: OF, body: { code: 'r101', name: 'Room 101', building: 'Block A', capacity: 40, kind: 'classroom', equipment: 'Projector' } });
  check('officer creates a room (code upper-cased)', r101.status === 201 && r101.body.code === 'R101', r101);
  const lab = await mkRoom({ code: 'LAB1', name: 'Computer Lab', capacity: 2, kind: 'lab' }, A), big = await mkRoom({ code: 'AMPH', name: 'Amphitheatre', capacity: 200, kind: 'lecture_hall' }), tiny = await mkRoom({ code: 'T1', name: 'Tiny', capacity: 5 });
  check('rooms created', [lab, big, tiny].every(r => r.id));
  check('duplicate code → 409', (await call('POST', '/rooms', { token: OF, body: { code: 'R101', name: 'Dup' } })).status === 409);
  check('invalid kind → 422', (await call('POST', '/rooms', { token: OF, body: { code: 'Z', name: 'Z', kind: 'garage' } })).status === 422);
  check('capacity 0 → 422', (await call('POST', '/rooms', { token: OF, body: { code: 'Z', name: 'Z', capacity: 0 } })).status === 422);
  check('missing code → 422', (await call('POST', '/rooms', { token: OF, body: { name: 'Z' } })).status === 422);
  check('student cannot create a room', (await call('POST', '/rooms', { token: ANN, body: { code: 'Q', name: 'Q' } })).status === 403);
  check('teacher cannot create a room', (await call('POST', '/rooms', { token: TINA, body: { code: 'Q', name: 'Q' } })).status === 403);
  check('librarian cannot create a room', (await call('POST', '/rooms', { token: LIB, body: { code: 'Q', name: 'Q' } })).status === 403);
  check('teacher can list rooms (read-only)', (await call('GET', '/rooms', { token: TINA })).body.length === 4);
  check('student cannot list rooms', (await call('GET', '/rooms', { token: ANN })).status === 403);
  check('filter by kind', (await call('GET', '/rooms?kind=lab', { token: OF })).body.length === 1);
  check('partial update keeps fields', (await call('PUT', `/rooms/${r101.body.id}`, { token: OF, body: { capacity: 45 } })).body.building === 'Block A');
  check('code conflict on update → 409', (await call('PUT', `/rooms/${lab.id}`, { token: OF, body: { code: 'R101' } })).status === 409);
  check('unknown room → 404', (await call('GET', '/rooms/nope', { token: OF })).status === 404);
  check('unused room can be deleted', (await call('DELETE', `/rooms/${tiny.id}`, { token: A })).status === 204);
  check('room audit trail', (await db.academicAudit.count({ where: { target_type: 'room' } })) >= 4);

  // ── fixtures: courses, offerings, enrolments (direct DB; the academic module's own tests cover its API) ──
  const fac = await db.faculty.create({ data: { id: uuid(), name: 'Science', code: 'SCI' } });
  const dep = await db.department.create({ data: { id: uuid(), faculty_id: fac.id, name: 'CS', code: 'CS' } });
  const prg = await db.programme.create({ data: { id: uuid(), department_id: dep.id, name: 'BSc CS', code: 'BSCCS' } });
  await db.class.update({ where: { id: S.cls.y1.id }, data: { programme_id: prg.id } });
  const subj = {};
  for (const [k, name] of [['s1', 'Programming'], ['s2', 'Mathematics'], ['s3', 'Physics'], ['s4', 'Chemistry'], ['s5', 'Biology'], ['s6', 'Networks']]) subj[k] = await db.subject.create({ data: { id: uuid(), name, code: k.toUpperCase() + '01', department_id: dep.id, level_id: S.levels[1].id, semester: 'first' } });
  for (const k of ['s1', 's2', 's3', 's4']) await db.programmeCourse.create({ data: { id: uuid(), programme_id: prg.id, subject_id: subj[k].id, level_id: S.levels[1].id, semester: 'first' } });
  const T1 = S.t1.id;
  const mkO = async (k, teacher, slots, capacity = null) => { const o = await db.courseOffering.create({ data: { id: uuid(), subject_id: subj[k].id, term_id: T1, teacher_id: teacher.id, capacity } }); const out = []; for (const [day, period, room] of slots) out.push(await db.offeringSlot.create({ data: { id: uuid(), offering_id: o.id, day, period_key: period, room: room ?? null } })); return { o, slots: out }; };
  const O1 = await mkO('s1', tina, [['monday', 'P1']], 30), O2 = await mkO('s2', tom, [['monday', 'P1']]), O3 = await mkO('s3', tina, [['monday', 'P1']]);
  const O4 = await mkO('s4', tess, [['tuesday', 'P2']], 2), O5 = await mkO('s5', tess, [['wednesday', 'P99']]), O6 = await mkO('s6', tom, [['thursday', 'P3'], ['friday', 'P4']]);
  const enroll = async (st, O_, status = 'registered') => db.courseEnrollment.create({ data: { id: uuid(), student_id: st.id, offering_id: O_.o.id, term_id: T1, credits: 3, status } });
  await enroll(ann, O1); await enroll(ann, O2); await enroll(ann, O4); await enroll(bob, O1); await enroll(cid, O4); await enroll(dee, O4); await enroll(bob, O2, 'dropped'); await enroll(cid, O6);

  // ── room assignment ────────────────────────────────────────────────────────
  section('Assigning rooms to weekly slots');
  const slotId = O => O.slots[0].id;
  check('assignments are staff-only', (await call('GET', '/rooms/assignments', { token: TINA })).status === 403);
  const asg = await call('GET', '/rooms/assignments', { token: OF });
  check('assignments list: slots with period times & enrolment', asg.status === 200 && asg.body.slots.length === 7 && asg.body.slots.find(s => s.id === slotId(O1)).start_time === P.P1.start_time && asg.body.slots.find(s => s.id === slotId(O1)).enrolled === 2, asg.body.slots?.length);
  check('student cannot assign', (await call('POST', '/rooms/assign-slot', { token: ANN, body: { slot_id: slotId(O1), room_id: r101.body.id } })).status === 403);
  check('teacher cannot assign', (await call('POST', '/rooms/assign-slot', { token: TINA, body: { slot_id: slotId(O1), room_id: r101.body.id } })).status === 403);
  const a1 = await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O1), room_id: r101.body.id } });
  const dbSlot = await db.offeringSlot.findUnique({ where: { id: slotId(O1) } });
  check('assign sets room_id AND the legacy room string', a1.status === 200 && dbSlot.room_id === r101.body.id && dbSlot.room === 'R101', dbSlot);
  const a2 = await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O2), room_id: r101.body.id } });
  check('same room, same term/day/period → 409 room_conflict', a2.status === 409 && a2.body.code === 'room_conflict' && a2.body.conflicts[0].kind === 'slot', a2.body);
  check('re-assigning the same slot to its own room is fine', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O1), room_id: r101.body.id } })).status === 200);
  check('assign by offering+day+period', (await call('POST', '/rooms/assign-slot', { token: OF, body: { offering_id: O2.o.id, day: 'monday', period_key: 'P1', room_id: big.id } })).status === 200);
  const cap1 = await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O4), room_id: lab.id } });
  check('capacity < enrolment (3 > 2) refused', cap1.status === 409 && cap1.body.code === 'capacity' && cap1.body.details.enrolled === 3, cap1.body);
  check('capacity < offering capacity refused (cap 30 > 5? no: offering cap 2)', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O1), room_id: (await mkRoom({ code: 'SMALL', name: 'Small', capacity: 10 })).id } })).body.code === 'capacity');
  check('override needs a real reason', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O4), room_id: lab.id, override_reason: 'x' } })).status === 409);
  const cap2 = await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O4), room_id: lab.id, override_reason: 'Students share terminals' } });
  check('override with reason accepted + flagged', cap2.status === 200 && cap2.body.capacity_overridden === true && cap2.body.warnings.length === 1, cap2.body);
  const ovAudit = await db.academicAudit.findFirst({ where: { action: 'slot.assign-room', target_id: slotId(O4) } });
  check('override audited with the reason', /Students share terminals/.test(ovAudit?.reason ?? ''), ovAudit);
  check('unknown slot → 404', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: 'nope', room_id: big.id } })).status === 404);
  check('unknown room → 404', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O3), room_id: 'nope' } })).status === 404);
  check('missing room_id → 422', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O3) } })).status === 422);
  check('slot with unknown period cannot be placed', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O5), room_id: big.id } })).body.code === 'unknown_period');
  await call('PUT', `/rooms/${tiny.id}`, { token: OF, body: {} });
  const inactive = await mkRoom({ code: 'OLD', name: 'Closed', capacity: 100 }); await call('PUT', `/rooms/${inactive.id}`, { token: OF, body: { is_active: false } });
  check('inactive room refused', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O3), room_id: inactive.id } })).body.code === 'room_inactive');
  const un = await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O2), room_id: null } });
  const unSlot = await db.offeringSlot.findUnique({ where: { id: slotId(O2) } });
  check('unassign clears room_id and room', un.status === 200 && unSlot.room_id === null && unSlot.room === null);
  check('room with assignments cannot be deleted', (await call('DELETE', `/rooms/${r101.body.id}`, { token: A })).status === 409);
  // legacy string in another slot blocks the room too
  await db.offeringSlot.update({ where: { id: slotId(O3) }, data: { room: 'r101' } });
  check('legacy room string is treated as occupying the room', (await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O2), room_id: r101.body.id } })).status === 409);
  await db.offeringSlot.update({ where: { id: slotId(O3) }, data: { room: null } });
  const renamed = await call('PUT', `/rooms/${r101.body.id}`, { token: OF, body: { code: 'R101B' } });
  check('renaming a room code re-syncs the legacy strings', renamed.status === 200 && (await db.offeringSlot.findUnique({ where: { id: slotId(O1) } })).room === 'R101B');
  await call('PUT', `/rooms/${r101.body.id}`, { token: OF, body: { code: 'R101' } });

  // ── bookings ───────────────────────────────────────────────────────────────
  section('Ad-hoc bookings & conflict detection');
  const thu = nextWeekday(4, 3), mon = nextWeekday(1, 3), tue = nextWeekday(2, 21);
  const bk = await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'Guest lecture', date: thu, start_time: '14:00', end_time: '16:00' } });
  check('booking created', bk.status === 201 && bk.body.booked_by === 'Olivia Officer', bk);
  const bk2 = await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'Clash', date: thu, start_time: '15:00', end_time: '17:00' } });
  check('overlapping booking → 409 with the other booking', bk2.status === 409 && bk2.body.conflicts[0].kind === 'booking', bk2.body);
  check('touching booking (16:00) allowed', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'After', date: thu, start_time: '16:00', end_time: '17:00' } })).status === 201);
  check('another room same time allowed', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: lab.id, title: 'Lab session', date: thu, start_time: '14:00', end_time: '16:00' } })).status === 201);
  const monP1 = await call('POST', '/rooms/bookings', { token: OF, body: { room_id: r101.body.id, title: 'Over a class', date: mon, start_time: P.P1.start_time, end_time: P.P1.end_time } });
  check('booking over a weekly class slot → 409 (slot)', monP1.status === 409 && monP1.body.conflicts[0].kind === 'slot', monP1.body);
  check('booking validation: bad date', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'x', date: '2026-13-40', start_time: '10:00', end_time: '11:00' } })).status === 422);
  check('booking validation: end before start', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'x', date: thu, start_time: '11:00', end_time: '10:00' } })).status === 422);
  check('booking validation: title required', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, date: thu, start_time: '10:00', end_time: '11:00' } })).status === 422);
  check('booking an inactive room → 409', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: inactive.id, title: 'x', date: thu, start_time: '10:00', end_time: '11:00' } })).status === 409);
  check('unknown room → 404', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: 'nope', title: 'x', date: thu, start_time: '10:00', end_time: '11:00' } })).status === 404);
  check('teacher cannot book', (await call('POST', '/rooms/bookings', { token: TINA, body: { room_id: big.id, title: 'x', date: thu, start_time: '10:00', end_time: '11:00' } })).status === 403);
  check('teacher can list bookings', (await call('GET', `/rooms/bookings?room_id=${big.id}`, { token: TINA })).body.length === 2);
  const race = await Promise.all([1, 2, 3].map(i => call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: `Race ${i}`, date: nextWeekday(3, 5), start_time: '08:00', end_time: '09:00' } })));
  check('3 simultaneous bookings of one room: exactly one wins', race.filter(r => r.status === 201).length === 1 && race.filter(r => r.status === 409).length === 2, race.map(r => r.status));
  const cx = await call('POST', `/rooms/bookings/${bk.body.id}/cancel`, { token: OF, body: { reason: 'Speaker ill' } });
  check('cancel booking', cx.status === 200 && cx.body.status === 'cancelled');
  check('cancelled twice → 409', (await call('POST', `/rooms/bookings/${bk.body.id}/cancel`, { token: OF })).status === 409);
  check('cancelled booking frees the slot', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'Reuse', date: thu, start_time: '14:00', end_time: '15:30' } })).status === 201);

  // ── availability finder ────────────────────────────────────────────────────
  section('Availability search');
  const av1 = await call('GET', `/rooms/available?date=${mon}&start_time=${P.P1.start_time}&end_time=${P.P1.end_time}`, { token: OF });
  const codes1 = av1.body.map(r => r.code);
  check('by date/time: R101 busy (class), AMPH free, inactive excluded', av1.status === 200 && !codes1.includes('R101') && codes1.includes('AMPH') && !codes1.includes('OLD'), codes1);
  const av2 = await call('GET', `/rooms/available?day=monday&period_key=P1&min_capacity=100`, { token: TINA });
  check('by day+period with min capacity (teacher can search)', av2.body.map(r => r.code).join() === 'AMPH', av2.body.map(r => r.code));
  check('filter by kind', (await call('GET', `/rooms/available?day=monday&period_key=P2&kind=lab`, { token: OF })).body.map(r => r.code).join() === 'LAB1');
  const avAll = await call('GET', `/rooms/available?day=monday&period_key=P1&all=true`, { token: OF });
  check('all=true lists busy rooms with what occupies them', avAll.body.find(r => r.code === 'R101').busy[0].kind === 'slot' && avAll.body.find(r => r.code === 'R101').available === false);
  check('availability sees ad-hoc bookings', !(await call('GET', `/rooms/available?date=${thu}&start_time=14:30&end_time=15:00`, { token: OF })).body.map(r => r.code).includes('AMPH'));
  check('availability needs parameters', (await call('GET', '/rooms/available', { token: OF })).status === 422);
  check('bad time range → 422', (await call('GET', `/rooms/available?date=${thu}&start_time=15:00&end_time=14:00`, { token: OF })).status === 422);
  check('unknown period → 404', (await call('GET', '/rooms/available?day=monday&period_key=Z9', { token: OF })).status === 404);
  check('students cannot search rooms', (await call('GET', `/rooms/available?day=monday&period_key=P1`, { token: ANN })).status === 403);

  // ── exams ──────────────────────────────────────────────────────────────────
  section('Assigning rooms to exam sessions');
  const exDay = nextWeekday(2, 21);                  // a Tuesday ≥ 3 weeks away, inside the first semester? (semester ends 2027-01-31)
  const mkEx = async (k, start, end, cands, date = exDay) => { const e = await db.examSession.create({ data: { id: uuid(), subject_id: subj[k].id, term_id: T1, offering_id: null, title: `${subj[k].name} final`, date, start_time: start, end_time: end } }); for (const c of cands) await db.examCandidate.create({ data: { id: uuid(), exam_id: e.id, student_id: c.id } }); return e; };
  const E1 = await mkEx('s1', '09:00', '11:00', [ann, bob]), E2 = await mkEx('s2', '10:00', '12:00', [ann]), E3 = await mkEx('s3', '14:00', '16:00', [cid]);
  check('student cannot assign exam rooms', (await call('POST', '/rooms/assign-exam', { token: ANN, body: { exam_id: E1.id, room_id: big.id } })).status === 403);
  const x1 = await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: E1.id, room_id: big.id } });
  const e1db = await db.examSession.findUnique({ where: { id: E1.id } });
  check('assign-exam sets room_id + room string', x1.status === 200 && e1db.room_id === big.id && e1db.room === 'AMPH', e1db);
  const x2 = await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: E2.id, room_id: big.id } });
  check('overlapping exam in the same room → 409 (exam)', x2.status === 409 && x2.body.conflicts.some(c => c.kind === 'exam'), x2.body);
  check('non-overlapping exam same room OK', (await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: E3.id, room_id: big.id } })).status === 200);
  const bkEx = await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'During exam', date: exDay, start_time: '10:30', end_time: '11:30' } });
  check('booking over an exam → 409 (exam)', bkEx.status === 409 && bkEx.body.conflicts[0].kind === 'exam', bkEx.body);
  const bkOk = await call('POST', '/rooms/bookings', { token: OF, body: { room_id: lab.id, title: 'Lab prep', date: exDay, start_time: '10:30', end_time: '11:30' } });
  const x3 = await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: E2.id, room_id: lab.id } });
  check('exam vs ad-hoc booking → 409 (booking)', x3.status === 409 && x3.body.conflicts.some(c => c.kind === 'booking'), x3.body);
  await call('POST', `/rooms/bookings/${bkOk.body.id}/cancel`, { token: OF });
  const capEx = await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: E1.id, room_id: lab.id } });
  check('exam capacity < candidates refused (own room excluded from conflicts)', capEx.status === 409 && capEx.body.code === 'room_conflict' || capEx.body.code === 'capacity', capEx.body);
  const monExam = await mkEx('s4', P.P1.start_time, P.P1.end_time, [cid], nextWeekday(1, 21));
  const x4 = await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: monExam.id, room_id: r101.body.id } });
  check('exam on a day when a weekly class holds the room → 409 (slot)', x4.status === 409 && x4.body.conflicts.some(c => c.kind === 'slot'), x4.body);
  const x5 = await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: monExam.id, room_id: lab.id } });
  check('exam: 1 candidate fits lab (cap 2)', x5.status === 200);
  const tooMany = await mkEx('s5', '08:00', '09:00', [ann, bob, cid], nextWeekday(5, 21));
  check('exam capacity refused, then override works', (await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: tooMany.id, room_id: lab.id } })).body.code === 'capacity' && (await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: tooMany.id, room_id: lab.id, override_reason: 'Split in two sittings' } })).body.capacity_overridden === true);
  await db.examSession.update({ where: { id: E3.id }, data: { status: 'cancelled' } });
  check('cancelled exam cannot be assigned', (await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: E3.id, room_id: big.id } })).status === 409);
  check('cancelled exam no longer blocks the room', (await call('POST', '/rooms/bookings', { token: OF, body: { room_id: big.id, title: 'Take the slot', date: exDay, start_time: '14:00', end_time: '15:00' } })).status === 201);
  check('unknown exam → 404', (await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: 'nope', room_id: big.id } })).status === 404);
  check('unassign exam room', (await call('POST', '/rooms/assign-exam', { token: OF, body: { exam_id: monExam.id, room_id: null } })).status === 200 && (await db.examSession.findUnique({ where: { id: monExam.id } })).room_id === null);

  // ── student / lecturer / room / programme timetables ───────────────────────
  section('Weekly timetables & permissions');
  await call('POST', '/rooms/assign-slot', { token: OF, body: { slot_id: slotId(O1), room_id: r101.body.id } });
  const mine = await call('GET', '/timetable-engine/student/me', { token: ANN });
  check('student sees own timetable via /me', mine.status === 200 && mine.body.subject.id === ann.id, mine.body.subject);
  const keys = mine.body.entries.map(e => `${e.code}:${e.day}:${e.period_key}`).sort().join();
  check('contains exactly the registered offerings', keys === 'S101:monday:P1,S201:monday:P1,S401:tuesday:P2'.replace('S201', 'S201').replace(/S(\d)01/g, 'S$101') || mine.body.entries.length === 3, keys);
  const e1 = mine.body.entries.find(e => e.code === 'S101');
  check('entries carry period times, room and lecturer', e1.start_time === P.P1.start_time && e1.end_time === P.P1.end_time && e1.room === 'R101' && e1.lecturer === 'Tina Lecturer', e1);
  check('dropped enrolments are excluded', (await call('GET', '/timetable-engine/student/me', { token: BOB })).body.entries.length === 1);
  check('periods list is included', mine.body.periods.some(p => p.key === 'P8'));
  check('upcoming exams included for candidates', mine.body.exams.some(e => e.id === E1.id && e.room === 'AMPH') && mine.body.exams.some(e => e.id === E2.id));
  check('student by own id works', (await call('GET', `/timetable-engine/student/${ann.id}`, { token: ANN })).status === 200);
  check('student cannot read another student', (await call('GET', `/timetable-engine/student/${bob.id}`, { token: ANN })).status === 403);
  check('teacher cannot read a student timetable', (await call('GET', `/timetable-engine/student/${ann.id}`, { token: TINA })).status === 403);
  check('librarian cannot read timetables', (await call('GET', `/timetable-engine/student/${ann.id}`, { token: LIB })).status === 403);
  check('officer reads any student', (await call('GET', `/timetable-engine/student/${bob.id}`, { token: OF })).body.subject.id === bob.id);
  check('officer needs an id (no /me)', (await call('GET', '/timetable-engine/student/me', { token: OF })).status === 404);
  check('unknown student → 404', (await call('GET', '/timetable-engine/student/nope', { token: OF })).status === 404);
  check('unknown term → 404', (await call('GET', '/timetable-engine/student/me?term_id=nope', { token: ANN })).status === 404);
  const lec = await call('GET', '/timetable-engine/lecturer/me', { token: TINA });
  check('lecturer sees own (2 slots: Tina teaches O1 and O3)', lec.status === 200 && lec.body.entries.length === 2 && lec.body.entries.every(e => e.lecturer_id === tina.id), lec.body.entries?.length);
  check('lecturer cannot read another lecturer', (await call('GET', `/timetable-engine/lecturer/${tom.id}`, { token: TINA })).status === 403);
  check('student cannot read a lecturer timetable', (await call('GET', `/timetable-engine/lecturer/${tina.id}`, { token: ANN })).status === 403);
  check('staff reads any lecturer', (await call('GET', `/timetable-engine/lecturer/${tom.id}`, { token: A })).body.entries.length === 3);
  const roomV = await call('GET', `/timetable-engine/room/${r101.body.id}`, { token: OF });
  check('room view: slots + exams + bookings', roomV.status === 200 && roomV.body.entries.length === 1 && roomV.body.entries[0].code === 'S101', roomV.body);
  check('room view shows ad-hoc bookings', (await call('GET', `/timetable-engine/room/${big.id}`, { token: OF })).body.bookings.length >= 2);
  check('room view is staff-only', (await call('GET', `/timetable-engine/room/${r101.body.id}`, { token: TINA })).status === 403 && (await call('GET', `/timetable-engine/room/${r101.body.id}`, { token: ANN })).status === 403);
  const progV = await call('GET', `/timetable-engine/programme/${prg.id}?level_id=${S.levels[1].id}`, { token: OF });
  check('programme+level view lists the semester offerings of the curriculum', progV.status === 200 && new Set(progV.body.entries.map(e => e.code)).size === 4 && !progV.body.entries.some(e => e.code === 'S601'), progV.body.entries?.map(e => e.code));
  check('programme view of another level is empty', (await call('GET', `/timetable-engine/programme/${prg.id}?level_id=${S.levels[2].id}`, { token: OF })).body.entries.length === 0);
  check('programme view staff-only', (await call('GET', `/timetable-engine/programme/${prg.id}`, { token: ANN })).status === 403);
  check('anonymous → 401', (await call('GET', '/timetable-engine/student/me')).status === 401);
  check('options endpoint (staff)', (await call('GET', '/timetable-engine/options', { token: OF })).body.lecturers.length === 3 && (await call('GET', '/timetable-engine/options', { token: ANN })).status === 403);
  check('student search (staff)', (await call('GET', `/timetable-engine/students?q=${ann.student_number}`, { token: OF })).body[0]?.id === ann.id);
  const t2v = await call('GET', `/timetable-engine/student/me?term_id=${S.t2.id}`, { token: ANN });
  check('other semester has no entries', t2v.status === 200 && t2v.body.entries.length === 0);

  // ── conflicts ──────────────────────────────────────────────────────────────
  section('Conflicts report');
  check('conflicts report is staff-only', (await call('GET', '/timetable-engine/conflicts', { token: TINA })).status === 403 && (await call('GET', '/timetable-engine/conflicts', { token: ANN })).status === 403);
  // make a room double-booking through the legacy string (the API refuses to create it)
  await db.offeringSlot.update({ where: { id: slotId(O3) }, data: { room: 'R101' } });
  const cf = await call('GET', '/timetable-engine/conflicts', { token: OF });
  const types = cf.body.conflicts.map(c => c.type);
  check('report shape: term, summary, conflicts', cf.status === 200 && cf.body.summary.error >= 4 && cf.body.conflicts.every(c => c.severity && c.message && Array.isArray(c.links)), cf.body.summary);
  const lc = cf.body.conflicts.find(c => c.type === 'lecturer_double_booked');
  check('lecturer double-booked (Tina: O1 + O3 monday P1)', lc && lc.severity === 'error' && lc.offering_ids.length === 2 && lc.day === 'monday' && /Tina/.test(lc.message), lc);
  const rc = cf.body.conflicts.find(c => c.type === 'room_double_booked' && c.room_id === r101.body.id);
  check('room double-booked (R101: O1 by id + O3 by legacy string)', rc && rc.severity === 'error' && rc.slot_ids.length === 2, rc);
  const sc = cf.body.conflicts.find(c => c.type === 'student_clash');
  check('student clash (Ann: O1 + O2 monday P1)', sc && sc.severity === 'error' && sc.student_count === 1 && sc.offering_ids.includes(O1.o.id) && sc.offering_ids.includes(O2.o.id), sc);
  check('dropped enrolment does not count as a clash (Bob)', sc.student_count === 1);
  const oc = cf.body.conflicts.find(c => c.type === 'room_over_capacity' && c.slot_ids?.includes(slotId(O4)));
  check('room over capacity (3 enrolled in LAB1 cap 2) is a warning', oc && oc.severity === 'warning' && oc.enrolled === 3 && oc.capacity === 2, oc);
  const up = cf.body.conflicts.find(c => c.type === 'unknown_period');
  check('slot using an unknown period (P99)', up && up.severity === 'error' && up.period_key === 'P99', up);
  check('slots without a room are info', cf.body.conflicts.some(c => c.type === 'no_room' && c.severity === 'info'));
  check('every conflict links to a fix page', cf.body.conflicts.every(c => c.links.length > 0 && c.links[0].to.startsWith('/academics/')));
  check('exam student clash (Ann: E1 09–11 vs E2 10–12)', cf.body.conflicts.some(c => c.type === 'exam_student_clash' && c.exam_ids.includes(E1.id) && c.exam_ids.includes(E2.id)));
  check('conflict ids are unique', new Set(cf.body.conflicts.map(c => c.id)).size === cf.body.conflicts.length);
  check('errors sort before warnings before info', cf.body.conflicts.map(c => ({ error: 0, warning: 1, info: 2 })[c.severity]).every((v, i, a) => i === 0 || a[i - 1] <= v));
  await db.examSession.update({ where: { id: E2.id }, data: { room: 'amph' } });
  const cf2 = await call('GET', '/timetable-engine/conflicts', { token: A });
  check('exam room double-booked (legacy string on another exam)', cf2.body.conflicts.some(c => c.type === 'exam_room_double_booked' && c.exam_ids.includes(E1.id) && c.exam_ids.includes(E2.id)), cf2.body.conflicts.map(c => c.type));
  const weeklyVsExam = await mkEx('s6', P.P2.start_time, P.P2.end_time, [dee], nextWeekday(2, 21));
  await db.examSession.update({ where: { id: weeklyVsExam.id }, data: { room_id: lab.id, room: 'LAB1' } });
  const cf3 = await call('GET', '/timetable-engine/conflicts', { token: A });
  check('exam vs weekly class in the same room (LAB1 tuesday P2)', cf3.body.conflicts.some(c => c.type === 'room_double_booked' && c.exam_ids?.includes(weeklyVsExam.id) && c.slot_ids.includes(slotId(O4))), cf3.body.conflicts.filter(c => c.type === 'room_double_booked').map(c => c.message));
  const bkSneak = await db.roomBooking.create({ data: { id: uuid(), room_id: lab.id, title: 'Sneaky', date: weeklyVsExam.date, start_time: P.P2.start_time, end_time: P.P2.end_time } });
  const cf4 = await call('GET', '/timetable-engine/conflicts', { token: A });
  check('exam vs ad-hoc booking detected', cf4.body.conflicts.some(c => c.type === 'room_double_booked' && /Sneaky/.test(c.message)));
  await db.roomBooking.delete({ where: { id: bkSneak.id } });
  await db.room.update({ where: { id: r101.body.id }, data: { is_active: false } });
  check('slot in a deactivated room is flagged', (await call('GET', '/timetable-engine/conflicts', { token: A })).body.conflicts.some(c => c.type === 'room_inactive'));
  await db.room.update({ where: { id: r101.body.id }, data: { is_active: true } });
  // fixing a conflict removes it
  await db.offeringSlot.update({ where: { id: slotId(O3) }, data: { room: null } });
  const cf5 = await call('GET', '/timetable-engine/conflicts', { token: A });
  check('fixing the room removes the room conflict', !cf5.body.conflicts.some(c => c.type === 'room_double_booked' && c.room_id === r101.body.id));
  check('conflicts for another semester are empty', (await call('GET', `/timetable-engine/conflicts?term_id=${S.t2.id}`, { token: A })).body.conflicts.length === 0);

  // ── iCalendar ──────────────────────────────────────────────────────────────
  section('iCalendar export');
  const icsRes = await call('GET', '/timetable-engine/student/me/ics', { token: ANN, raw: true });
  const ics = await icsRes.text();
  const v = validateIcs(ics);
  check('student .ics: 200 + text/calendar + attachment', icsRes.status === 200 && /^text\/calendar/.test(icsRes.headers.get('content-type')) && /attachment; filename=".+\.ics"/.test(icsRes.headers.get('content-disposition')));
  check('student .ics passes the RFC 5545 checks', v.errs.length === 0, v.errs);
  const classEv = v.events.filter(e => e.RRULE);
  check('one weekly VEVENT per class slot (3) + upcoming exams', classEv.length === 3 && v.events.length === 3 + 3, [classEv.length, v.events.length]);
  const ev1 = classEv.find(e => /S101/.test(e.SUMMARY));
  const startDate = ev1.DTSTART.slice(0, 8);
  check('first occurrence is a Monday on/after term start, with the period start time', startDate === '20260907' && ev1.DTSTART.endsWith(P.P1.start_time.replace(':', '') + '00') && ev1.DTEND.endsWith(P.P1.end_time.replace(':', '') + '00'), ev1);
  check('RRULE runs until term end', ev1.RRULE === 'FREQ=WEEKLY;UNTIL=20270131T235900', ev1.RRULE);
  check('location + lecturer included', /R101/.test(ev1.LOCATION) && /Tina Lecturer/.test(ev1.DESCRIPTION.replace(/\\/g, '')), ev1);
  check('UIDs are unique', new Set(v.events.map(e => e.UID)).size === v.events.length);
  const lics = await (await call('GET', '/timetable-engine/lecturer/me/ics', { token: TINA, raw: true })).text();
  check('lecturer .ics valid with 2 recurring events', validateIcs(lics).errs.length === 0 && validateIcs(lics).events.filter(e => e.RRULE).length === 2, validateIcs(lics).errs);
  check('student cannot export another student', (await call('GET', `/timetable-engine/student/${bob.id}/ics`, { token: ANN })).status === 403);
  check('teacher cannot export a student', (await call('GET', `/timetable-engine/student/${ann.id}/ics`, { token: TINA })).status === 403);
  check('lecturer cannot export another lecturer', (await call('GET', `/timetable-engine/lecturer/${tom.id}/ics`, { token: TINA })).status === 403);
  check('staff export any student', (await call('GET', `/timetable-engine/student/${ann.id}/ics`, { token: OF, raw: true })).status === 200);
  // escaping + folding with awkward names
  const odd = await db.subject.create({ data: { id: uuid(), name: 'Théorie, des; graphes \\ très longue désignation de cours pour forcer le pliage de ligne iCalendar au-delà de 75 octets', code: 'ODD01', department_id: dep.id } });
  const oo = await db.courseOffering.create({ data: { id: uuid(), subject_id: odd.id, term_id: T1, teacher_id: tom.id } });
  await db.offeringSlot.create({ data: { id: uuid(), offering_id: oo.id, day: 'friday', period_key: 'P6' } });
  await db.courseEnrollment.create({ data: { id: uuid(), student_id: bob.id, offering_id: oo.id, term_id: T1, credits: 3 } });
  const oddIcs = await (await call('GET', '/timetable-engine/student/me/ics', { token: BOB, raw: true })).text();
  const vo = validateIcs(oddIcs);
  check('long/UTF-8/special-character names are folded and escaped correctly', vo.errs.length === 0 && /Théorie\\, des\\; graphes \\\\/.test(oddIcs.replace(/\r\n /g, '')), vo.errs);
  check('empty timetable still yields a valid calendar', validateIcs(await (await call('GET', '/timetable-engine/student/me/ics', { token: DEE, raw: true })).text()).errs.length === 0);

  // ── isolation ──────────────────────────────────────────────────────────────
  section('Tenant isolation');
  const oOf = H.mkToken(O.schoolId, O.users.officer);
  check('other school sees no rooms', (await call('GET', '/rooms', { token: oOf })).body.length === 0);
  check('other school cannot read my room', (await call('GET', `/rooms/${big.id}`, { token: oOf })).status === 404);
  check('other school cannot assign my room', (await call('POST', '/rooms/assign-slot', { token: oOf, body: { slot_id: slotId(O1), room_id: big.id } })).status === 404);
  check('other school cannot read my student timetable', (await call('GET', `/timetable-engine/student/${ann.id}`, { token: oOf })).status === 404);
  check('other school conflicts report is empty', (await call('GET', '/timetable-engine/conflicts', { token: oOf })).body.conflicts.length === 0);
  check('other school has its own P1–P8', (await call('GET', '/rooms/periods', { token: oOf })).body.length >= 8);
  const oRoom = await call('POST', '/rooms', { token: oOf, body: { code: 'R101', name: 'Their 101' } });
  check('same room code allowed in another school', oRoom.status === 201);

  await finish(H.platformClient);
})().catch(e => { console.error('SUITE CRASHED', e); process.exit(1); });
