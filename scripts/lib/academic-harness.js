// Shared harness for the academic test suites: a throwaway school in the scratch DB, signed tokens, fetch helper.
// Refuses to run against a non-local database.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to run: DATABASE_URL must be a local scratch database.'); process.exit(2); }
const platformClient = require('../../src/db/platformClient');
const tenantPool = require('../../src/db/tenantPool');
const { provisionTenantSchema } = require('../../src/db/provisionTenant');

const BASE = process.env.API_URL || 'http://127.0.0.1:3099';
const SECRET = process.env.JWT_SECRET || 'dev_secret';
const HOUR = 3_600_000, DAY = 86_400_000;
let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`  [OK]   ${label}`); } else { fail++; console.error(`  [FAIL] ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`); } };
const section = t => console.log(`\n── ${t}`);

async function call(method, url, { token, body, raw, headers: extra, rawBody } = {}) {
  const headers = { ...(token && { Authorization: `Bearer ${token}` }), ...extra };
  let payload;
  if (rawBody !== undefined) payload = rawBody; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}/api${url}`, { method, headers, body: payload });
  if (raw) return res;
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const mkToken = (schoolId, u) => jwt.sign({ id: u.id, email: u.email, role: u.role, name: u.name, initials: 'XX', teacher_id: u.teacher_id || null, student_id: u.student_id || null, parent_id: null, school_id: schoolId, scope: 'tenant', must_change_password: false }, SECRET, { expiresIn: '1h' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A school with levels, a current academic year (2 semesters), teachers, students, cohorts and users — structure objects are created through the API by the tests. */
async function seedSchool(label) {
  const schoolId = uuid();
  await platformClient.school.create({ data: { id: schoolId, name: `Univ ${label}`, email: `${schoolId}@t.local`, admin_name: 'A', admin_email: `a-${schoolId}@t.local`, status: 'active' } });
  await provisionTenantSchema(schoolId);
  const db = tenantPool.getOrOpen(schoolId);
  await db.school.create({ data: { id: 's1', name: `Univ ${label}`, email: 'u@t.local', head_teacher: 'H', address: 'Douala' } });
  const year = await db.academicYear.create({ data: { id: uuid(), label: '2026-2027', start_date: '2026-09-01', end_date: '2027-07-31', is_current: true } });
  const t1 = await db.term.create({ data: { id: uuid(), academic_year_id: year.id, name: 'first', start_date: '2026-09-01', end_date: '2027-01-31', is_current: true } });
  const t2 = await db.term.create({ data: { id: uuid(), academic_year_id: year.id, name: 'second', start_date: '2027-02-01', end_date: '2027-07-31', is_current: false } });
  const levels = {};
  for (const [i, n] of [[1, 'Level 1'], [2, 'Level 2'], [3, 'Level 3']]) levels[i] = await db.gradeLevel.create({ data: { id: uuid(), name: n, sort_order: i } });
  const cls = {};
  for (const [k, n, l] of [['y1', 'CS Year 1', 1], ['y2', 'CS Year 2', 2], ['y3', 'CS Year 3', 3]]) cls[k] = await db.class.create({ data: { id: uuid(), name: n, grade_level_id: levels[l].id, grade_level_name: levels[l].name } });
  const mkT = n => db.teacher.create({ data: { id: uuid(), first_name: n, last_name: 'Lecturer', email: `${n}-${uuid()}@t.local` } });
  const teachers = { tina: await mkT('Tina'), tom: await mkT('Tom'), tess: await mkT('Tess') };
  const mkS = (n, c, extra = {}) => db.student.create({ data: { id: uuid(), student_number: `U-${n.toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`, first_name: n, last_name: 'Student', class_id: c?.id ?? null, class_name: c?.name ?? null, grade_level_name: c ? c.grade_level_name : null, is_active: true, ...extra } });
  const students = { ann: await mkS('Ann', cls.y1), bob: await mkS('Bob', cls.y1), cid: await mkS('Cid', cls.y3), dee: await mkS('Dee', null) };
  const mkU = (name, role, extra = {}) => db.user.create({ data: { id: uuid(), name, email: `${name.toLowerCase().replace(/\W/g, '')}-${uuid()}@t.local`, password_hash: 'x', role, initials: 'XX', ...extra } });
  const users = {
    admin: await mkU('Admin', 'super_admin'), officer: await mkU('Olivia Officer', 'academic_officer'), finance: await mkU('Fin', 'finance_officer'),
    tina: await mkU('Tina', 'teacher', { teacher_id: teachers.tina.id }), tom: await mkU('Tom', 'teacher', { teacher_id: teachers.tom.id }), tess: await mkU('Tess', 'teacher', { teacher_id: teachers.tess.id }),
    ann: await mkU('Ann', 'student', { student_id: students.ann.id }), bob: await mkU('Bob', 'student', { student_id: students.bob.id }), cid: await mkU('Cid', 'student', { student_id: students.cid.id }), dee: await mkU('Dee', 'student', { student_id: students.dee.id }),
  };
  const tok = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, mkToken(schoolId, u)]));
  const addStudent = async (name, c) => { const s = await mkS(name, c); const u = await mkU(name, 'student', { student_id: s.id }); return { s, u, token: mkToken(schoolId, u) }; };
  return { schoolId, db, year, t1, t2, levels, cls, teachers, students, users, tok, addStudent, mkS, mkU };
}

function finish(platform) {
  console.log(`\n${pass} passed, ${fail} failed`);
  return platform.$disconnect().then(() => process.exit(fail ? 1 : 0));
}
const counts = () => ({ pass, fail });

module.exports = { call, check, section, seedSchool, finish, mkToken, sleep, uuid, HOUR, DAY, platformClient, tenantPool, BASE, counts };
