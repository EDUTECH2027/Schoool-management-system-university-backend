// Academic administration: structure (faculty → department → programme), curriculum, course offerings,
// registration periods, registration approvals. Writes: administrators + academic officers.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const reg = require('../academics/registration');
const { buildProfile } = require('../academics/profile');

const manage = [authenticate, authorize('super_admin', 'academic_officer')];
const actorOf = u => ({ id: u.id, name: u.name, role: u.role === 'head_teacher' ? 'super_admin' : u.role });
const audit = (req, action, type, id, extra) => reg.audit(req.db, actorOf(req.user), action, type, id, extra);
const unique = (res, what) => res.status(409).json({ error: `${what} already exists` });
const str = v => (typeof v === 'string' ? v.trim() : v);
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// ── Faculties ───────────────────────────────────────────────────────────────────
router.get('/faculties', authenticate, async (req, res) => {
  const rows = await req.db.faculty.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { departments: true } } } });
  res.json(rows.map(({ _count, ...f }) => ({ ...f, department_count: _count.departments })));
});
router.post('/faculties', ...manage, async (req, res) => {
  const name = str(req.body.name), code = str(req.body.code);
  if (!name || !code) return res.status(422).json({ error: 'name and code are required' });
  try {
    const row = await req.db.faculty.create({ data: { id: uuid(), name, code: code.toUpperCase(), description: req.body.description || null } });
    await audit(req, 'faculty.create', 'faculty', row.id, { after: { name, code } });
    res.status(201).json(row);
  } catch (e) { if (e.code === 'P2002') return unique(res, 'A faculty with this name or code'); throw e; }
});
router.put('/faculties/:id', ...manage, async (req, res) => {
  const f = await req.db.faculty.findUnique({ where: { id: req.params.id } });
  if (!f) return res.status(404).json({ error: 'Faculty not found' });
  try {
    const row = await req.db.faculty.update({ where: { id: f.id }, data: { name: str(req.body.name) ?? f.name, code: req.body.code ? str(req.body.code).toUpperCase() : f.code, description: req.body.description ?? f.description } });
    await audit(req, 'faculty.update', 'faculty', f.id, { before: { name: f.name, code: f.code }, after: { name: row.name, code: row.code } });
    res.json(row);
  } catch (e) { if (e.code === 'P2002') return unique(res, 'A faculty with this name or code'); throw e; }
});
router.delete('/faculties/:id', ...manage, async (req, res) => {
  const n = await req.db.department.count({ where: { faculty_id: req.params.id } });
  if (n) return res.status(409).json({ error: `This faculty still has ${n} department(s). Move or delete them first.` });
  await req.db.faculty.deleteMany({ where: { id: req.params.id } });
  await audit(req, 'faculty.delete', 'faculty', req.params.id);
  res.status(204).end();
});

// ── Departments ─────────────────────────────────────────────────────────────────
router.get('/departments', authenticate, async (req, res) => {
  const where = req.query.facultyId ? { faculty_id: String(req.query.facultyId) } : {};
  const rows = await req.db.department.findMany({ where, orderBy: [{ faculty: { name: 'asc' } }, { name: 'asc' }], include: { faculty: { select: { name: true, code: true } }, _count: { select: { programmes: true, subjects: true } } } });
  res.json(rows.map(({ _count, faculty, ...d }) => ({ ...d, faculty_name: faculty.name, faculty_code: faculty.code, programme_count: _count.programmes, course_count: _count.subjects })));
});
router.post('/departments', ...manage, async (req, res) => {
  const name = str(req.body.name), code = str(req.body.code), facultyId = req.body.faculty_id;
  if (!name || !code || !facultyId) return res.status(422).json({ error: 'faculty_id, name and code are required' });
  if (!(await req.db.faculty.findUnique({ where: { id: facultyId } }))) return res.status(422).json({ error: 'Unknown faculty' });
  try {
    const row = await req.db.department.create({ data: { id: uuid(), faculty_id: facultyId, name, code: code.toUpperCase(), head_name: req.body.head_name || null } });
    await audit(req, 'department.create', 'department', row.id, { after: { name, code, faculty_id: facultyId } });
    res.status(201).json(row);
  } catch (e) { if (e.code === 'P2002') return unique(res, 'A department with this name or code in that faculty'); throw e; }
});
router.put('/departments/:id', ...manage, async (req, res) => {
  const d = await req.db.department.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Department not found' });
  if (req.body.faculty_id && !(await req.db.faculty.findUnique({ where: { id: req.body.faculty_id } }))) return res.status(422).json({ error: 'Unknown faculty' });
  try {
    const row = await req.db.department.update({ where: { id: d.id }, data: { name: str(req.body.name) ?? d.name, code: req.body.code ? str(req.body.code).toUpperCase() : d.code, faculty_id: req.body.faculty_id ?? d.faculty_id, head_name: req.body.head_name ?? d.head_name } });
    await audit(req, 'department.update', 'department', d.id, { before: { name: d.name, faculty_id: d.faculty_id }, after: { name: row.name, faculty_id: row.faculty_id } });
    res.json(row);
  } catch (e) { if (e.code === 'P2002') return unique(res, 'A department with this name or code in that faculty'); throw e; }
});
router.delete('/departments/:id', ...manage, async (req, res) => {
  const [p, c] = await Promise.all([req.db.programme.count({ where: { department_id: req.params.id } }), req.db.subject.count({ where: { department_id: req.params.id } })]);
  if (p || c) return res.status(409).json({ error: `This department still has ${p} programme(s) and ${c} course(s). Reassign them first.` });
  await req.db.department.deleteMany({ where: { id: req.params.id } });
  await audit(req, 'department.delete', 'department', req.params.id);
  res.status(204).end();
});

// ── Programmes ──────────────────────────────────────────────────────────────────
router.get('/programmes', authenticate, async (req, res) => {
  const where = {};
  if (req.query.departmentId) where.department_id = String(req.query.departmentId);
  if (req.query.facultyId) where.department = { faculty_id: String(req.query.facultyId) };
  const rows = await req.db.programme.findMany({ where, orderBy: { name: 'asc' }, include: { department: { include: { faculty: true } }, _count: { select: { classes: true, curriculum: true } } } });
  res.json(rows.map(({ _count, department, ...p }) => ({ ...p, department_name: department.name, faculty_id: department.faculty_id, faculty_name: department.faculty.name, class_count: _count.classes, course_count: _count.curriculum })));
});
const programmeData = b => ({
  ...(b.name !== undefined && { name: str(b.name) }), ...(b.code !== undefined && { code: str(b.code).toUpperCase() }),
  ...(b.department_id !== undefined && { department_id: b.department_id }), ...(b.award !== undefined && { award: b.award || null }),
  ...(b.duration_years !== undefined && { duration_years: Math.max(1, Math.min(10, parseInt(b.duration_years, 10) || 3)) }),
  ...(b.credits_required !== undefined && { credits_required: b.credits_required === '' || b.credits_required === null ? null : Math.max(0, Number(b.credits_required) || 0) }),
  ...(b.is_active !== undefined && { is_active: !!b.is_active }),
});
router.post('/programmes', ...manage, async (req, res) => {
  const b = req.body;
  if (!str(b.name) || !str(b.code) || !b.department_id) return res.status(422).json({ error: 'department_id, name and code are required' });
  if (!(await req.db.department.findUnique({ where: { id: b.department_id } }))) return res.status(422).json({ error: 'Unknown department' });
  try {
    const row = await req.db.programme.create({ data: { id: uuid(), ...programmeData(b) } });
    await audit(req, 'programme.create', 'programme', row.id, { after: { name: row.name, code: row.code } });
    res.status(201).json(row);
  } catch (e) { if (e.code === 'P2002') return unique(res, 'A programme with this code'); throw e; }
});
router.put('/programmes/:id', ...manage, async (req, res) => {
  const p = await req.db.programme.findUnique({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: 'Programme not found' });
  if (req.body.department_id && !(await req.db.department.findUnique({ where: { id: req.body.department_id } }))) return res.status(422).json({ error: 'Unknown department' });
  try {
    const row = await req.db.programme.update({ where: { id: p.id }, data: programmeData(req.body) });
    await audit(req, 'programme.update', 'programme', p.id, { before: { name: p.name, department_id: p.department_id }, after: { name: row.name, department_id: row.department_id } });
    res.json(row);
  } catch (e) { if (e.code === 'P2002') return unique(res, 'A programme with this code'); throw e; }
});
router.delete('/programmes/:id', ...manage, async (req, res) => {
  const n = await req.db.class.count({ where: { programme_id: req.params.id } });
  if (n) return res.status(409).json({ error: `This programme still has ${n} cohort(s) (classes). Move them to another programme first.` });
  await req.db.programme.deleteMany({ where: { id: req.params.id } });
  await audit(req, 'programme.delete', 'programme', req.params.id);
  res.status(204).end();
});

// Attach a class (cohort) to a programme
router.put('/classes/:id/programme', ...manage, async (req, res) => {
  const c = await req.db.class.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: 'Class not found' });
  if (req.body.programme_id && !(await req.db.programme.findUnique({ where: { id: req.body.programme_id } }))) return res.status(422).json({ error: 'Unknown programme' });
  const row = await req.db.class.update({ where: { id: c.id }, data: { programme_id: req.body.programme_id || null } });
  await audit(req, 'class.set_programme', 'class', c.id, { before: { programme_id: c.programme_id }, after: { programme_id: row.programme_id } });
  res.json(row);
});

// Cohorts with their programme (for pickers)
router.get('/classes', authenticate, async (req, res) => {
  const rows = await req.db.class.findMany({ orderBy: { name: 'asc' }, include: { programme: { select: { id: true, name: true, code: true, department: { select: { name: true, faculty: { select: { name: true } } } } } }, grade_level: { select: { id: true, name: true } } } });
  res.json(rows.map(c => ({ id: c.id, name: c.name, programme_id: c.programme_id, programme: c.programme?.name ?? null, department: c.programme?.department?.name ?? null, faculty: c.programme?.department?.faculty?.name ?? null, level_id: c.grade_level?.id ?? null, level: c.grade_level?.name ?? null, enrolled: c.enrolled })));
});

// ── Programme curriculum ──────────────────────────────────────────────────────
router.get('/programmes/:id/curriculum', authenticate, async (req, res) => {
  const rows = await req.db.programmeCourse.findMany({ where: { programme_id: req.params.id }, include: { subject: { select: { id: true, name: true, code: true, credit_hours: true } } } });
  res.json(rows.map(r => ({ id: r.id, subject_id: r.subject_id, course: r.subject.name, code: r.subject.code, credits: r.subject.credit_hours, level_id: r.level_id, semester: r.semester, kind: r.kind })));
});
router.put('/programmes/:id/curriculum', ...manage, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items) return res.status(422).json({ error: 'items[] required' });
  if (!(await req.db.programme.findUnique({ where: { id: req.params.id } }))) return res.status(404).json({ error: 'Programme not found' });
  const seen = new Set();
  for (const it of items) {
    if (!it.subject_id || !['first', 'second', 'third'].includes(it.semester)) return res.status(422).json({ error: 'Each item needs subject_id and a valid semester' });
    if (it.kind && !['core', 'elective'].includes(it.kind)) return res.status(422).json({ error: 'kind must be core or elective' });
    if (seen.has(it.subject_id)) return res.status(422).json({ error: 'A course can appear only once in a curriculum' });
    seen.add(it.subject_id);
  }
  if ((await req.db.subject.count({ where: { id: { in: [...seen] } } })) !== seen.size) return res.status(422).json({ error: 'Unknown course in curriculum' });
  await req.db.$transaction([
    req.db.programmeCourse.deleteMany({ where: { programme_id: req.params.id } }),
    req.db.programmeCourse.createMany({ data: items.map(it => ({ id: uuid(), programme_id: req.params.id, subject_id: it.subject_id, level_id: it.level_id || null, semester: it.semester, kind: it.kind || 'core' })) }),
  ]);
  await audit(req, 'curriculum.replace', 'programme', req.params.id, { after: { courses: items.length } });
  res.json({ saved: items.length });
});

// ── Course offerings ──────────────────────────────────────────────────────────
const OFFERING_INCLUDE = { subject: { select: { id: true, name: true, code: true, credit_hours: true, department_id: true, level_id: true } }, teacher: { select: { id: true, first_name: true, last_name: true } }, slots: true, _count: { select: { enrollments: { where: { status: { in: reg.ACTIVE } } } } } };
const offeringDto = ({ _count, teacher, subject, ...o }) => ({ ...o, course: subject.name, code: subject.code, credits: subject.credit_hours, department_id: subject.department_id, level_id: subject.level_id, lecturer: teacher ? `${teacher.first_name} ${teacher.last_name}` : null, enrolled: _count.enrollments });

router.get('/offerings', authenticate, authorize('super_admin', 'academic_officer', 'teacher', 'finance_officer'), async (req, res) => {
  const { termId, departmentId, teacherId, q } = req.query;
  const where = {};
  if (termId) where.term_id = String(termId);
  if (teacherId) where.teacher_id = String(teacherId);
  if (departmentId) where.subject = { department_id: String(departmentId) };
  if (q) where.subject = { ...(where.subject ?? {}), OR: [{ name: { contains: String(q), mode: 'insensitive' } }, { code: { contains: String(q), mode: 'insensitive' } }] };
  const rows = await req.db.courseOffering.findMany({ where, include: OFFERING_INCLUDE, orderBy: [{ subject: { name: 'asc' } }, { section: 'asc' }], take: 500 });
  res.json(rows.map(offeringDto));
});

function validSlots(slots) {
  if (slots === undefined) return null;
  if (!Array.isArray(slots)) return 'slots must be an array';
  const seen = new Set();
  for (const s of slots) {
    if (!DAYS.includes(s.day) || !str(s.period_key)) return `Each slot needs a day (${DAYS.join('/')}) and a period`;
    const k = `${s.day}|${s.period_key}`; if (seen.has(k)) return 'Duplicate slot'; seen.add(k);
  }
  return null;
}
// Teacher cannot be in two offerings at once (same term, same slot).
async function teacherClashes(db, { teacherId, termId, slots, excludeId }) {
  if (!teacherId || !slots?.length) return [];
  const others = await db.courseOffering.findMany({ where: { teacher_id: teacherId, term_id: termId, ...(excludeId && { id: { not: excludeId } }) }, include: { slots: true, subject: { select: { name: true } } } });
  const mine = new Set(slots.map(s => `${s.day}|${s.period_key}`));
  return others.flatMap(o => o.slots.filter(s => mine.has(`${s.day}|${s.period_key}`)).map(s => ({ course: o.subject.name, day: s.day, period: s.period_key })));
}

router.post('/offerings', ...manage, async (req, res) => {
  const b = req.body;
  if (!b.subject_id || !b.term_id) return res.status(422).json({ error: 'subject_id and term_id are required' });
  const bad = validSlots(b.slots); if (bad) return res.status(422).json({ error: bad });
  const [subject, term, teacher] = await Promise.all([req.db.subject.findUnique({ where: { id: b.subject_id } }), req.db.term.findUnique({ where: { id: b.term_id } }), b.teacher_id ? req.db.teacher.findUnique({ where: { id: b.teacher_id } }) : null]);
  if (!subject) return res.status(422).json({ error: 'Unknown course' });
  if (!term) return res.status(422).json({ error: 'Unknown semester' });
  if (b.teacher_id && !teacher) return res.status(422).json({ error: 'Unknown lecturer' });
  const clashes = await teacherClashes(req.db, { teacherId: b.teacher_id, termId: b.term_id, slots: b.slots });
  if (clashes.length && !b.override) return res.status(409).json({ error: `The lecturer already teaches at that time: ${clashes.map(c => `${c.course} (${c.day} ${c.period})`).join(', ')}.`, code: 'teacher_conflict', conflicts: clashes });
  const id = uuid();
  try {
    await req.db.courseOffering.create({
      data: { id, subject_id: b.subject_id, term_id: b.term_id, teacher_id: b.teacher_id || null, section: str(b.section) || 'A', capacity: b.capacity === undefined || b.capacity === null || b.capacity === '' ? null : Math.max(1, parseInt(b.capacity, 10) || 1), is_open: b.is_open !== false,
        slots: b.slots?.length ? { create: b.slots.map(s => ({ id: uuid(), day: s.day, period_key: s.period_key, room: s.room || null })) } : undefined },
    });
  } catch (e) { if (e.code === 'P2002') return unique(res, 'This course already has an offering with that section in this semester'); throw e; }
  await audit(req, clashes.length ? 'offering.create_override' : 'offering.create', 'course_offering', id, { reason: clashes.length ? b.override_reason || 'Teacher clash overridden' : undefined, after: { course: subject.code, term: b.term_id } });
  res.status(201).json(offeringDto(await req.db.courseOffering.findUnique({ where: { id }, include: OFFERING_INCLUDE })));
});

router.put('/offerings/:id', ...manage, async (req, res) => {
  const o = await req.db.courseOffering.findUnique({ where: { id: req.params.id }, include: { slots: true } });
  if (!o) return res.status(404).json({ error: 'Offering not found' });
  const b = req.body;
  const bad = validSlots(b.slots); if (bad) return res.status(422).json({ error: bad });
  if (b.teacher_id && !(await req.db.teacher.findUnique({ where: { id: b.teacher_id } }))) return res.status(422).json({ error: 'Unknown lecturer' });
  const slots = b.slots ?? o.slots, teacherId = b.teacher_id === undefined ? o.teacher_id : b.teacher_id;
  const clashes = await teacherClashes(req.db, { teacherId, termId: o.term_id, slots, excludeId: o.id });
  if (clashes.length && !b.override) return res.status(409).json({ error: `The lecturer already teaches at that time: ${clashes.map(c => `${c.course} (${c.day} ${c.period})`).join(', ')}.`, code: 'teacher_conflict', conflicts: clashes });
  if (b.capacity !== undefined && b.capacity !== null && b.capacity !== '') {
    const taken = await req.db.courseEnrollment.count({ where: { offering_id: o.id, status: { in: reg.ACTIVE } } });
    if (Number(b.capacity) < taken) return res.status(422).json({ error: `${taken} students are already registered; capacity cannot be below that.` });
  }
  await req.db.$transaction([
    req.db.courseOffering.update({ where: { id: o.id }, data: {
      ...(b.teacher_id !== undefined && { teacher_id: b.teacher_id || null }), ...(b.section !== undefined && { section: str(b.section) || 'A' }),
      ...(b.capacity !== undefined && { capacity: b.capacity === null || b.capacity === '' ? null : Math.max(1, parseInt(b.capacity, 10) || 1) }), ...(b.is_open !== undefined && { is_open: !!b.is_open }),
    } }),
    ...(b.slots ? [req.db.offeringSlot.deleteMany({ where: { offering_id: o.id } }), req.db.offeringSlot.createMany({ data: b.slots.map(s => ({ id: uuid(), offering_id: o.id, day: s.day, period_key: s.period_key, room: s.room || null })) })] : []),
  ]);
  await audit(req, 'offering.update', 'course_offering', o.id, { reason: clashes.length ? b.override_reason || 'Teacher clash overridden' : undefined });
  res.json(offeringDto(await req.db.courseOffering.findUnique({ where: { id: o.id }, include: OFFERING_INCLUDE })));
});

router.delete('/offerings/:id', ...manage, async (req, res) => {
  const n = await req.db.courseEnrollment.count({ where: { offering_id: req.params.id, status: { in: reg.ACTIVE } } });
  if (n) return res.status(409).json({ error: `${n} student(s) are registered. Close the offering (set it not open) instead of deleting it.` });
  await req.db.courseOffering.deleteMany({ where: { id: req.params.id } });
  await audit(req, 'offering.delete', 'course_offering', req.params.id);
  res.status(204).end();
});

// Roster = registered students; visible to administrators/academic officers and to the offering's own lecturer.
router.get('/offerings/:id/roster', authenticate, authorize('super_admin', 'academic_officer', 'teacher'), async (req, res) => {
  const o = await req.db.courseOffering.findUnique({ where: { id: req.params.id }, include: { subject: true, term: { include: { academic_year: true } }, teacher: true } });
  if (!o) return res.status(404).json({ error: 'Offering not found' });
  if (req.user.role === 'teacher' && o.teacher_id !== req.user.teacher_id) return res.status(403).json({ error: 'This is not your course' });
  const rows = await req.db.courseEnrollment.findMany({ where: { offering_id: o.id, status: 'registered' }, include: { student: { include: { class: { include: { programme: true } } } } }, orderBy: [{ student: { last_name: 'asc' } }, { student: { first_name: 'asc' } }] });
  res.json({
    offering: { id: o.id, course: o.subject.name, code: o.subject.code, section: o.section, term: o.term.name, academic_year: o.term.academic_year.label, lecturer: o.teacher ? `${o.teacher.first_name} ${o.teacher.last_name}` : null, capacity: o.capacity },
    students: rows.map(e => ({ student_id: e.student_id, name: `${e.student.first_name} ${e.student.last_name}`, matricule: e.student.student_number, programme: e.student.class?.programme?.name ?? null, class_name: e.student.class?.name ?? null, kind: e.kind })),
  });
});

// ── Registration periods ──────────────────────────────────────────────────────
const periodData = b => ({
  ...(b.term_id !== undefined && { term_id: b.term_id }), ...(b.programme_id !== undefined && { programme_id: b.programme_id || null }), ...(b.level_id !== undefined && { level_id: b.level_id || null }),
  ...(b.name !== undefined && { name: b.name || null }), ...(b.opens_at !== undefined && { opens_at: new Date(b.opens_at) }), ...(b.closes_at !== undefined && { closes_at: new Date(b.closes_at) }),
  ...(b.add_drop_until !== undefined && { add_drop_until: b.add_drop_until ? new Date(b.add_drop_until) : null }),
  ...(b.min_credits !== undefined && { min_credits: Math.max(0, Number(b.min_credits) || 0) }), ...(b.max_credits !== undefined && { max_credits: Math.max(0, Number(b.max_credits) || 0) }),
  ...(b.allow_exceptions !== undefined && { allow_exceptions: !!b.allow_exceptions }),
});
function validPeriod(d) {
  if (d.opens_at && isNaN(d.opens_at)) return 'Invalid opening date';
  if (d.closes_at && isNaN(d.closes_at)) return 'Invalid closing date';
  if (d.opens_at && d.closes_at && d.closes_at <= d.opens_at) return 'The period must close after it opens';
  if (d.min_credits !== undefined && d.max_credits !== undefined && d.min_credits > d.max_credits) return 'Minimum credits cannot exceed maximum credits';
  return null;
}
router.get('/registration-periods', authenticate, authorize('super_admin', 'academic_officer', 'teacher'), async (req, res) => {
  const where = req.query.termId ? { term_id: String(req.query.termId) } : {};
  const now = new Date();
  const rows = await req.db.registrationPeriod.findMany({ where, orderBy: { opens_at: 'desc' }, include: { term: { include: { academic_year: true } }, programme: { select: { name: true } } } });
  res.json(rows.map(({ term, programme, ...p }) => ({ ...p, term_name: term.name, academic_year: term.academic_year.label, programme_name: programme?.name ?? null, is_open: p.opens_at <= now && now <= p.closes_at })));
});
router.post('/registration-periods', ...manage, async (req, res) => {
  const b = req.body;
  if (!b.term_id || !b.opens_at || !b.closes_at) return res.status(422).json({ error: 'term_id, opens_at and closes_at are required' });
  const d = periodData(b); const bad = validPeriod(d); if (bad) return res.status(422).json({ error: bad });
  if (!(await req.db.term.findUnique({ where: { id: b.term_id } }))) return res.status(422).json({ error: 'Unknown semester' });
  if (b.programme_id && !(await req.db.programme.findUnique({ where: { id: b.programme_id } }))) return res.status(422).json({ error: 'Unknown programme' });
  const row = await req.db.registrationPeriod.create({ data: { id: uuid(), ...d, created_by: req.user.id } });
  await audit(req, 'registration_period.create', 'registration_period', row.id, { after: { term_id: row.term_id, opens_at: row.opens_at, closes_at: row.closes_at } });
  res.status(201).json(row);
});
router.put('/registration-periods/:id', ...manage, async (req, res) => {
  const p = await req.db.registrationPeriod.findUnique({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: 'Period not found' });
  const d = periodData(req.body); const merged = { ...p, ...d }; const bad = validPeriod(merged); if (bad) return res.status(422).json({ error: bad });
  const row = await req.db.registrationPeriod.update({ where: { id: p.id }, data: d });
  await audit(req, 'registration_period.update', 'registration_period', p.id, { before: { opens_at: p.opens_at, closes_at: p.closes_at }, after: { opens_at: row.opens_at, closes_at: row.closes_at } });
  res.json(row);
});
router.delete('/registration-periods/:id', ...manage, async (req, res) => {
  await req.db.registrationPeriod.deleteMany({ where: { id: req.params.id } });
  await audit(req, 'registration_period.delete', 'registration_period', req.params.id);
  res.status(204).end();
});

// ── Registration approvals & administrator actions ────────────────────────────────
router.get('/registrations', ...manage, async (req, res) => {
  const { status, termId, q } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200), page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const where = {};
  if (status) where.status = String(status);
  if (termId) where.term_id = String(termId);
  if (q) where.student = { OR: [{ first_name: { contains: String(q), mode: 'insensitive' } }, { last_name: { contains: String(q), mode: 'insensitive' } }, { student_number: { contains: String(q), mode: 'insensitive' } }] };
  const [rows, total] = await Promise.all([
    req.db.courseEnrollment.findMany({ where, orderBy: { registered_at: 'desc' }, take: limit, skip: (page - 1) * limit, include: { student: { include: { class: { include: { programme: true } } } }, offering: { include: { subject: true } } } }),
    req.db.courseEnrollment.count({ where }),
  ]);
  res.json({ total, page, limit, items: rows.map(e => ({ id: e.id, status: e.status, kind: e.kind, credits: e.credits, exception_reason: e.exception_reason, decision_note: e.decision_note, registered_at: e.registered_at, student_id: e.student_id, student: `${e.student.first_name} ${e.student.last_name}`, matricule: e.student.student_number, programme: e.student.class?.programme?.name ?? null, course: e.offering.subject.name, code: e.offering.subject.code, section: e.offering.section, term_id: e.term_id })) });
});
router.post('/registrations/:id/decision', ...manage, async (req, res) => {
  try { res.json(await reg.decide(req.db, req.params.id, { decision: req.body.decision === 'approve' ? 'approve' : req.body.decision === 'reject' ? 'reject' : null, note: req.body.note, actor: actorOf(req.user) })); }
  catch (e) { if (e instanceof reg.RegistrationError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
});
// Register a student on their behalf (administrator override of eligibility rules; always audited, reason required)
router.post('/registrations', ...manage, async (req, res) => {
  const { student_id, offering_id, reason, override } = req.body;
  if (!student_id || !offering_id) return res.status(422).json({ error: 'student_id and offering_id are required' });
  if (override && !(reason && reason.trim())) return res.status(422).json({ error: 'A reason is required to override the registration rules.' });
  const student = await reg.loadStudent(req.db, student_id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  try {
    const r = await reg.enroll(req.db, student, offering_id, { actor: actorOf(req.user), exceptionReason: reason, override: !!override });
    res.status(201).json({ enrollment: r.enrollment, checks: { blockers: r.verdict.blockers, approvals: r.verdict.approvals } });
  } catch (e) { if (e instanceof reg.RegistrationError) return res.status(e.status).json({ error: e.message, code: e.code, details: e.details }); throw e; }
});
router.post('/registrations/:id/drop', ...manage, async (req, res) => {
  if (!(req.body.reason && req.body.reason.trim())) return res.status(422).json({ error: 'A reason is required.' });
  const e = await req.db.courseEnrollment.findUnique({ where: { id: req.params.id } });
  if (!e) return res.status(404).json({ error: 'Registration not found' });
  const student = await reg.loadStudent(req.db, e.student_id);
  try { res.json(await reg.drop(req.db, student, e.id, { actor: actorOf(req.user), override: true, reason: req.body.reason })); }
  catch (er) { if (er instanceof reg.RegistrationError) return res.status(er.status).json({ error: er.message }); throw er; }
});

// ── Student academic profile (administrators/academic officers; finance block only for administrators) ─
router.get('/students/:id/profile', authenticate, authorize('super_admin', 'academic_officer'), async (req, res) => {
  const p = await buildProfile(req.db, req.params.id, { includeFinance: req.user.role === 'super_admin' || req.user.role === 'head_teacher' });
  if (!p) return res.status(404).json({ error: 'Student not found' });
  res.json(p);
});

router.get('/audit', ...manage, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200), page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const where = {};
  if (req.query.action) where.action = { startsWith: String(req.query.action) };
  if (req.query.target_id) where.target_id = String(req.query.target_id);
  const [items, total] = await Promise.all([req.db.academicAudit.findMany({ where, orderBy: { created_at: 'desc' }, take: limit, skip: (page - 1) * limit }), req.db.academicAudit.count({ where })]);
  res.json({ total, page, limit, items });
});

module.exports = router;
