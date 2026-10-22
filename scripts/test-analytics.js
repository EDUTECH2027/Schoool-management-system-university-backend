// Executive analytics suite: correctness against a hand-computed fixture school, permissions, filters, cache, CSV,
// tenant isolation, and timings on a seeded school of 2,000 students (raw-SQL bulk seed).
// Needs the API running against a LOCAL scratch database (see lib/academic-harness.js).
// Keep Prisma pools small: the scratch Postgres is shared by several module owners (max_connections is low).
if (process.env.DATABASE_URL && !/connection_limit/.test(process.env.DATABASE_URL)) process.env.DATABASE_URL += (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'connection_limit=4';
const H = require('./lib/academic-harness');
const { call, check, section, seedSchool, finish, uuid, platformClient } = H;
const jwt = require('jsonwebtoken');

const near = (a, b, eps = 0.011) => a !== null && a !== undefined && Math.abs(a - b) <= eps;
const by = (rows, k) => Object.fromEntries(rows.map(r => [r[k], r]));
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };

(async () => {
  const S = await seedSchool('AnaA'), O = await seedSchool('AnaB');
  const { db } = S, T1 = S.t1.id, T2 = S.t2.id, YEAR = S.year.id;
  const A = S.tok.admin, OF = S.tok.officer, FIN = S.tok.finance;

  // ── fixture ───────────────────────────────────────────────────────────────────────────
  const fac = await db.faculty.create({ data: { id: uuid(), name: 'Sciences', code: 'SCI' } });
  const dep = await db.department.create({ data: { id: uuid(), faculty_id: fac.id, name: 'Dept', code: 'D1' } });
  const P1 = await db.programme.create({ data: { id: uuid(), department_id: dep.id, name: 'BSc Computer Science', code: 'BCS' } });
  const P2 = await db.programme.create({ data: { id: uuid(), department_id: dep.id, name: 'BA Economics', code: 'BEC' } });
  await db.class.update({ where: { id: S.cls.y1.id }, data: { programme_id: P1.id } });
  await db.class.update({ where: { id: S.cls.y3.id }, data: { programme_id: P1.id } });
  const ec1 = await db.class.create({ data: { id: uuid(), name: 'ECON Year 1', grade_level_id: S.levels[1].id, grade_level_name: 'Level 1', programme_id: P2.id } });
  const mkSub = (code, credit) => db.subject.create({ data: { id: uuid(), name: `Course ${code}`, code, credit_hours: credit } });
  const C1 = await mkSub('C101', 3), C2 = await mkSub('C102', 4), C3 = await mkSub('C103', 3);
  const st = { ...S.students };
  st.e1 = await S.mkS('E1', S.cls.y1); st.e2 = await S.mkS('E2', S.cls.y1);
  st.f1 = await S.mkS('F1', ec1); st.f2 = await S.mkS('F2', ec1);
  const upd = (s, data) => db.student.update({ where: { id: s.id }, data });
  await upd(st.ann, { gender: 'female' }); await upd(st.bob, { gender: 'male' }); await upd(st.cid, { gender: 'male', academic_status: 'graduated' }); await upd(st.dee, { gender: 'male' });
  await upd(st.e1, { gender: 'female' }); await upd(st.e2, { gender: 'male' }); await upd(st.f1, { gender: 'female' }); await upd(st.f2, { gender: 'male', academic_status: 'withdrawn' });
  await db.programmeCourse.createMany({ data: [[P1, C1], [P1, C2], [P2, C3]].map(([p, c]) => ({ id: uuid(), programme_id: p.id, subject_id: c.id, semester: 'first' })) });

  const mark = (s, c, t, total, grade, status = 'published', extra = {}) => ({ id: uuid(), student_id: s.id, subject_id: c.id, term_id: t, total_score: total, grade, status, ...extra });
  await db.mark.createMany({ data: [
    mark(st.ann, C1, T1, 85, 'A'), mark(st.ann, C2, T1, 70, 'B'),
    mark(st.bob, C1, T1, 45, 'F'), mark(st.bob, C2, T1, 55, 'D'),
    mark(st.e1, C1, T1, 95, 'A+'), mark(st.e1, C2, T1, 40, 'F', 'published', { resit_score: 60 }),
    mark(st.e2, C1, T1, 62, 'C'), mark(st.e2, C2, T1, 38, 'F'),
    mark(st.f1, C3, T1, 75, 'B'), mark(st.f2, C3, T1, 20, 'F'), mark(st.dee, C1, T1, 90, 'A+'),
    mark(st.ann, C3, T2, 66, 'C'), mark(st.bob, C3, T2, 50, 'D'),
    // never counted: not published
    mark(st.ann, C3, T1, 10, 'F', 'submitted'), mark(st.bob, C3, T1, 99, 'A+', 'approved'), mark(st.e1, C3, T1, 5, 'F', 'draft'), mark(st.e2, C3, T1, 5, 'F', 'submitted'),
  ] });
  const mk = async (s, c, t) => (await db.mark.findFirst({ where: { student_id: s.id, subject_id: c.id, term_id: t } })).id;
  const appeal = async (s, c, status) => db.gradeAppeal.create({ data: { id: uuid(), mark_id: await mk(s, c, T1), student_id: s.id, reason: 'check', status } });
  await appeal(st.bob, C1, 'submitted'); await appeal(st.e2, C2, 'upheld'); await appeal(st.e1, C2, 'rejected'); await appeal(st.dee, C1, 'under_review');
  const pdec = (s, p, outcome, status) => db.progressionDecision.create({ data: { id: uuid(), student_id: s.id, academic_year_id: YEAR, programme_id: p.id, outcome, status, metrics: {} } });
  await pdec(st.ann, P1, 'promoted', 'applied'); await pdec(st.bob, P1, 'repeat', 'proposed'); await pdec(st.f1, P2, 'promoted', 'approved');

  const off = (c, t, open = true) => db.courseOffering.create({ data: { id: uuid(), subject_id: c.id, term_id: t, is_open: open } });
  const [o1, o2, o3] = [await off(C1, T1), await off(C2, T1), await off(C3, T2, false)];
  const enr = (s, o, t, credits, status = 'registered') => ({ id: uuid(), student_id: s.id, offering_id: o.id, term_id: t, credits, status });
  await db.courseEnrollment.createMany({ data: [enr(st.ann, o1, T1, 3), enr(st.ann, o2, T1, 4), enr(st.bob, o1, T1, 3), enr(st.e1, o1, T1, 3), enr(st.bob, o2, T1, 4, 'pending_approval'), enr(st.e2, o1, T1, 3, 'dropped')] });
  await db.serviceRequest.createMany({ data: [{ id: uuid(), reference: `SR-${uuid().slice(0, 8)}`, student_id: st.ann.id, type: 'other', subject: 'Open', status: 'submitted' }, { id: uuid(), reference: `SR-${uuid().slice(0, 8)}`, student_id: st.ann.id, type: 'other', subject: 'Done', status: 'completed' }] });

  const att = (s, cls, n, statuses) => Array.from({ length: n }, (_, i) => ({ id: uuid(), student_id: s.id, class_id: cls.id, date: `2026-10-${String(1 + i).padStart(2, '0')}`, status: statuses[i] }));
  const rep = (spec) => spec.flatMap(([n, v]) => Array(n).fill(v));
  await db.attendanceRecord.createMany({ data: [
    ...att(st.ann, S.cls.y1, 10, rep([[9, 'present'], [1, 'absent']])), ...att(st.bob, S.cls.y1, 10, rep([[5, 'present'], [2, 'late'], [3, 'absent']])),
    ...att(st.e1, S.cls.y1, 4, rep([[1, 'present'], [3, 'absent']])), ...att(st.e2, S.cls.y1, 10, rep([[6, 'present'], [4, 'excused']])),
    ...att(st.f1, ec1, 10, rep([[10, 'present']])), ...att(st.f2, ec1, 10, rep([[7, 'present'], [3, 'absent']])),
    { id: uuid(), student_id: st.ann.id, class_id: S.cls.y1.id, date: '2027-03-01', status: 'present' },
  ] });

  const exam = (c, t, title) => db.examSession.create({ data: { id: uuid(), subject_id: c.id, term_id: t, title, date: '2026-12-10', start_time: '09:00', end_time: '11:00' } });
  const [X1, X2] = [await exam(C1, T1, 'C101 Final'), await exam(C2, T2, 'C102 Final')];
  const cand = (x, s, eligible, reasons, attendance, extra = {}) => ({ id: uuid(), exam_id: x.id, student_id: s.id, eligible, ineligible_reasons: reasons, attendance, ...extra });
  await db.examCandidate.createMany({ data: [
    cand(X1, st.ann, true, null, 'present'), cand(X1, st.bob, false, [{ code: 'attendance', message: 'Attendance below 75%' }, { code: 'fees', message: 'Fees overdue' }], 'absent'),
    cand(X1, st.e1, false, [{ code: 'fees', message: 'Fees overdue' }], null), cand(X1, st.e2, true, null, 'present', { override_by: 'u1', override_reason: 'dean' }),
    cand(X2, st.ann, true, null, 'present'), cand(X2, st.f1, false, [{ code: 'attendance', message: 'Attendance below 75%' }], null),
  ] });

  const fee = (s, name, due, paid, status, due_date, year = '2026-2027', cls = null) => ({ id: uuid(), student_id: s.id, fee_name: name, academic_year: year, amount_due: due, amount_paid: paid, balance: status === 'waived' ? 0 : due - paid, status, due_date, class_id: cls });
  const fr = { annT: fee(st.ann, 'Tuition', 100000, 100000, 'paid', '2020-09-30', '2026-2027', S.cls.y1.id), annL: fee(st.ann, 'Library', 20000, 0, 'overdue', '2020-10-05'), bobT: fee(st.bob, 'Tuition', 100000, 40000, 'partial', '2020-09-30'), e1T: fee(st.e1, 'Tuition', 100000, 0, 'pending', '2999-01-31'), f1T: fee(st.f1, 'Tuition', 80000, 80000, 'paid', '2020-10-31'), f2T: fee(st.f2, 'Tuition', 80000, 0, 'waived', '2020-10-31'), e2T: fee(st.e2, 'Tuition', 100000, 0, 'pending', '2020-08-01'), bobOld: fee(st.bob, 'Old fee', 50000, 50000, 'paid', '2019-09-30', '2025-2026') };
  await db.feeRecord.createMany({ data: Object.values(fr) });
  const tx = (f, s, amount, provider, status) => ({ id: uuid(), reference: `TX-${uuid()}`, fee_record_id: f.id, student_id: s.id, amount, currency: 'XAF', provider, status });
  await db.paymentTransaction.createMany({ data: [tx(fr.annT, st.ann, 100000, 'orange_money', 'successful'), tx(fr.bobT, st.bob, 40000, 'mtn_momo', 'successful'), tx(fr.f1T, st.f1, 80000, 'stripe', 'successful'), tx(fr.bobT, st.bob, 40000, 'mtn_momo', 'failed'), tx(fr.e1T, st.e1, 100000, 'bank_transfer', 'awaiting_verification')] });
  await db.payment.createMany({ data: [{ id: uuid(), fee_record_id: fr.bobOld.id, amount: 50000, method: 'cash', payment_date: '2019-10-15' }, { id: uuid(), fee_record_id: fr.annT.id, amount: 100000, method: 'bank', payment_date: '2020-09-20' }] });

  // ── permissions ───────────────────────────────────────────────────────────────────────
  section('Permissions');
  const ENDS = ['overview', 'academics', 'attendance', 'exams', 'trends'];
  for (const e of ENDS) {
    check(`/${e}: super_admin 200`, (await call('GET', `/analytics/${e}`, { token: A })).status === 200);
    check(`/${e}: academic_officer 200`, (await call('GET', `/analytics/${e}`, { token: OF })).status === 200);
    const codes = await Promise.all(['finance', 'tina', 'ann'].map(k => call('GET', `/analytics/${e}`, { token: S.tok[k] }).then(r => r.status)));
    check(`/${e}: finance_officer, teacher, student → 403`, codes.every(c => c === 403), codes);
  }
  check('/finance: super_admin 200', (await call('GET', '/analytics/finance', { token: A })).status === 200);
  check('/finance: finance_officer 200', (await call('GET', '/analytics/finance', { token: FIN })).status === 200);
  check('/finance: academic_officer → 403 (no finance numbers)', (await call('GET', '/analytics/finance', { token: OF })).status === 403);
  check('/finance: teacher, student → 403', (await call('GET', '/analytics/finance', { token: S.tok.tina })).status === 403 && (await call('GET', '/analytics/finance', { token: S.tok.ann })).status === 403);
  check('/filters: admin, officer and finance_officer allowed; student not', (await call('GET', '/analytics/filters', { token: FIN })).status === 200 && (await call('GET', '/analytics/filters', { token: OF })).status === 200 && (await call('GET', '/analytics/filters', { token: S.tok.ann })).status === 403);
  check('no token → 401', (await call('GET', '/analytics/overview')).status === 401);
  const headT = jwt.sign({ id: S.users.admin.id, email: 'h@t.local', role: 'head_teacher', name: 'Head', school_id: S.schoolId, scope: 'tenant' }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '1h' });
  check('head_teacher is treated as super_admin', (await call('GET', '/analytics/overview', { token: headT })).status === 200 && (await call('GET', '/analytics/finance', { token: headT })).status === 200);
  check('finance_officer cannot export academic CSV', (await call('GET', '/analytics/academics?format=csv', { token: FIN })).status === 403);
  const flt = (await call('GET', '/analytics/filters', { token: OF })).body;
  check('filters: years with terms + programmes', flt.years?.[0]?.terms?.length === 2 && flt.programmes.length === 2, flt);

  // ── overview ──────────────────────────────────────────────────────────────────────────
  section('Overview (hand-computed)');
  const ov = (await call('GET', '/analytics/overview', { token: A })).body;
  check('students total 8 / active 6 / graduated 1 / withdrawn 1', ov.students.total === 8 && ov.students.active === 6 && ov.students.graduated === 1 && ov.students.withdrawn === 1 && ov.students.suspended === 0, ov.students);
  const bp = by(ov.students.by_programme, 'label');
  check('active students by programme: CS 4, Econ 1, Unassigned 1', bp['BSc Computer Science']?.n === 4 && bp['BA Economics']?.n === 1 && bp.Unassigned?.n === 1, ov.students.by_programme);
  const bl = by(ov.students.by_level, 'label');
  check('active students by level: Level 1 = 5, Unassigned = 1', bl['Level 1']?.n === 5 && bl.Unassigned?.n === 1, ov.students.by_level);
  const bg = by(ov.students.by_gender, 'label');
  check('active students by gender: female 3, male 3', bg.female?.n === 3 && bg.male?.n === 3, ov.students.by_gender);
  check('lecturers: 3 active of 3', ov.lecturers.total === 3 && ov.lecturers.active === 3, ov.lecturers);
  check('courses offered: 3 (2 open)', ov.courses_offered.total === 3 && ov.courses_offered.open === 2, ov.courses_offered);
  const reg1 = ov.registrations.find(r => r.term_id === T1);
  check('registrations T1: 4 registrations, 3 students, 13 credits, avg 4.3', reg1 && reg1.registrations === 4 && reg1.students === 3 && reg1.credits === 13 && near(reg1.avg_credits, 4.3), reg1);
  check('registrations: dropped/pending not counted; no row for T2', ov.registrations.length === 1);
  check('pending exception requests = 1', ov.pending_exception_requests === 1);
  check('results awaiting validation: 2 submitted, 1 approved, 1 draft', ov.results_awaiting_validation.submitted === 2 && ov.results_awaiting_validation.approved_not_published === 1 && ov.results_awaiting_validation.draft === 1, ov.results_awaiting_validation);
  check('open service requests = 1; open appeals = 2', ov.open_service_requests === 1 && ov.open_grade_appeals === 2, ov);
  const ovP1 = (await call('GET', `/analytics/overview?programme_id=${P1.id}`, { token: A })).body;
  check('programme filter: CS has 5 students (cid graduated), 4 active; offerings 2', ovP1.students.total === 5 && ovP1.students.active === 4 && ovP1.courses_offered.total === 2 && ovP1.pending_exception_requests === 1, ovP1.students);
  const ovT2 = (await call('GET', `/analytics/overview?term_id=${T2}`, { token: A })).body;
  check('term filter T2: 1 offering, no registrations, nothing pending', ovT2.courses_offered.total === 1 && ovT2.registrations.length === 0 && ovT2.pending_exception_requests === 0 && ovT2.results_awaiting_validation.submitted === 0, ovT2);

  // ── academics ─────────────────────────────────────────────────────────────────────────
  section('Academics (published marks only)');
  const ac = (await call('GET', '/analytics/academics?min_sample=4', { token: A })).body;
  check('summary: 13 published marks, 10 passed → 76.9%', ac.summary.marks === 13 && ac.summary.passed === 10 && near(ac.summary.pass_rate, 76.9), ac.summary);
  const pc = by(ac.pass_by_course, 'code');
  check('C101: n5 passed4 80% avg 75.4', pc.C101.n === 5 && pc.C101.passed === 4 && pc.C101.pass_rate === 80 && near(pc.C101.avg_score, 75.4), pc.C101);
  check('C102: resit pass counted → 3/4 = 75%, avg 50.8', pc.C102.n === 4 && pc.C102.passed === 3 && pc.C102.pass_rate === 75 && near(pc.C102.avg_score, 50.8), pc.C102);
  check('C103: only published marks (4), 3 passed, avg 52.8', pc.C103.n === 4 && pc.C103.passed === 3 && near(pc.C103.avg_score, 52.8), pc.C103);
  const pt = by(ac.pass_by_term, 'term_id');
  check('pass rate per term: T1 8/11, T2 2/2', pt[T1].n === 11 && pt[T1].passed === 8 && near(pt[T1].pass_rate, 72.7) && pt[T2].n === 2 && pt[T2].pass_rate === 100, ac.pass_by_term);
  const pp = by(ac.pass_by_programme, 'programme');
  check('pass rate per programme: CS 8/10, Econ 1/2, Unassigned 1/1', pp['BSc Computer Science'].n === 10 && pp['BSc Computer Science'].passed === 8 && pp['BA Economics'].passed === 1 && pp['BA Economics'].n === 2 && pp.Unassigned.n === 1, ac.pass_by_programme);
  const gd = by(ac.grade_distribution, 'grade');
  check('grade distribution A+2 A1 B2 C2 D2 F4', gd['A+'].n === 2 && gd.A.n === 1 && gd.B.n === 2 && gd.C.n === 2 && gd.D.n === 2 && gd.F.n === 4, ac.grade_distribution);
  check('grade distribution ordered by band (A+ first, F last)', ac.grade_distribution[0].grade === 'A+' && ac.grade_distribution.at(-1).grade === 'F' && near(gd.F.share, 30.8));
  check('GPA: 7 students, mean 1.90, median 1.71', ac.summary.students_with_gpa === 7 && near(ac.summary.mean_gpa, 1.9) && near(ac.summary.median_gpa, 1.71), ac.summary);
  check('GPA histogram bins [1,2,0,1,0,0,2,1] (8 bins of 0.5, max inclusive)', JSON.stringify(ac.gpa_histogram.map(b => b.n)) === '[1,2,0,1,0,0,2,1]' && ac.gpa_histogram[7].to === 4, ac.gpa_histogram.map(b => b.n));
  check('hardest (min sample 4): C102 then C103', ac.hardest_courses.map(c => c.code).join() === 'C102,C103,C101', ac.hardest_courses.map(c => c.code));
  check('easiest (min sample 4): C101 first', ac.easiest_courses[0].code === 'C101');
  const ac5 = (await call('GET', '/analytics/academics', { token: A })).body;
  check('default minimum sample 5 leaves only C101', ac5.min_sample === 5 && ac5.hardest_courses.length === 1 && ac5.hardest_courses[0].code === 'C101', ac5.hardest_courses);
  check('appeals: 4 total, 1 upheld, 1 rejected, 2 open, upheld rate 50%', ac.appeals.total === 4 && ac.appeals.upheld === 1 && ac.appeals.rejected === 1 && ac.appeals.open === 2 && ac.appeals.upheld_rate === 50, ac.appeals);
  check('progression outcomes: promoted 2, repeat 1', by(ac.progression.by_outcome, 'outcome').promoted.n === 2 && by(ac.progression.by_outcome, 'outcome').repeat.n === 1 && ac.progression.total === 3, ac.progression);
  const acP1T1 = (await call('GET', `/analytics/academics?programme_id=${P1.id}&term_id=${T1}`, { token: A })).body;
  check('filters programme CS + term T1: 8 marks, 6 passed', acP1T1.summary.marks === 8 && acP1T1.summary.passed === 6 && acP1T1.summary.pass_rate === 75, acP1T1.summary);
  check('filter echo returned', acP1T1.filters.programme === 'BSc Computer Science' && acP1T1.filters.term === 'first' && acP1T1.filters.academic_year === '2026-2027', acP1T1.filters);
  check('programme filter limits appeals + progression', acP1T1.appeals.total === 3 && acP1T1.progression.total === 2, { a: acP1T1.appeals, p: acP1T1.progression });
  const acYear = (await call('GET', `/analytics/academics?academic_year_id=${YEAR}`, { token: A })).body;
  check('academic year filter = both semesters', acYear.summary.marks === 13);
  check('empty scope (term T2, programme Econ) → no data, no crash', (await call('GET', `/analytics/academics?term_id=${T2}&programme_id=${P2.id}`, { token: A })).body.summary.marks === 0);
  check('unknown academic_year_id → 422', (await call('GET', `/analytics/academics?academic_year_id=${uuid()}`, { token: A })).status === 422);
  check('unknown term_id → 422', (await call('GET', `/analytics/overview?term_id=${uuid()}`, { token: A })).status === 422);
  check('unknown programme_id → 422', (await call('GET', `/analytics/exams?programme_id=${uuid()}`, { token: A })).status === 422);
  const otherYear = await db.academicYear.create({ data: { id: uuid(), label: '2027-2028', start_date: '2027-09-01', end_date: '2028-07-31' } });
  check('term outside the chosen year → 422', (await call('GET', `/analytics/academics?academic_year_id=${otherYear.id}&term_id=${T1}`, { token: A })).status === 422);
  check('year with no semesters → empty, not everything', (await call('GET', `/analytics/academics?academic_year_id=${otherYear.id}`, { token: A })).body.summary.marks === 0);
  check('injection-style filter value is just an unknown id (422)', (await call('GET', `/analytics/overview?programme_id=${encodeURIComponent("x' OR '1'='1")}`, { token: A })).status === 422);

  // ── attendance ────────────────────────────────────────────────────────────────────────
  section('Attendance');
  const at = (await call('GET', `/analytics/attendance?term_id=${T1}`, { token: A })).body;
  check('overall T1: 54 records, rate 74.1%', at.overall.records === 54 && at.overall.present === 38 && at.overall.late === 2 && at.overall.absent === 10 && at.overall.excused === 4 && near(at.overall.rate, 74.1), at.overall);
  const bc = by(at.by_class, 'class_name');
  check('by class: CS Year 1 = 67.6%, ECON Year 1 = 85%', near(bc['CS Year 1'].rate, 67.6) && bc['CS Year 1'].records === 34 && bc['ECON Year 1'].rate === 85, at.by_class);
  const bpr = by(at.by_programme, 'programme');
  check('by programme: CS 67.6, Econ 85', near(bpr['BSc Computer Science'].rate, 67.6) && bpr['BA Economics'].rate === 85 && bpr['BA Economics'].students === 2, at.by_programme);
  check('below 75% (min 5 records): E2 60, Bob 70, F2 70 — E1 (4 records) excluded', at.below_threshold.count === 3 && at.below_threshold.students.map(s => s.name).join() === 'E2 Student,Bob Student,F2 Student' && at.below_threshold.students[0].rate === 60, at.below_threshold);
  const at65 = (await call('GET', `/analytics/attendance?term_id=${T1}&threshold=65&min_records=1`, { token: A })).body;
  check('threshold / min_records are parameters (65%, min 1 → E1 25% and E2 60%)', at65.threshold === 65 && at65.below_threshold.count === 2 && at65.below_threshold.students[0].name === 'E1 Student', at65.below_threshold);
  const atAll = (await call('GET', '/analytics/attendance', { token: A })).body;
  check('all time includes the second-semester record (55 records)', atAll.overall.records === 55 && near(atAll.overall.rate, 74.5));
  const atT2 = (await call('GET', `/analytics/attendance?term_id=${T2}`, { token: A })).body;
  check('semester filter uses the semester dates (T2 → 1 record)', atT2.overall.records === 1 && atT2.overall.rate === 100);
  check('programme filter on attendance', (await call('GET', `/analytics/attendance?term_id=${T1}&programme_id=${P2.id}`, { token: A })).body.overall.records === 20);

  // ── exams ─────────────────────────────────────────────────────────────────────────────
  section('Exams');
  const ex = (await call('GET', '/analytics/exams', { token: A })).body;
  check('totals: 6 candidates (5 students), 3 eligible, 3 ineligible (50%), 1 override', ex.totals.candidates === 6 && ex.totals.students === 5 && ex.totals.eligible === 3 && ex.totals.ineligible === 3 && ex.totals.ineligible_rate === 50 && ex.totals.overridden === 1 && ex.totals.sessions === 2, ex.totals);
  check('attendance recorded: 3 present, 1 absent', ex.totals.present === 3 && ex.totals.absent === 1);
  const rs = by(ex.ineligible_by_reason, 'code');
  check('ineligible by reason: fees 2, attendance 2 (with messages)', rs.fees.n === 2 && rs.attendance.n === 2 && /Attendance/.test(rs.attendance.message), ex.ineligible_by_reason);
  const x1 = ex.sessions.find(s => s.title === 'C101 Final');
  check('per-session counts', x1.candidates === 4 && x1.eligible === 2 && x1.ineligible === 2 && x1.present === 2 && x1.absent === 1 && x1.code === 'C101', x1);
  const exT1 = (await call('GET', `/analytics/exams?term_id=${T1}`, { token: A })).body;
  check('term filter: only the C101 exam', exT1.totals.sessions === 1 && exT1.totals.candidates === 4);
  const exP1 = (await call('GET', `/analytics/exams?programme_id=${P1.id}`, { token: A })).body;
  check('programme filter: CS candidates only (5, 2 ineligible)', exP1.totals.candidates === 5 && exP1.totals.ineligible === 2 && by(exP1.ineligible_by_reason, 'code').fees.n === 2, exP1.totals);

  // ── finance ───────────────────────────────────────────────────────────────────────────
  section('Finance');
  const fi = (await call('GET', '/analytics/finance', { token: FIN })).body;
  check('totals (waived excluded): due 550k, collected 270k, outstanding 280k, overdue 180k, rate 49.1%', fi.totals.due === 550000 && fi.totals.collected === 270000 && fi.totals.outstanding === 280000 && fi.totals.overdue === 180000 && near(fi.totals.collection_rate, 49.1) && fi.totals.fee_records === 7, fi.totals);
  check('students with a balance = 4', fi.totals.students_with_balance === 4, fi.totals);
  const bm = by(fi.by_month, 'month');
  check('by month 2020-09: due 200k collected 140k outstanding 60k overdue 60k', bm['2020-09'].due === 200000 && bm['2020-09'].collected === 140000 && bm['2020-09'].outstanding === 60000 && bm['2020-09'].overdue === 60000 && near(bm['2020-09'].collection_rate, 70), bm['2020-09']);
  check('by month 2020-10: due 100k collected 80k overdue 20k', bm['2020-10'].due === 100000 && bm['2020-10'].collected === 80000 && bm['2020-10'].overdue === 20000);
  check('overdue by date (2020-08) and future (2999-01) handled', bm['2020-08'].overdue === 100000 && bm['2999-01'].overdue === 0 && bm['2999-01'].outstanding === 100000);
  check('months are chronological', fi.by_month.map(m => m.month).join() === '2019-09,2020-08,2020-09,2020-10,2999-01', fi.by_month.map(m => m.month));
  const mth = by(fi.payment_methods, 'method');
  check('payment-method split from successful transactions only', fi.payment_methods.length === 3 && mth.orange_money.amount === 100000 && mth.stripe.amount === 80000 && mth.mtn_momo.amount === 40000 && !mth.bank_transfer, fi.payment_methods);
  check('payment-method shares sum to ~100%', near(fi.payment_methods.reduce((x, m) => x + m.share, 0), 100, 0.3) && near(mth.orange_money.share, 45.5));
  check('manual payments listed separately', by(fi.manual_payment_methods, 'method').cash.amount === 50000 && by(fi.manual_payment_methods, 'method').bank.amount === 100000, fi.manual_payment_methods);
  check('cash received by month', by(fi.cash_received_by_month, 'month')['2020-09'].received === 100000 && by(fi.cash_received_by_month, 'month')['2019-10'].received === 50000);
  const fiY = (await call('GET', `/analytics/finance?academic_year_id=${YEAR}`, { token: A })).body;
  check('academic-year filter drops the 2025-2026 fee', fiY.totals.due === 500000 && fiY.totals.collected === 220000 && near(fiY.totals.collection_rate, 44) && fiY.manual_payment_methods.length === 1, fiY.totals);
  const fp = by(fiY.by_programme, 'programme');
  check('by programme (year): CS due 420k collected 140k; Econ due 80k collected 80k (100%)', fp['BSc Computer Science'].due === 420000 && fp['BSc Computer Science'].collected === 140000 && fp['BA Economics'].due === 80000 && fp['BA Economics'].collection_rate === 100, fiY.by_programme);
  const fiP = (await call('GET', `/analytics/finance?academic_year_id=${YEAR}&programme_id=${P1.id}`, { token: A })).body;
  check('programme filter: CS outstanding 280k, no Econ money', fiP.totals.outstanding === 280000 && fiP.totals.due === 420000 && fiP.payment_methods.length === 2, fiP.totals);

  // ── trends ────────────────────────────────────────────────────────────────────────────
  section('Trends');
  const tr = (await call('GET', '/analytics/trends', { token: A })).body;
  const s1 = tr.series.find(s => s.term_id === T1), s2 = tr.series.find(s => s.term_id === T2);
  check('two semesters in chronological order', tr.series.length === 2 && tr.series[0].term_id === T1);
  check('T1: 3 students, avg credits 4.3, pass 72.7%, avg 61.4, GPA 1.94, attendance 74.1%', s1.registered_students === 3 && near(s1.avg_credits, 4.3) && near(s1.pass_rate, 72.7) && near(s1.avg_score, 61.4) && near(s1.mean_gpa, 1.94) && near(s1.attendance_rate, 74.1), s1);
  check('T2: pass 100%, GPA 1.50, attendance 100%', s2.pass_rate === 100 && near(s2.mean_gpa, 1.5) && s2.attendance_rate === 100 && s2.registered_students === 0 && s2.avg_credits === null, s2);
  check('term-over-term deltas', s1.change === null && s2.change.registered_students === -3 && near(s2.change.pass_rate, 27.3) && near(s2.change.mean_gpa, -0.44) && near(s2.change.attendance_rate, 25.9), s2.change);
  const trP = (await call('GET', `/analytics/trends?programme_id=${P2.id}`, { token: A })).body;
  check('programme filter on trends (Econ T1: 2 marks, 50% pass)', trP.series.find(s => s.term_id === T1).pass_rate === 50);

  // ── CSV ───────────────────────────────────────────────────────────────────────────────
  section('CSV export');
  const csvOf = async (url, token = A) => { const r = await call('GET', url, { token, raw: true }); return { r, text: await r.text() }; };
  let c = await csvOf('/analytics/academics?format=csv&table=pass_by_course');
  check('academics CSV: headers + 3 course rows', /text\/csv/.test(c.r.headers.get('content-type')) && /attachment/.test(c.r.headers.get('content-disposition')) && c.text.replace('﻿', '').startsWith('subject_id,code,name,n,passed,avg_score,pass_rate') && c.text.trim().split('\r\n').length === 4, c.text.slice(0, 200));
  check('CSV default table = first one', (await csvOf('/analytics/academics?format=csv')).text.includes('subject_id'));
  c = await csvOf('/analytics/finance?format=csv&table=by_month', FIN);
  check('finance CSV for finance_officer', c.r.status === 200 && c.text.includes('2020-09,200000,140000,60000,60000,70'), c.text);
  check('unknown table → 422', (await call('GET', '/analytics/academics?format=csv&table=nope', { token: A })).status === 422);
  c = await csvOf(`/analytics/attendance?format=csv&table=below_threshold&term_id=${T1}`);
  check('attendance CSV below_threshold', c.text.includes('E2 Student') && c.text.includes('Bob Student'));
  check('overview / exams / trends CSV', (await csvOf('/analytics/overview?format=csv&table=by_gender')).text.includes('female') && (await csvOf('/analytics/exams?format=csv&table=ineligible_by_reason')).text.includes('fees') && (await csvOf('/analytics/trends?format=csv')).text.includes('change_pass_rate'));

  // ── cache ─────────────────────────────────────────────────────────────────────────────
  section('Cache & refresh');
  const g1 = await call('GET', `/analytics/academics?programme_id=${P2.id}`, { token: A });
  const g2 = await call('GET', `/analytics/academics?programme_id=${P2.id}`, { token: A });
  check('first call = miss, second = hit', g1.headers.get('x-cache') === 'miss' && g2.headers.get('x-cache') === 'hit' && g2.body.cached === true && g1.body.cached === false);
  const sd = await S.mkS('Late', ec1);
  await db.mark.create({ data: mark(sd, C3, T1, 80, 'A') });
  const g3 = await call('GET', `/analytics/academics?programme_id=${P2.id}`, { token: A });
  check('cached snapshot is served until refreshed (stale by design)', g3.body.summary.marks === 2, g3.body.summary);
  const g4 = await call('GET', `/analytics/academics?programme_id=${P2.id}&refresh=1`, { token: A });
  check('?refresh=1 recomputes (miss) and sees the new mark', g4.headers.get('x-cache') === 'miss' && g4.body.summary.marks === 3, g4.body.summary);
  const g5 = await call('GET', `/analytics/academics?programme_id=${P2.id}`, { token: A });
  check('the refreshed result is cached again', g5.headers.get('x-cache') === 'hit' && g5.body.summary.marks === 3);
  await call('GET', '/analytics/overview', { token: A });
  await call('GET', `/analytics/overview?refresh=1`, { token: A });
  check('refresh drops every cached entry of the school', (await call('GET', `/analytics/academics?programme_id=${P2.id}`, { token: A })).headers.get('x-cache') === 'miss');
  const k1 = await call('GET', `/analytics/academics?term_id=${T1}`, { token: A });
  check('different filters use different cache entries', k1.headers.get('x-cache') === 'miss' && k1.body.summary.marks === 12, k1.body.summary);

  // ── isolation ─────────────────────────────────────────────────────────────────────────
  section('Tenant isolation');
  const oOv = (await call('GET', '/analytics/overview', { token: O.tok.admin })).body;
  check('school B sees none of school A’s students', oOv.students.total === 4 && oOv.students.by_programme.every(p => p.label === 'Unassigned'), oOv.students);
  const oFi = (await call('GET', '/analytics/finance?refresh=1', { token: O.tok.admin })).body;
  check('school B finance is empty (A’s 550k not visible)', oFi.totals.due === 0 && oFi.by_month.length === 0);
  check('school B refresh did not evict school A’s cache', (await call('GET', `/analytics/academics?term_id=${T1}`, { token: A })).headers.get('x-cache') === 'hit');
  check('school A’s programme id is unknown in school B (422)', (await call('GET', `/analytics/academics?programme_id=${P1.id}`, { token: O.tok.admin })).status === 422);

  // ── performance on 2,000 students ─────────────────────────────────────────────────────
  section('Performance: 2,000 students seeded with raw SQL');
  const B = await seedSchool('AnaBig');
  const bdb = B.db, N = 2000;
  const t0 = Date.now();
  const pr = [];
  for (let i = 0; i < 4; i++) pr.push(await bdb.programme.create({ data: { id: uuid(), department_id: (await bdb.department.create({ data: { id: uuid(), faculty_id: (await bdb.faculty.create({ data: { id: uuid(), name: `F${i}`, code: `F${i}` } })).id, name: `D${i}`, code: `D${i}` } })).id, name: `Programme ${i}`, code: `PG${i}` } }));
  const cls = [];
  for (let p = 0; p < 4; p++) for (let l = 1; l <= 3; l++) cls.push(await bdb.class.create({ data: { id: uuid(), name: `P${p}-L${l}`, grade_level_id: B.levels[l].id, grade_level_name: `Level ${l}`, programme_id: pr[p].id } }));
  await bdb.subject.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ id: uuid(), name: `Big course ${i}`, code: `BC${String(i).padStart(3, '0')}`, credit_hours: 2 + (i % 3) })) });
  const terms = [B.t1.id, B.t2.id];
  await bdb.$executeRawUnsafe(`INSERT INTO students (id, student_number, first_name, last_name, gender, class_id, class_name, grade_level_name, is_active, academic_status)
    SELECT gen_random_uuid()::text, 'BIG-' || g, 'First' || g, 'Last' || g, (CASE WHEN g % 2 = 0 THEN 'male' ELSE 'female' END)::"Gender", c.id, c.name, c.grade_level_name, true, CASE WHEN g % 40 = 0 THEN 'graduated' ELSE 'active' END
    FROM generate_series(1, ${N}) g JOIN (SELECT id, name, grade_level_name, row_number() OVER (ORDER BY name) - 1 AS rn FROM classes WHERE name LIKE 'P%-L%') c ON c.rn = g % 12`);
  const ranked = `(SELECT id, class_id, row_number() OVER (ORDER BY student_number) AS rn FROM students WHERE student_number LIKE 'BIG-%') s CROSS JOIN generate_series(0, 5) k JOIN (SELECT id, credit_hours, row_number() OVER (ORDER BY code) AS rn FROM subjects WHERE code LIKE 'BC%') sub ON sub.rn = 1 + ((s.rn + k) % 60) CROSS JOIN (VALUES ('${terms[0]}'), ('${terms[1]}')) t(id)`;
  await bdb.$executeRawUnsafe(`INSERT INTO marks (id, student_id, subject_id, term_id, class_id, ca_score, exam_score, total_score, grade, status)
    SELECT gen_random_uuid()::text, s.id, sub.id, t.id, s.class_id, x.v, x.v, x.v, CASE WHEN x.v >= 90 THEN 'A+' WHEN x.v >= 80 THEN 'A' WHEN x.v >= 70 THEN 'B' WHEN x.v >= 60 THEN 'C' WHEN x.v >= 50 THEN 'D' ELSE 'F' END, 'published'::"MarkStatus"
    FROM ${ranked} CROSS JOIN LATERAL (SELECT (25 + abs(hashtext(s.id || sub.id || t.id)) % 75)::float8 AS v) x`);
  await bdb.$executeRawUnsafe(`INSERT INTO course_offerings (id, subject_id, term_id, is_open) SELECT gen_random_uuid()::text, sub.id, t.id, true FROM subjects sub CROSS JOIN terms t WHERE sub.code LIKE 'BC%'`);
  await bdb.$executeRawUnsafe(`INSERT INTO course_enrollments (id, student_id, offering_id, term_id, status, credits)
    SELECT gen_random_uuid()::text, m.student_id, o.id, m.term_id, (CASE WHEN abs(hashtext(m.id)) % 25 = 0 THEN 'pending_approval' ELSE 'registered' END)::"EnrollmentStatus", sub.credit_hours FROM marks m JOIN course_offerings o ON o.subject_id = m.subject_id AND o.term_id = m.term_id JOIN subjects sub ON sub.id = m.subject_id WHERE m.student_id IN (SELECT id FROM students WHERE student_number LIKE 'BIG-%')`);
  await bdb.$executeRawUnsafe(`INSERT INTO attendance_records (id, student_id, class_id, date, status)
    SELECT gen_random_uuid()::text, s.id, s.class_id, to_char(date '2026-09-07' + d, 'YYYY-MM-DD'), (CASE WHEN abs(hashtext(s.id || d)) % 10 < 7 THEN 'present' WHEN abs(hashtext(s.id || d)) % 10 = 7 THEN 'late' WHEN abs(hashtext(s.id || d)) % 10 = 8 THEN 'absent' ELSE 'excused' END)::"AttendanceStatus"
    FROM students s CROSS JOIN generate_series(0, 39) d WHERE s.student_number LIKE 'BIG-%'`);
  await bdb.$executeRawUnsafe(`INSERT INTO fee_records (id, student_id, class_id, fee_name, academic_year, amount_due, amount_paid, balance, status, due_date)
    SELECT gen_random_uuid()::text, s.id, s.class_id, f.name, '2026-2027', 150000, f.paid, 150000 - f.paid, (CASE WHEN f.paid >= 150000 THEN 'paid' WHEN f.paid > 0 THEN 'partial' ELSE 'pending' END)::"FeeStatus", f.due
    FROM students s CROSS JOIN LATERAL (VALUES ('Tuition 1', (abs(hashtext(s.id)) % 4) * 50000.0, '2026-09-30'), ('Tuition 2', (abs(hashtext(s.id || 'x')) % 4) * 50000.0, '2027-01-31')) f(name, paid, due) WHERE s.student_number LIKE 'BIG-%'`);
  await bdb.$executeRawUnsafe(`INSERT INTO payment_transactions (id, reference, fee_record_id, student_id, amount, currency, provider, status)
    SELECT gen_random_uuid()::text, 'T-' || gen_random_uuid()::text, fr.id, fr.student_id, fr.amount_paid, 'XAF', (ARRAY['orange_money','mtn_momo','stripe','bank_transfer'])[1 + abs(hashtext(fr.id)) % 4], 'successful'::"PaymentTxStatus" FROM fee_records fr WHERE fr.amount_paid > 0`);
  await bdb.$executeRawUnsafe(`INSERT INTO exam_sessions (id, subject_id, term_id, title, date, start_time, end_time) SELECT gen_random_uuid()::text, sub.id, '${terms[0]}', sub.code || ' exam', '2026-12-10', '09:00', '11:00' FROM subjects sub WHERE sub.code LIKE 'BC%'`);
  await bdb.$executeRawUnsafe(`INSERT INTO exam_candidates (id, exam_id, student_id, eligible, ineligible_reasons, attendance)
    SELECT gen_random_uuid()::text, es.id, m.student_id, e.ok, CASE WHEN e.ok THEN NULL ELSE '[{"code":"attendance","message":"Attendance below minimum"},{"code":"fees","message":"Fees overdue"}]'::jsonb END, 'present'
    FROM marks m JOIN exam_sessions es ON es.subject_id = m.subject_id AND es.term_id = m.term_id CROSS JOIN LATERAL (SELECT abs(hashtext(m.id)) % 7 <> 0 AS ok) e WHERE m.term_id = '${terms[0]}'`);
  await bdb.$executeRawUnsafe(`INSERT INTO grade_appeals (id, mark_id, student_id, reason, status) SELECT gen_random_uuid()::text, m.id, m.student_id, 'r', (ARRAY['submitted','under_review','upheld','rejected'])[1 + abs(hashtext(m.id)) % 4] FROM marks m WHERE abs(hashtext(m.id)) % 60 = 0`);
  const cnt = async tbl => Number((await bdb.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${tbl}`))[0].n);
  const nMarks = await cnt('marks'), nAtt = await cnt('attendance_records'), nEnr = await cnt('course_enrollments'), nCand = await cnt('exam_candidates');
  console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${await cnt('students')} students (+4 base), ${nMarks} marks, ${nAtt} attendance, ${nEnr} enrolments, ${await cnt('fee_records')} fee records, ${await cnt('payment_transactions')} transactions, ${nCand} exam candidates`);
  const bigTok = B.tok.admin, bigFin = B.tok.finance;
  check('seed reached ≥ 2,000 students', await cnt('students') >= N);

  // The scratch Postgres is shared with other module owners' suites and is often I/O-bound, so each figure is the best of 3
  // runs (every run forces a recompute with ?refresh=1); all runs are printed. Cached answers are measured the same way.
  const timings = {}, runs = {};
  const heavy = [['overview', 'overview', bigTok], ['academics', 'academics', bigTok], ['attendance', 'attendance', bigTok], ['exams', 'exams', bigTok], ['finance', 'finance', bigFin], ['trends', 'trends', bigTok]];
  for (const [label, path, tk] of heavy) {
    const ms = []; let last;
    for (let i = 0; i < 3; i++) { const [r, t] = await timed(() => call('GET', `/analytics/${path}?refresh=1`, { token: tk })); ms.push(t); last = r; }
    timings[label] = Math.min(...ms); runs[label] = ms;
    check(`/${label} (computed, best of 3) answers in < 1000 ms on 2,000 students [${ms.join(' / ')} ms]`, last.status === 200 && Math.min(...ms) < 1000, { ms, status: last.status });
  }
  for (const [label, path, tk] of heavy) {
    const ms = []; let hit = true;
    await call('GET', `/analytics/${path}`, { token: tk });   // warm: an earlier ?refresh=1 (any endpoint) clears the whole school's cache
    for (let i = 0; i < 5; i++) { const [r, t] = await timed(() => call('GET', `/analytics/${path}`, { token: tk })); ms.push(t); hit = hit && r.headers.get('x-cache') === 'hit'; }
    check(`/${label} (cached, best of 5) < 500 ms [${ms.join(' / ')} ms]`, hit && Math.min(...ms) < 500, ms);
  }
  const [wf, msF] = await timed(() => call('GET', `/analytics/academics?term_id=${terms[0]}&programme_id=${pr[1].id}&refresh=1`, { token: bigTok }));
  check(`filtered academics (term + programme, forced refresh) < 1500 ms [${msF} ms]`, wf.status === 200 && msF < 1500);
  console.log('  timings (ms, best of 3, computed):', JSON.stringify(timings), ' all runs:', JSON.stringify(runs));

  const big = { ov: (await call('GET', '/analytics/overview', { token: bigTok })).body, ac: (await call('GET', '/analytics/academics', { token: bigTok })).body, at: (await call('GET', '/analytics/attendance', { token: bigTok })).body, ex: (await call('GET', '/analytics/exams', { token: bigTok })).body, fi: (await call('GET', '/analytics/finance', { token: bigFin })).body, tr: (await call('GET', '/analytics/trends', { token: bigTok })).body };
  check('overview counts match the table (2,004 students incl. 4 from the harness)', big.ov.students.total === (await cnt('students')));
  check('academics: marks summary equals COUNT(*) of published marks', big.ac.summary.marks === nMarks && big.ac.pass_by_course.length === 60 && big.ac.summary.students_with_gpa >= N, big.ac.summary);
  check('academics: pass rate equals an independent SQL computation', await (async () => { const r = (await bdb.$queryRawUnsafe(`SELECT COUNT(*) FILTER (WHERE total_score >= 50)::int AS p FROM marks`))[0].p; return r === big.ac.summary.passed; })(), big.ac.summary);
  check('academics: GPA histogram covers every student with marks', big.ac.gpa_histogram.reduce((x, b) => x + b.n, 0) === big.ac.summary.students_with_gpa);
  check('attendance: record count equals COUNT(*)', big.at.overall.records === nAtt && big.at.by_class.length === 12 && big.at.by_programme.length === 4, big.at.overall);
  check('exams: candidate count equals COUNT(*), reasons counted per ineligible candidate', big.ex.totals.candidates === nCand && big.ex.ineligible_by_reason.length === 2 && big.ex.ineligible_by_reason[0].n === big.ex.totals.ineligible, big.ex.totals);
  const dueSql = (await bdb.$queryRawUnsafe(`SELECT SUM(amount_due)::float8 AS d, SUM(amount_paid)::float8 AS c FROM fee_records`))[0];
  check('finance: due/collected equal SUM() of fee_records', big.fi.totals.due === dueSql.d && big.fi.totals.collected === dueSql.c && big.fi.by_programme.length === 4, big.fi.totals);
  check('finance: payment-method split covers all successful transactions', Math.abs(big.fi.payment_methods.reduce((x, m) => x + m.amount, 0) - dueSql.c) < 1 && big.fi.payment_methods.length === 4);
  check('trends: two semesters with data', big.tr.series.length === 2 && big.tr.series.every(s => s.marks > 0 && s.pass_rate !== null));

  await finish(platformClient);
})().catch(e => { console.error(e); process.exit(1); });
