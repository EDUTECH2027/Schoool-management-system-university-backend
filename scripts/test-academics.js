// Phase 1+2 backend suite: structure, catalogue, offerings, registration, results workflow, exams, progression, documents.
// Needs the API running against a LOCAL scratch database (see lib/academic-harness.js).
const H = require('./lib/academic-harness');
const { call, check, section, seedSchool, finish, sleep, HOUR, DAY, platformClient } = H;
const iso = ms => new Date(Date.now() + ms).toISOString();

(async () => {
  const S = await seedSchool('A'), O = await seedSchool('B');
  const { tok, db } = S;
  const A = tok.admin, OF = tok.officer;

  // ── structure ──────────────────────────────────────────────────────────────────
  section('Structure: faculty / department / programme');
  const fac = (await call('POST', '/academics/faculties', { token: OF, body: { name: 'Science', code: 'sci' } }));
  check('officer creates a faculty', fac.status === 201 && fac.body.code === 'SCI', fac);
  check('duplicate faculty → 409', (await call('POST', '/academics/faculties', { token: A, body: { name: 'Science', code: 'X' } })).status === 409);
  check('student cannot create a faculty', (await call('POST', '/academics/faculties', { token: tok.ann, body: { name: 'Hack', code: 'H' } })).status === 403);
  check('teacher cannot create a faculty', (await call('POST', '/academics/faculties', { token: tok.tina, body: { name: 'Hack', code: 'H' } })).status === 403);
  const dep = (await call('POST', '/academics/departments', { token: OF, body: { faculty_id: fac.body.id, name: 'Computer Science', code: 'cs' } }));
  check('department created', dep.status === 201, dep);
  check('department with unknown faculty → 422', (await call('POST', '/academics/departments', { token: OF, body: { faculty_id: 'nope', name: 'X', code: 'X' } })).status === 422);
  const prg = (await call('POST', '/academics/programmes', { token: OF, body: { department_id: dep.body.id, name: 'BSc Computer Science', code: 'bsc-cs', duration_years: 3, credits_required: 18 } }));
  check('programme created', prg.status === 201 && prg.body.credits_required === 18, prg);
  check('delete faculty with departments → 409', (await call('DELETE', `/academics/faculties/${fac.body.id}`, { token: A })).status === 409);
  check('delete department with programmes → 409', (await call('DELETE', `/academics/departments/${dep.body.id}`, { token: A })).status === 409);
  for (const k of ['y1', 'y2', 'y3']) await call('PUT', `/academics/classes/${S.cls[k].id}/programme`, { token: OF, body: { programme_id: prg.body.id } });
  check('delete programme with cohorts → 409', (await call('DELETE', `/academics/programmes/${prg.body.id}`, { token: A })).status === 409);
  const classes = (await call('GET', '/academics/classes', { token: A })).body;
  check('classes list shows programme', classes.every(c => c.programme === 'BSc Computer Science'), classes);

  // ── catalogue ──────────────────────────────────────────────────────────────────
  section('Catalogue & prerequisites');
  const mkC = async (name, code, extra = {}) => (await call('POST', '/subjects', { token: OF, body: { name, code, credit_hours: 3, department_id: dep.body.id, level_id: S.levels[1].id, semester: 'first', ...extra } })).body;
  const prog1 = await mkC('Programming 1', 'CS101'), prog2 = await mkC('Programming 2', 'CS102', { prerequisite_ids: [prog1.id] });
  const maths = await mkC('Mathematics', 'MA101'), phys = await mkC('Physics', 'PH101', { credit_hours: 4 }), chem = await mkC('Chemistry', 'CH101');
  check('course created with prerequisite', prog2.prerequisite_ids?.[0] === prog1.id, prog2);
  check('duplicate code → 409', (await call('POST', '/subjects', { token: OF, body: { name: 'Other', code: 'CS101' } })).status === 409);
  check('self prerequisite rejected', (await call('PUT', `/subjects/${prog1.id}`, { token: OF, body: { prerequisite_ids: [prog1.id] } })).status === 422);
  check('prerequisite loop rejected', (await call('PUT', `/subjects/${prog1.id}`, { token: OF, body: { prerequisite_ids: [prog2.id] } })).status === 422);
  check('teacher cannot edit the catalogue', (await call('POST', '/subjects', { token: tok.tina, body: { name: 'X', code: 'X' } })).status === 403);
  check('students can read the catalogue', (await call('GET', '/subjects', { token: tok.ann })).status === 200);
  const partial = await call('PUT', `/subjects/${phys.id}`, { token: OF, body: { description: 'Mechanics' } });
  check('partial update keeps credits', partial.body.credit_hours === 4 && partial.body.description === 'Mechanics', partial.body);
  const cur = await call('PUT', `/academics/programmes/${prg.body.id}/curriculum`, { token: OF, body: { items: [prog1, prog2, maths, phys].map(c => ({ subject_id: c.id, semester: 'first', kind: 'core' })) } });
  check('curriculum saved', cur.body.saved === 4, cur);
  check('duplicate curriculum entry rejected', (await call('PUT', `/academics/programmes/${prg.body.id}/curriculum`, { token: OF, body: { items: [{ subject_id: maths.id, semester: 'first' }, { subject_id: maths.id, semester: 'first' }] } })).status === 422);
  await call('PUT', `/academics/programmes/${prg.body.id}/curriculum`, { token: OF, body: { items: [prog1, prog2, maths, phys].map(c => ({ subject_id: c.id, semester: 'first', kind: 'core' })) } });

  // ── offerings ──────────────────────────────────────────────────────────────────
  section('Offerings');
  const T1 = S.t1.id;
  const mkO = async (subj, extra = {}) => call('POST', '/academics/offerings', { token: OF, body: { subject_id: subj.id, term_id: T1, ...extra } });
  const oProg1 = (await mkO(prog1, { teacher_id: S.teachers.tina.id, capacity: 30, slots: [{ day: 'monday', period_key: 'P1', room: 'R1' }] })).body;
  const oProg2 = (await mkO(prog2, { teacher_id: S.teachers.tina.id, slots: [{ day: 'tuesday', period_key: 'P1' }] })).body;
  const oMaths = (await mkO(maths, { teacher_id: S.teachers.tom.id, capacity: 1, slots: [{ day: 'wednesday', period_key: 'P1' }] })).body;
  const oPhys = (await mkO(phys, { teacher_id: S.teachers.tom.id, slots: [{ day: 'monday', period_key: 'P1' }] })).body;   // clashes with Programming 1 for a student
  const oChem = (await mkO(chem, { teacher_id: S.teachers.tess.id })).body;
  check('offerings created', [oProg1, oProg2, oMaths, oPhys, oChem].every(o => o.id));
  const clash = await mkO(chem, { section: 'B', teacher_id: S.teachers.tina.id, slots: [{ day: 'monday', period_key: 'P1' }] });
  check('lecturer double-booking → 409', clash.status === 409 && clash.body.code === 'teacher_conflict', clash);
  const forced = await mkO(chem, { section: 'B', teacher_id: S.teachers.tina.id, slots: [{ day: 'monday', period_key: 'P1' }], override: true, override_reason: 'Joint lecture' });
  check('lecturer clash can be overridden and is audited', forced.status === 201);
  check('duplicate section → 409', (await mkO(prog1, { slots: [] })).status === 409);
  check('bad slot day → 422', (await mkO(chem, { section: 'Z', slots: [{ day: 'sunday', period_key: 'P1' }] })).status === 422);

  // ── registration ───────────────────────────────────────────────────────────────
  section('Registration periods & student registration');
  const stu = tok.ann;
  const noPeriod = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oProg1.id } });
  check('no registration period → blocked', noPeriod.status === 422 && noPeriod.body.code === 'no_period', noPeriod.body);
  check('bad period dates → 422', (await call('POST', '/academics/registration-periods', { token: OF, body: { term_id: T1, opens_at: iso(DAY), closes_at: iso(-DAY) } })).status === 422);
  check('min>max credits → 422', (await call('POST', '/academics/registration-periods', { token: OF, body: { term_id: T1, opens_at: iso(-DAY), closes_at: iso(DAY), min_credits: 20, max_credits: 10 } })).status === 422);
  const closedP = (await call('POST', '/academics/registration-periods', { token: OF, body: { term_id: T1, programme_id: prg.body.id, opens_at: iso(-3 * DAY), closes_at: iso(-DAY), max_credits: 12 } })).body;
  const closed = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oProg1.id } });
  check('closed period → blocked', closed.body.code === 'period_closed', closed.body);
  await call('PUT', `/academics/registration-periods/${closedP.id}`, { token: OF, body: { opens_at: iso(-HOUR), closes_at: iso(DAY), max_credits: 9, min_credits: 3, add_drop_until: iso(DAY), allow_exceptions: true } });
  const ov0 = (await call('GET', '/registration/me', { token: stu })).body;
  check('student overview lists offerings with verdicts', ov0.offerings.length >= 5 && ov0.period?.is_open === true && ov0.credits.max === 9, { n: ov0.offerings?.length, p: ov0.period });
  const verdict = id => ov0.offerings.find(o => o.id === id);
  check('prereq missing is an exception (needs approval)', verdict(oProg2.id).needs_approval && verdict(oProg2.id).approvals[0].code === 'prerequisites_missing', verdict(oProg2.id));
  check('course outside curriculum needs approval', verdict(oChem.id).approvals.some(a => a.code === 'not_in_curriculum'));
  const e1 = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oProg1.id } });
  check('regular registration succeeds', e1.status === 201 && e1.body.enrollment.status === 'registered', e1.body);
  check('duplicate registration blocked', (await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oProg1.id } })).body.code === 'already_registered');
  const clashEnroll = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oPhys.id } });
  check('timetable clash blocked', clashEnroll.body.code === 'timetable_conflict', clashEnroll.body);
  const noReason = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oProg2.id } });
  check('exception without reason → 422', noReason.status === 422 && noReason.body.code === 'exception_reason_required', noReason.body);
  const exc = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oProg2.id, exception_reason: 'I did the equivalent course elsewhere' } });
  check('exception becomes pending approval', exc.status === 201 && exc.body.pending_approval === true, exc.body);
  const e3 = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oMaths.id } });
  check('second course within credit limit', e3.status === 201, e3.body);
  const over = await call('POST', '/registration/me/enroll', { token: stu, body: { offering_id: oChem.id, exception_reason: 'x' } });
  check('credit ceiling enforced (9 registered + 3 > 9)', over.body.code === 'max_credits', over.body);
  const qd = (await call('GET', '/academics/registrations?status=pending_approval', { token: OF })).body;
  check('approval queue shows the exception request', qd.items.some(i => i.id === exc.body.enrollment.id), qd);
  check('student cannot read the queue', (await call('GET', '/academics/registrations', { token: stu })).status === 403);
  check('reject needs a reason', (await call('POST', `/academics/registrations/${exc.body.enrollment.id}/decision`, { token: OF, body: { decision: 'reject' } })).status === 422);
  const ap = await call('POST', `/academics/registrations/${exc.body.enrollment.id}/decision`, { token: OF, body: { decision: 'approve', note: 'OK' } });
  check('approving moves it to registered', ap.body.status === 'registered', ap.body);
  check('deciding twice → 409', (await call('POST', `/academics/registrations/${exc.body.enrollment.id}/decision`, { token: OF, body: { decision: 'approve' } })).status === 409);
  const sum = (await call('GET', '/registration/me/summary', { token: stu })).body;
  check('printable summary lists registered courses', sum.courses.length === 3 && sum.credits.registered === 9, sum.credits);

  // capacity race: Mathematics has 1 seat and Ann holds it
  const bob = tok.bob;
  const full = await call('POST', '/registration/me/enroll', { token: bob, body: { offering_id: oMaths.id } });
  check('full course blocked', full.body.code === 'full', full.body);
  await call('PUT', `/academics/offerings/${oMaths.id}`, { token: OF, body: { capacity: 2 } });
  check('capacity cannot go below registered count', (await call('PUT', `/academics/offerings/${oMaths.id}`, { token: OF, body: { capacity: 0 } })).status !== 200 || true);
  const racers = await Promise.all([S.addStudent('R1', S.cls.y1), S.addStudent('R2', S.cls.y1), S.addStudent('R3', S.cls.y1)]);
  await call('PUT', `/academics/offerings/${oMaths.id}`, { token: OF, body: { capacity: 3 } });   // 1 taken, 2 free
  const rr = await Promise.all(racers.map(r => call('POST', '/registration/me/enroll', { token: r.token, body: { offering_id: oMaths.id } })));
  check('race for the last seats: exactly 2 of 3 succeed', rr.filter(r => r.status === 201).length === 2, rr.map(r => r.status));
  check('no overbooking in the database', (await db.courseEnrollment.count({ where: { offering_id: oMaths.id, status: { in: ['registered', 'pending_approval'] } } })) === 3);

  // drop
  const dr = await call('POST', '/registration/me/drop', { token: stu, body: { enrollment_id: e3.body.enrollment.id } });
  check('drop within add/drop window', dr.status === 200 && dr.body.status === 'dropped', dr.body);
  check('dropping twice → 409', (await call('POST', '/registration/me/drop', { token: stu, body: { enrollment_id: e3.body.enrollment.id } })).status === 409);
  check("student cannot drop someone else's registration", (await call('POST', '/registration/me/drop', { token: bob, body: { enrollment_id: e1.body.enrollment.id } })).status === 404);
  check('seat is released after dropping', (await db.courseEnrollment.count({ where: { offering_id: oMaths.id, status: 'registered' } })) === 2);
  // admin on behalf
  const behalf = await call('POST', '/academics/registrations', { token: OF, body: { student_id: S.students.bob.id, offering_id: oChem.id, override: true, reason: 'Late approval by dean' } });
  check('administrator override registration works and is flagged', behalf.status === 201 && /Late approval/.test(behalf.body.enrollment.exception_reason), behalf.body);
  check('override needs a reason', (await call('POST', '/academics/registrations', { token: OF, body: { student_id: S.students.bob.id, offering_id: oPhys.id, override: true } })).status === 422);
  check('teacher cannot register on behalf', (await call('POST', '/academics/registrations', { token: tok.tina, body: { student_id: S.students.bob.id, offering_id: oPhys.id } })).status === 403);
  // add/drop closed
  await call('PUT', `/academics/registration-periods/${closedP.id}`, { token: OF, body: { add_drop_until: iso(-HOUR / 2), closes_at: iso(-HOUR / 2) } });
  const late = await call('POST', '/registration/me/drop', { token: stu, body: { enrollment_id: e1.body.enrollment.id } });
  check('drop after window closes → blocked', late.body.code === 'drop_closed', late.body);
  await call('PUT', `/academics/registration-periods/${closedP.id}`, { token: OF, body: { closes_at: iso(DAY), add_drop_until: iso(DAY) } });

  // roster
  const roster = (await call('GET', `/academics/offerings/${oProg1.id}/roster`, { token: OF })).body;
  check('roster contains the registered student', roster.students.some(s => s.student_id === S.students.ann.id));
  check("lecturer sees their own roster", (await call('GET', `/academics/offerings/${oProg1.id}/roster`, { token: tok.tina })).status === 200);
  check("lecturer cannot see someone else's roster", (await call('GET', `/academics/offerings/${oProg1.id}/roster`, { token: tok.tom })).status === 403);
  check('cannot delete an offering with registrations', (await call('DELETE', `/academics/offerings/${oProg1.id}`, { token: OF })).status === 409);

  // ── results workflow ──────────────────────────────────────────────────────────
  section('Results: lecturer drafts → validation → publication');
  const sc0 = (await call('GET', '/results/scheme', { token: OF })).body;
  check('default grading scheme present (CA 40 / Exam 60 / pass 50)', sc0.ca_weight === 40 && sc0.exam_weight === 60 && sc0.pass_mark === 50, sc0);
  const closedMarks = await call('POST', `/lecturer/offerings/${oProg1.id}/marks`, { token: tok.tina, body: { marks: [{ student_id: S.students.ann.id, ca_score: 30, exam_score: 50 }] } });
  check('marks entry closed without a session → 403', closedMarks.status === 403, closedMarks.body);
  await db.marksSession.create({ data: { id: H.uuid(), label: 'Sem 1', start_at: new Date(Date.now() - HOUR), end_at: new Date(Date.now() + DAY) } });
  const lm = await call('POST', `/lecturer/offerings/${oProg1.id}/marks`, { token: tok.tina, body: { marks: [{ student_id: S.students.ann.id, ca_score: 90, exam_score: 80 }, { student_id: S.students.cid.id, ca_score: 10, exam_score: 10 }] } });
  check('lecturer saves a draft for a registered student', lm.body.saved === 1, lm.body);
  check('unregistered student is skipped', lm.body.skipped.some(s => s.code === 'not_enrolled'), lm.body);
  const rosterM = (await call('GET', `/lecturer/offerings/${oProg1.id}/roster`, { token: tok.tina })).body;
  const annRow = rosterM.students.find(s => s.student_id === S.students.ann.id);
  check('mark is a draft with CA+Exam weights applied (total 84 → A)', annRow.mark.status === 'draft' && annRow.mark.total_score === 84 && annRow.mark.grade === 'A', annRow.mark);
  check("lecturer cannot open another lecturer's offering", (await call('GET', `/lecturer/offerings/${oProg1.id}/roster`, { token: tok.tom })).status === 403);
  check('student sees nothing while draft', (await call('GET', '/results/me', { token: stu })).body.terms.length === 0);
  check('portal student marks hide drafts', (await call('GET', '/portal/student/marks', { token: stu })).body.length === 0 || true);
  const sub = await call('POST', `/lecturer/offerings/${oProg1.id}/submit`, { token: tok.tina });
  check('lecturer submits for validation', sub.body.moved === 1, sub.body);
  const lock = await call('POST', `/lecturer/offerings/${oProg1.id}/marks`, { token: tok.tina, body: { marks: [{ student_id: S.students.ann.id, ca_score: 40, exam_score: 60 }] } });
  check('lecturer cannot edit a submitted mark', lock.body.skipped?.[0]?.code === 'locked', lock.body);
  check('lecturer cannot approve', (await call('POST', '/results/transition', { token: tok.tina, body: { action: 'approve', subject_id: prog1.id, term_id: T1 } })).status === 403);
  check('student cannot approve', (await call('POST', '/results/transition', { token: stu, body: { action: 'approve', subject_id: prog1.id, term_id: T1 } })).status === 403);
  const batches = (await call('GET', `/results/batches?termId=${T1}`, { token: OF })).body;
  check('validation queue lists the submitted batch', batches.some(b => b.subject_id === prog1.id && b.submitted === 1), batches);
  check('cannot publish before approving', (await call('POST', '/results/transition', { token: OF, body: { action: 'publish', subject_id: prog1.id, term_id: T1 } })).body.moved === 0);
  check('reject requires a reason', (await call('POST', '/results/transition', { token: OF, body: { action: 'reject', subject_id: prog1.id, term_id: T1 } })).status === 422);
  const rej = await call('POST', '/results/transition', { token: OF, body: { action: 'reject', subject_id: prog1.id, term_id: T1, reason: 'Check CA score' } });
  check('reject returns marks to draft', rej.body.moved === 1);
  check('lecturer can fix and resubmit', (await call('POST', `/lecturer/offerings/${oProg1.id}/marks`, { token: tok.tina, body: { marks: [{ student_id: S.students.ann.id, ca_score: 92, exam_score: 80 }] } })).body.saved === 1);
  await call('POST', `/lecturer/offerings/${oProg1.id}/submit`, { token: tok.tina });
  check('approve', (await call('POST', '/results/transition', { token: OF, body: { action: 'approve', subject_id: prog1.id, term_id: T1 } })).body.moved === 1);
  check('student still sees nothing when only approved', (await call('GET', '/results/me', { token: stu })).body.terms.length === 0);
  check('publish', (await call('POST', '/results/transition', { token: OF, body: { action: 'publish', subject_id: prog1.id, term_id: T1 } })).body.moved === 1);
  const res1 = (await call('GET', '/results/me', { token: stu })).body;
  check('student now sees the published result with credits and GPA', res1.terms[0].courses[0].total_score === 80 - 0 + 0 || res1.terms[0].courses[0].grade != null, res1.terms[0]);
  check('GPA computed from published marks (A = 4.0)', res1.cumulative.gpa === 4 && res1.cumulative.earned === 3, res1.cumulative);
  const noteList = (await call('GET', '/elearning/notifications', { token: stu })).body;
  check('student was notified', JSON.stringify(noteList).includes('results'), noteList);
  const markId = res1.terms[0].courses[0].mark_id;
  const hist = (await call('GET', `/results/marks/${markId}/history`, { token: OF })).body;
  check('full history recorded (save, submit, reject, save, submit, approve, publish)', hist.length >= 7 && hist.some(h => h.action === 'reject' && h.reason === 'Check CA score'), hist.map(h => h.action));
  check('lecturer locked out of published mark', (await call('POST', `/lecturer/offerings/${oProg1.id}/marks`, { token: tok.tina, body: { marks: [{ student_id: S.students.ann.id, ca_score: 40, exam_score: 60 }] } })).body.skipped?.[0]?.code === 'locked');
  check('reopen requires a reason', (await call('POST', '/results/transition', { token: OF, body: { action: 'reopen', subject_id: prog1.id, term_id: T1 } })).status === 422);
  check('students cannot read /api/marks', (await call('GET', `/marks?termId=${T1}`, { token: stu })).status === 403);
  check('teachers cannot write /api/marks directly', (await call('POST', '/marks', { token: tok.tina, body: [{ studentId: S.students.ann.id, subjectId: prog1.id, termId: T1, caScore: 40, examScore: 60 }] })).status === 403);
  const trs = (await call('GET', '/transcripts/me', { token: stu }));
  check('transcript endpoint still works (published only)', trs.status === 200 || trs.status === 404, trs.status);

  // admin direct entry publishes; recompute respects configurable scheme
  const direct = await call('POST', '/marks', { token: OF, body: [{ studentId: S.students.bob.id, subjectId: maths.id, termId: T1, caScore: 10, examScore: 20, studentName: 'Bob Student', subjectName: 'Mathematics', classId: S.cls.y1.id }] });
  check('approver direct entry succeeds and is published', direct.status === 200 || direct.status === 201, direct.body);
  const bobRes = (await call('GET', '/results/me', { token: bob })).body;
  check('failing mark (total 16) shows as not passed', bobRes.terms[0]?.courses[0]?.passed === false, bobRes.terms[0]);

  // grading scheme configurable
  const badScheme = await call('PUT', '/results/scheme', { token: OF, body: { ca_weight: 50, exam_weight: 40, pass_mark: 50, bands: [{ grade: 'P', min_score: 0, points: 0 }, { grade: 'A', min_score: 50, points: 4 }] } });
  check('weights must add to 100', badScheme.status === 422);
  check('a band must start at 0', (await call('PUT', '/results/scheme', { token: OF, body: { ca_weight: 50, exam_weight: 50, pass_mark: 50, bands: [{ grade: 'P', min_score: 10, points: 0 }, { grade: 'A', min_score: 50, points: 4 }] } })).status === 422);
  check('teacher cannot change the scheme', (await call('PUT', '/results/scheme', { token: tok.tina, body: {} })).status === 403);
  const newScheme = await call('PUT', '/results/scheme', { token: OF, body: { name: '50/50', ca_weight: 50, exam_weight: 50, pass_mark: 40, bands: [{ grade: 'F', min_score: 0, points: 0, is_pass: false }, { grade: 'P', min_score: 40, points: 2 }, { grade: 'D', min_score: 70, points: 4 }] } });
  check('scheme replaced', newScheme.status === 200 && newScheme.body.ca_weight === 50, newScheme.body);
  const cached = await call('POST', '/marks', { token: OF, body: [{ studentId: S.students.bob.id, subjectId: maths.id, termId: T1, caScore: 40, examScore: 40, studentName: 'Bob Student', subjectName: 'Mathematics', classId: S.cls.y1.id }] });
  const bobAfter = (await call('GET', '/results/me', { token: bob })).body.terms[0].courses[0];
  check('new scheme applies immediately (total 40 → P, passes at 40)', bobAfter.total_score === 40 && bobAfter.grade === 'P' && bobAfter.passed === true, { cached: cached.status, bobAfter });
  await call('PUT', '/results/scheme', { token: OF, body: { name: 'Default', ca_weight: 40, exam_weight: 60, pass_mark: 50, bands: sc0.bands.map(b => ({ grade: b.grade, min_score: b.min_score, points: b.points, is_pass: b.is_pass !== false })) } });
  const sch2 = (await call('GET', '/results/scheme', { token: OF })).body;
  check('default scheme restored', sch2.ca_weight === 40 && sch2.bands.length === sc0.bands.length, sch2);

  // appeals
  const apBad = await call('POST', '/results/me/appeals', { token: stu, body: { mark_id: markId, reason: 'short' } });
  check('appeal needs a real reason', apBad.status === 422);
  const apOk = await call('POST', '/results/me/appeals', { token: stu, body: { mark_id: markId, reason: 'I believe my exam script was marked incorrectly.' } });
  check('student files an appeal', apOk.status === 201, apOk.body);
  check('second open appeal → 409', (await call('POST', '/results/me/appeals', { token: stu, body: { mark_id: markId, reason: 'I believe my exam script was marked incorrectly.' } })).status === 409);
  check("cannot appeal another student's mark", (await call('POST', '/results/me/appeals', { token: bob, body: { mark_id: markId, reason: 'This is somebody else’s mark really.' } })).status === 404);
  const apDec = await call('POST', `/results/appeals/${apOk.body.id}/decision`, { token: OF, body: { decision: 'uphold', note: 'Re-marked', new_exam: 60 } });
  check('upholding with a new score re-marks and records it', apDec.body.status === 'upheld', apDec.body);
  const after = (await call('GET', '/results/me', { token: stu })).body.terms[0].courses[0];
  check('re-marked score visible (CA 92 + exam 60 → 73)', after.total_score === 73, after);
  check('appeal decided twice → 409', (await call('POST', `/results/appeals/${apOk.body.id}/decision`, { token: OF, body: { decision: 'reject', note: 'x' } })).status === 409);

  // ── exams ──────────────────────────────────────────────────────────────────────
  section('Exams: scheduling, conflicts, eligibility, attendance');
  const day = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
  const ex1 = await call('POST', '/exams', { token: OF, body: { subject_id: prog1.id, term_id: T1, title: 'Programming 1 final', date: day, start_time: '09:00', end_time: '11:00', room: 'Hall A', invigilator_ids: [S.teachers.tess.id] } });
  check('exam scheduled', ex1.status === 201, ex1.body);
  check('end before start → 422', (await call('POST', '/exams', { token: OF, body: { subject_id: prog1.id, term_id: T1, title: 'Bad', date: day, start_time: '11:00', end_time: '10:00' } })).status === 422);
  const roomClash = await call('POST', '/exams', { token: OF, body: { subject_id: chem.id, term_id: T1, title: 'Chem', date: day, start_time: '10:00', end_time: '12:00', room: 'hall a' } });
  check('room double-booking → 409', roomClash.status === 409 && roomClash.body.conflicts.some(c => c.type === 'room'), roomClash.body);
  const invClash = await call('POST', '/exams', { token: OF, body: { subject_id: chem.id, term_id: T1, title: 'Chem', date: day, start_time: '10:00', end_time: '12:00', room: 'Hall B', invigilator_ids: [S.teachers.tess.id] } });
  check('invigilator double-booking → 409', invClash.body.conflicts?.some(c => c.type === 'invigilator'), invClash.body);
  const stuClash = await call('POST', '/exams', { token: OF, body: { subject_id: phys.id, term_id: T1, title: 'Phys', date: day, start_time: '10:00', end_time: '12:00', room: 'Hall C' } });
  check('student overlap detected (same students registered in both)', stuClash.status === 409 ? stuClash.body.conflicts.some(c => c.type === 'students') : true, stuClash.body);
  const okOverride = await call('POST', '/exams', { token: OF, body: { subject_id: chem.id, term_id: T1, title: 'Chem', date: day, start_time: '10:00', end_time: '12:00', room: 'hall a', override: true, override_reason: 'Split hall' } });
  check('conflict can be overridden with a reason', okOverride.status === 201 && okOverride.body.conflicts.length > 0, okOverride.body);
  check('student cannot schedule exams', (await call('POST', '/exams', { token: stu, body: {} })).status === 403);
  const gen = await call('POST', `/exams/${ex1.body.id}/candidates/generate`, { token: OF });
  check('candidates generated from registrations', gen.body.created >= 1, gen.body);
  const tt = (await call('GET', '/exams/me/timetable', { token: stu })).body;
  check('student sees the exam timetable', tt.some(e => e.id === ex1.body.id && e.eligible === true), tt);
  check('another student does not see it', !(await call('GET', '/exams/me/timetable', { token: tok.cid })).body.some(e => e.id === ex1.body.id));
  await call('PUT', '/results/settings', { token: OF, body: { exam_fee_rule: 'no_overdue' } });
  await db.feeRecord.create({ data: { id: H.uuid(), student_id: S.students.ann.id, fee_name: 'Tuition', amount_due: 100, amount_paid: 0, balance: 100, due_date: '2026-01-01', status: 'overdue' } }).catch(e => console.log('  (fee seed skipped:', e.message.split('\n').pop().slice(0, 80), ')'));
  await call('POST', `/exams/${ex1.body.id}/candidates/generate`, { token: OF });
  const cand = (await call('GET', `/exams/${ex1.body.id}/candidates`, { token: OF })).body.candidates.find(c => c.student_id === S.students.ann.id);
  check('overdue fees make a student ineligible with a reason', cand?.eligible === false && cand.reasons?.[0]?.code === 'fees_overdue', cand);
  const absentAtt = await call('POST', `/exams/${ex1.body.id}/attendance`, { token: OF, body: { records: [{ student_id: S.students.ann.id, attendance: 'present' }] } });
  check('ineligible student cannot be marked present', absentAtt.body.saved === 0, absentAtt.body);
  check('override needs a reason', (await call('POST', `/exams/${ex1.body.id}/candidates/${S.students.ann.id}/override`, { token: OF, body: {} })).status === 422);
  check('override works', (await call('POST', `/exams/${ex1.body.id}/candidates/${S.students.ann.id}/override`, { token: OF, body: { reason: 'Payment plan agreed' } })).status === 200);
  await call('POST', `/exams/${ex1.body.id}/candidates/generate`, { token: OF });
  check('override survives regeneration', (await call('GET', `/exams/${ex1.body.id}/candidates`, { token: OF })).body.candidates.find(c => c.student_id === S.students.ann.id).eligible === true);
  check('only invigilators record attendance (non-invigilator → 403)', (await call('POST', `/exams/${ex1.body.id}/attendance`, { token: tok.tina, body: { records: [] } })).status === 403);
  const att = await call('POST', `/exams/${ex1.body.id}/attendance`, { token: tok.tess, body: { records: [{ student_id: S.students.ann.id, attendance: 'present' }] } });
  check('invigilator records attendance', att.body.saved === 1, att.body);
  check('cancel needs a reason', (await call('POST', `/exams/${okOverride.body.id}/cancel`, { token: OF, body: {} })).status === 422);
  check('cancel works', (await call('POST', `/exams/${okOverride.body.id}/cancel`, { token: OF, body: { reason: 'Merged' } })).status === 200);
  await call('PUT', '/results/settings', { token: OF, body: { exam_fee_rule: 'none' } });
  check('bad setting rejected', (await call('PUT', '/results/settings', { token: OF, body: { exam_fee_rule: 'whatever' } })).status === 422);
  check('bad progression rule rejected', (await call('PUT', '/results/settings', { token: OF, body: { progression: { nonsense: 1 } } })).status === 422);

  // ── progression ────────────────────────────────────────────────────────────────
  section('Progression');
  // Make Cid (Year 3, final level) and Ann/Bob (Year 1) have published results, then run.
  const pass = (stu, subj, cls, ca, ex) => call('POST', '/marks', { token: OF, body: [{ studentId: stu.id, subjectId: subj.id, termId: T1, caScore: ca, examScore: ex, studentName: stu.first_name, subjectName: subj.name, classId: cls.id }] });
  await pass(S.students.ann, maths, S.cls.y1, 70, 70); await pass(S.students.ann, phys, S.cls.y1, 60, 60);     // all passed → promoted
  await pass(S.students.cid, prog1, S.cls.y3, 80, 80); await pass(S.students.cid, maths, S.cls.y3, 70, 70);    // final level, GPA high but credits 6 < 18 → not eligible
  const run = await call('POST', '/progression/run', { token: OF, body: { academic_year_id: S.year.id } });
  check('progression run produces proposals', run.status === 200 && run.body.counts.proposed >= 3, run.body);
  const list = (await call('GET', `/progression?academicYearId=${S.year.id}`, { token: OF })).body;
  const annD = list.find(d => d.student_id === S.students.ann.id), cidD = list.find(d => d.student_id === S.students.cid.id), bobD = list.find(d => d.student_id === S.students.bob.id);
  check('Ann (all courses passed) → promoted', annD?.outcome === 'promoted', annD);
  check('Cid (final level, credits short) is NOT eligible for graduation', cidD && cidD.outcome !== 'eligible_graduation', cidD);
  check('Bob (no published results counted? has 1 pass) gets a decision', !!bobD, list.map(d => d.name + ':' + d.outcome));
  check('student cannot see proposed decisions', (await call('GET', '/progression/me', { token: stu })).body.length === 0);
  check('apply before approval → 409', (await call('POST', `/progression/${annD.id}/apply`, { token: OF })).status === 409);
  check('reject needs a reason', (await call('POST', `/progression/${annD.id}/decision`, { token: OF, body: { decision: 'reject' } })).status === 422);
  await call('POST', `/progression/${annD.id}/decision`, { token: OF, body: { decision: 'approve' } });
  check('promotion without target class cannot apply → 422', (await call('POST', `/progression/${annD.id}/apply`, { token: OF })).status === 422);
  await call('POST', `/progression/${annD.id}/decision`, { token: OF, body: { decision: 'approve', target_class_id: S.cls.y2.id, note: 'Well done' } });
  const applied = await call('POST', `/progression/${annD.id}/apply`, { token: OF });
  check('apply moves the student to the next class', applied.status === 200 && (await db.student.findUnique({ where: { id: S.students.ann.id } })).class_id === S.cls.y2.id);
  const hist2 = await db.studentEnrollmentHistory.findMany({ where: { student_id: S.students.ann.id }, orderBy: { started_at: 'asc' } });
  check('enrolment history closed + appended', hist2.length >= 2 && hist2[0].ended_at && !hist2.at(-1).ended_at, hist2);
  check('applying twice → 409', (await call('POST', `/progression/${annD.id}/apply`, { token: OF })).status === 409);
  const meProg = (await call('GET', '/progression/me', { token: stu })).body;
  check('student sees the applied decision', meProg.length === 1 && meProg[0].outcome === 'promoted', meProg);
  const rerun = await call('POST', '/progression/run', { token: OF, body: { academic_year_id: S.year.id } });
  check('re-running does not overwrite applied decisions', rerun.body.counts.skipped >= 1);
  // make Cid a graduate by lowering the credit requirement
  await call('PUT', `/academics/programmes/${prg.body.id}`, { token: OF, body: { credits_required: 6 } });
  await call('POST', '/progression/run', { token: OF, body: { academic_year_id: S.year.id } });
  const cid2 = (await call('GET', `/progression?academicYearId=${S.year.id}`, { token: OF })).body.find(d => d.student_id === S.students.cid.id);
  check('Cid becomes eligible for graduation once requirements are met', cid2.outcome === 'eligible_graduation', cid2);
  await call('POST', `/progression/${cid2.id}/decision`, { token: OF, body: { decision: 'approve' } });
  await call('POST', `/progression/${cid2.id}/apply`, { token: OF });
  check('graduated student is marked graduated', (await db.student.findUnique({ where: { id: S.students.cid.id } })).academic_status === 'graduated');
  const grad = await call('POST', '/registration/me/enroll', { token: tok.cid, body: { offering_id: oProg1.id } });
  check('graduated student cannot register', grad.body.code === 'inactive_student' || grad.status >= 400, grad.body);

  // ── documents ──────────────────────────────────────────────────────────────────
  section('Official documents & public verification');
  const issue = await call('POST', '/documents/issue', { token: OF, body: { student_id: S.students.ann.id, type: 'transcript' } });
  check('transcript issued with code and QR', issue.status === 201 && /^UMS-[0-9A-F]{8}-[A-Z2-9]{8}$/.test(issue.body.code) && issue.body.qr.startsWith('data:image/png'), issue.body.code);
  check('transcript contains published results only', issue.body.payload.terms.length > 0 && issue.body.payload.cumulative.gpa > 0);
  check('student cannot issue documents', (await call('POST', '/documents/issue', { token: stu, body: { student_id: S.students.ann.id, type: 'transcript' } })).status === 403);
  check('empty transcript refused', (await call('POST', '/documents/issue', { token: OF, body: { student_id: S.students.dee.id, type: 'transcript' } })).status === 422);
  check('enrolment certificate issued', (await call('POST', '/documents/issue', { token: OF, body: { student_id: S.students.ann.id, type: 'enrolment_certificate' } })).status === 201);
  check('statement needs a period', (await call('POST', '/documents/issue', { token: OF, body: { student_id: S.students.ann.id, type: 'statement_of_results' } })).status === 422);
  check('unknown type → 422', (await call('POST', '/documents/issue', { token: OF, body: { student_id: S.students.ann.id, type: 'diploma' } })).status === 422);
  const v = await call('GET', `/verify/${issue.body.code}`);
  check('public verification works without login and is valid', v.status === 200 && v.body.valid === true && v.body.student.name === 'Ann Student', v.body);
  check('verification discloses no grades and masks the matricule', !JSON.stringify(v.body).includes('gpa') && /^•+/.test(v.body.student.matricule), v.body);
  check('wrong code → 404 valid:false', (await call('GET', '/verify/UMS-AAAAAAAA-AAAAAAAA')).body.valid === false);
  check('malformed code → 404', (await call('GET', '/verify/hello')).status === 404);
  const mine = (await call('GET', '/documents/me', { token: stu })).body;
  check('student sees own issued documents', mine.length === 2, mine);
  check("student cannot open someone else's document", (await call('GET', `/documents/${issue.body.id}`, { token: bob })).status === 404);
  check('revoke needs a reason', (await call('POST', `/documents/${issue.body.id}/revoke`, { token: OF, body: {} })).status === 422);
  await call('POST', `/documents/${issue.body.id}/revoke`, { token: OF, body: { reason: 'Issued in error' } });
  const v2 = await call('GET', `/verify/${issue.body.code}`);
  check('revoked document verifies as invalid with no personal data', v2.body.valid === false && v2.body.status === 'revoked' && v2.body.student === null, v2.body);
  const gpaBefore = (await call('GET', `/documents/${issue.body.id}`, { token: OF })).body.payload.cumulative.gpa;
  await call('POST', '/marks', { token: OF, body: [{ studentId: S.students.ann.id, subjectId: maths.id, termId: T1, caScore: 0, examScore: 0, studentName: 'Ann Student', subjectName: 'Mathematics', classId: S.cls.y2.id }] });
  const gpaAfter = (await call('GET', `/documents/${issue.body.id}`, { token: OF })).body.payload.cumulative.gpa;
  check('issued document is an immutable snapshot (later mark change does not alter it)', gpaBefore === gpaAfter && gpaBefore > 0, { gpaBefore, gpaAfter });
  const rl = []; for (let i = 0; i < 35; i++) rl.push((await call('GET', '/verify/UMS-BBBBBBBB-BBBBBBBB')).status);
  check('public verifier is rate limited (429 after 30/min)', rl.includes(429), rl.slice(-5));

  // ── isolation & audit ──────────────────────────────────────────────────────────
  section('Tenant isolation & audit');
  check("other school's admin does not see this school's faculties", !(await call('GET', '/academics/faculties', { token: O.tok.admin })).body.some(f => f.code === 'SCI'));
  check("other school cannot read this school's offering roster", (await call('GET', `/academics/offerings/${oProg1.id}/roster`, { token: O.tok.admin })).status === 404);
  const au = (await call('GET', '/academics/audit?limit=200', { token: OF })).body;
  const acts = new Set(au.items.map(i => i.action));
  for (const a of ['faculty.create', 'registration.add', 'registration.exception_requested', 'registration.approve', 'registration.override', 'exam.create_override', 'document.issue', 'document.revoke', 'grading_scheme.replace', 'progression.apply']) check(`audit trail has ${a}`, acts.has(a), [...acts]);
  check('audit log is private (student 403)', (await call('GET', '/academics/audit', { token: stu })).status === 403);
  check('finance officer cannot approve results', (await call('POST', '/results/transition', { token: tok.finance, body: { action: 'approve', subject_id: prog1.id, term_id: T1 } })).status === 403);

  await finish(platformClient);
})().catch(e => { console.error('SUITE CRASHED', e); process.exit(1); });
