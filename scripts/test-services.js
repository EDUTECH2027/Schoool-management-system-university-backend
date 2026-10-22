// Student services suite: requests, workflow, permissions, isolation, internal-note privacy, document issuing.
// Needs the API running against a LOCAL scratch database (see lib/academic-harness.js).
const H = require('./lib/academic-harness');
const { call, check, section, seedSchool, finish, uuid, platformClient } = H;

(async () => {
  const S = await seedSchool('SvcA'), O = await seedSchool('SvcB');
  const { tok, db } = S;
  const OF = tok.officer, AD = tok.admin, ANN = tok.ann, BOB = tok.bob;
  const mk = (token, over = {}) => call('POST', '/services', { token, body: { type: 'other', subject: 'Need help with my file', description: 'Please look at my situation, thanks.', ...over } });

  section('Meta & creation');
  const meta = await call('GET', '/services/meta', { token: ANN });
  check('meta available to a student', meta.status === 200 && meta.body.types.includes('transcript') && meta.body.sla_days >= 1, meta.body);
  check('meta requires login', (await call('GET', '/services/meta')).status === 401);
  const r1 = await mk(ANN, { type: 'certificate', subject: 'Enrolment certificate', description: 'For my visa', payload: { purpose: 'Visa', evil: { a: 1 } } });
  check('student creates a request → 201', r1.status === 201, r1.body);
  check('reference format SR-YYMM-XXXXXX', /^SR-\d{4}-[A-Z2-9]{6}$/.test(r1.body.reference), r1.body.reference);
  check('starts as submitted', r1.body.status === 'submitted' && r1.body.can_cancel === true);
  check('payload cleaned (object values dropped, strings kept)', r1.body.payload?.purpose === 'Visa' && r1.body.payload.evil === undefined, r1.body.payload);
  const id1 = r1.body.id;
  const r2 = await mk(ANN, {});
  check('references are unique', r2.body.reference !== r1.body.reference);

  section('Validation');
  check('unknown type → 422', (await mk(ANN, { type: 'magic' })).status === 422);
  check('missing subject → 422', (await mk(ANN, { subject: '' })).status === 422);
  check('short subject → 422', (await mk(ANN, { subject: 'ab' })).status === 422);
  check('subject too long → 422', (await mk(ANN, { subject: 'x'.repeat(151) })).status === 422);
  check('description too long → 422', (await mk(ANN, { description: 'x'.repeat(4001) })).status === 422);
  check('complaint needs a real description → 422', (await mk(ANN, { type: 'complaint', description: 'bad' })).status === 422);
  check('leave without start date → 422', (await mk(ANN, { type: 'leave', subject: 'Leave of absence' })).status === 422);
  check('leave with end before start → 422', (await mk(ANN, { type: 'leave', subject: 'Leave of absence', payload: { start_date: '2026-11-10', end_date: '2026-11-01' } })).status === 422);
  check('leave with valid dates → 201', (await mk(ANN, { type: 'leave', subject: 'Leave of absence', payload: { start_date: '2026-11-01', end_date: '2026-12-01' } })).status === 201);
  check('correction without field → 422', (await mk(ANN, { type: 'correction', subject: 'Wrong grade' })).status === 422);
  check('non-string body is rejected', (await call('POST', '/services', { token: ANN, body: { type: 'other', subject: 12345, description: 'x'.repeat(20) } })).status === 422);

  section('Roles & ownership');
  check('teacher cannot create a request', (await mk(tok.tina)).status === 403);
  check('officer cannot create a request', (await mk(OF)).status === 403);
  check('unauthenticated → 401', (await call('POST', '/services', { body: { type: 'other', subject: 'abc' } })).status === 401);
  const mineAnn = await call('GET', '/services/mine', { token: ANN });
  check('student lists own requests', mineAnn.status === 200 && mineAnn.body.length === 3 && mineAnn.body.every(x => x.reference), mineAnn.body.length);
  check('other student sees none of them', (await call('GET', '/services/mine', { token: BOB })).body.length === 0);
  check('other student cannot open the request → 404', (await call('GET', `/services/mine/${id1}`, { token: BOB })).status === 404);
  check('other student cannot comment → 404', (await call('POST', `/services/mine/${id1}/comments`, { token: BOB, body: { body: 'hi there' } })).status === 404);
  check('other student cannot cancel → 404', (await call('POST', `/services/mine/${id1}/cancel`, { token: BOB })).status === 404);
  check('student cannot use the staff queue', (await call('GET', '/services', { token: ANN })).status === 403);
  check('student cannot read staff detail', (await call('GET', `/services/${id1}`, { token: ANN })).status === 403);
  check('student cannot change status', (await call('POST', `/services/${id1}/status`, { token: ANN, body: { to: 'approved' } })).status === 403);
  check('student cannot add internal notes', (await call('POST', `/services/${id1}/notes`, { token: ANN, body: { body: 'secret' } })).status === 403);
  check('student cannot assign', (await call('POST', `/services/${id1}/assign`, { token: ANN, body: { user_id: S.users.officer.id } })).status === 403);
  for (const [n, t] of [['teacher', tok.tina], ['finance', tok.finance]]) {
    check(`${n} cannot see the queue`, (await call('GET', '/services', { token: t })).status === 403);
    check(`${n} cannot read a request`, (await call('GET', `/services/${id1}`, { token: t })).status === 403);
    check(`${n} cannot change status`, (await call('POST', `/services/${id1}/status`, { token: t, body: { to: 'in_review' } })).status === 403);
  }
  check('teacher has no "mine"', (await call('GET', '/services/mine', { token: tok.tina })).status === 403);

  section('Staff queue');
  const q = await call('GET', '/services', { token: OF });
  check('officer sees the queue', q.status === 200 && q.body.total === 3 && q.body.items.length === 3, q.body.total);
  check('queue rows carry student, SLA fields', q.body.items.every(i => i.student && i.matricule && typeof i.age_days === 'number' && i.overdue === false && i.sla_days >= 1));
  check('queue has status counts', q.body.counts.submitted === 3, q.body.counts);
  check('admin sees the queue too', (await call('GET', '/services', { token: AD })).body.total === 3);
  check('filter by type', (await call('GET', '/services?type=certificate', { token: OF })).body.total === 1);
  check('filter by status', (await call('GET', '/services?status=in_review', { token: OF })).body.total === 0);
  check('filter by search (reference)', (await call('GET', `/services?search=${r1.body.reference.slice(8)}`, { token: OF })).body.total === 1);
  check('filter by search (student name)', (await call('GET', '/services?search=ann', { token: OF })).body.total === 3);
  check('filter by search (no match)', (await call('GET', '/services?search=zzzzqq', { token: OF })).body.total === 0);
  check('paging', (await call('GET', '/services?limit=2&page=2', { token: OF })).body.items.length === 1);
  check('assignee=none lists unassigned', (await call('GET', '/services?assignee=none', { token: OF })).body.total === 3);

  section('Assignment');
  check('assign to officer', (await call('POST', `/services/${id1}/assign`, { token: AD, body: { user_id: S.users.officer.id } })).status === 200);
  check('cannot assign to a teacher → 422', (await call('POST', `/services/${id1}/assign`, { token: AD, body: { user_id: S.users.tina.id } })).status === 422);
  check('cannot assign to a student → 422', (await call('POST', `/services/${id1}/assign`, { token: AD, body: { user_id: S.users.ann.id } })).status === 422);
  check('assignee=me filter', (await call('GET', '/services?assignee=me', { token: OF })).body.total === 1);
  check('assignee name in list', (await call('GET', `/services?assignee=${S.users.officer.id}`, { token: AD })).body.items[0].assignee_name === 'Olivia Officer');
  check('staff-users lists staff only', (await call('GET', '/services/staff-users', { token: OF })).body.every(u => ['super_admin', 'academic_officer'].includes(u.role)));
  check('teacher cannot list staff users', (await call('GET', '/services/staff-users', { token: tok.tina })).status === 403);
  check('officer was notified of the assignment', await db.notification.count({ where: { user_id: S.users.officer.id, title: { contains: 'assigned' } } }) >= 1);
  check('unknown request → 404', (await call('GET', `/services/${uuid()}`, { token: OF })).status === 404);

  section('State machine');
  const st = (id, to, note, token = OF) => call('POST', `/services/${id}/status`, { token, body: { to, note } });
  check('unknown status → 422', (await st(id1, 'banana')).status === 422);
  check('submitted → approved is not allowed → 409', (await st(id1, 'approved')).status === 409);
  check('submitted → completed is not allowed → 409', (await st(id1, 'completed')).status === 409);
  check('submitted → in_review', (await st(id1, 'in_review')).status === 200);
  check('awaiting_info needs a note → 422', (await st(id1, 'awaiting_info')).status === 422);
  check('awaiting_info with whitespace note → 422', (await st(id1, 'awaiting_info', '   ')).status === 422);
  check('in_review → awaiting_info with note', (await st(id1, 'awaiting_info', 'Please attach your passport copy')).status === 200);
  check('awaiting_info → approved not allowed → 409', (await st(id1, 'approved')).status === 409);
  const rep = await call('POST', `/services/mine/${id1}/comments`, { token: ANN, body: { body: 'Passport copy attached on my portal.' } });
  check('student reply while awaiting_info → 201 and back to in_review', rep.status === 201 && rep.body.status === 'in_review', rep.body);
  check('staff were notified of the reply', await db.notification.count({ where: { user_id: S.users.officer.id, title: { contains: 'replied' } } }) >= 1);
  check('reject needs a note → 422', (await st(id1, 'rejected')).status === 422);
  const ap = await st(id1, 'approved', 'Looks fine');
  check('in_review → approved', ap.status === 200 && ap.body.status === 'approved', ap.body);
  check('approved cannot be cancelled by the student → 409', (await call('POST', `/services/mine/${id1}/cancel`, { token: ANN })).status === 409);
  check('approved → rejected not allowed → 409', (await st(id1, 'rejected', 'changed my mind')).status === 409);

  section('Document issuing on completion');
  const cp = await st(id1, 'completed', 'Certificate issued');
  check('certificate completion issues an official document', cp.status === 200 && cp.body.document?.code?.startsWith('UMS-'), cp.body);
  const full = await call('GET', `/services/mine/${id1}`, { token: ANN });
  check('student request links the document', full.body.status === 'completed' && !!full.body.document_id, full.body);
  const doc = await call('GET', `/documents/${full.body.document_id}`, { token: ANN });
  check('student opens the issued document', doc.status === 200 && doc.body.type === 'enrolment_certificate' && doc.body.payload.student.matricule === S.students.ann.student_number, doc.body.status);
  check('document recorded for the right student', (await call('GET', '/documents/me', { token: ANN })).body.some(d => d.id === full.body.document_id));
  check('other student cannot open that document', (await call('GET', `/documents/${full.body.document_id}`, { token: BOB })).status === 404);
  check('completed is terminal → 409', (await st(id1, 'in_review')).status === 409);
  check('no comments on a completed request → 409', (await call('POST', `/services/mine/${id1}/comments`, { token: ANN, body: { body: 'one more thing' } })).status === 409);
  check('completing twice does not issue a second document', (await st(id1, 'completed')).status === 409 && await db.officialDocument.count({ where: { student_id: S.students.ann.id } }) === 1);
  check('document issue audited', await db.academicAudit.count({ where: { action: 'document.issue', target_id: full.body.document_id } }) === 1);

  // transcript without published results is refused and leaves the request approved
  const tr = (await mk(ANN, { type: 'transcript', subject: 'Official transcript' })).body;
  await st(tr.id, 'in_review'); await st(tr.id, 'approved');
  const noRes = await st(tr.id, 'completed');
  check('transcript without published results → 422 with a clear message', noRes.status === 422 && /published results/i.test(noRes.body.error), noRes.body);
  check('failed completion leaves the request approved, no document', (await call('GET', `/services/${tr.id}`, { token: OF })).body.status === 'approved' && await db.officialDocument.count({ where: { type: 'transcript' } }) === 0);
  const subj = await db.subject.create({ data: { id: uuid(), name: 'Algorithms', code: 'ALG1', credit_hours: 3 } });
  await db.mark.create({ data: { id: uuid(), student_id: S.students.ann.id, student_name: 'Ann Student', subject_id: subj.id, subject_name: 'Algorithms', term_id: S.t1.id, class_id: S.cls.y1.id, ca_score: 20, exam_score: 60, total_score: 80, grade: 'A', status: 'published' } });
  const okTr = await st(tr.id, 'completed', 'Transcript ready');
  check('transcript with published results is issued', okTr.status === 200 && okTr.body.document?.type === 'transcript', okTr.body);
  const trDoc = await call('GET', `/documents/${okTr.body.document.id}`, { token: ANN });
  check('transcript payload has the course', trDoc.status === 200 && JSON.stringify(trDoc.body.payload.terms).includes('ALG1'));
  // certificate refused for a non-active student
  const sus = await S.addStudent('Sam', S.cls.y1); await db.student.update({ where: { id: sus.s.id }, data: { academic_status: 'suspended' } });
  const sr = (await mk(sus.token, { type: 'certificate', subject: 'Certificate please' })).body;
  await st(sr.id, 'in_review'); await st(sr.id, 'approved');
  const susC = await st(sr.id, 'completed');
  check('certificate for a suspended student is refused with a reason', susC.status === 422 && /suspended/.test(susC.body.error), susC.body);
  // non-document types complete without a document
  const o3 = (await mk(ANN, { subject: 'Plain question here' })).body;
  await st(o3.id, 'in_review'); await st(o3.id, 'approved');
  const o3c = await st(o3.id, 'completed', 'Answered');
  check('"other" completes without a document', o3c.status === 200 && o3c.body.document === null && o3c.body.document_id === null);

  section('Rejection, cancellation, privacy');
  const r4 = (await mk(BOB, { type: 'complaint', subject: 'Noise in the library', description: 'It is very noisy every evening.' })).body;
  check('reject from submitted not allowed → 409', (await st(r4.id, 'rejected', 'no')).status === 409);
  await st(r4.id, 'in_review');
  const note = await call('POST', `/services/${r4.id}/notes`, { token: OF, body: { body: 'INTERNAL: student has a history of complaints' } });
  check('staff adds an internal note', note.status === 201 && note.body.internal === true);
  check('empty internal note → 422', (await call('POST', `/services/${r4.id}/notes`, { token: OF, body: { body: '  ' } })).status === 422);
  check('staff sends a public message', (await call('POST', `/services/${r4.id}/comments`, { token: OF, body: { body: 'We are looking into it.' } })).status === 201);
  await call('POST', `/services/${r4.id}/assign`, { token: AD, body: { user_id: S.users.officer.id } });
  const rej = await st(r4.id, 'rejected', 'Out of scope for this desk');
  check('reject with a note', rej.status === 200 && rej.body.decision_note === 'Out of scope for this desk', rej.body);
  const sv = await call('GET', `/services/mine/${r4.id}`, { token: BOB });
  const dump = JSON.stringify(sv.body);
  check('student timeline hides internal notes', !dump.includes('INTERNAL') && sv.body.events.every(e => e.internal === false), sv.body.events);
  check('student timeline hides assignment events', !sv.body.events.some(e => e.kind === 'assignment') && !dump.includes('Assigned to'));
  check('student view exposes no assignee', sv.body.assigned_to === undefined && sv.body.assignee_name === undefined);
  check('student sees the public message and decision', sv.body.events.some(e => e.body === 'We are looking into it.') && sv.body.events.some(e => e.to_status === 'rejected' && e.body));
  const sl = await call('GET', '/services/mine', { token: BOB });
  check('student list also hides internals', !JSON.stringify(sl.body).includes('INTERNAL') && !JSON.stringify(sl.body).includes(S.users.officer.id));
  const sd = await call('GET', `/services/${r4.id}`, { token: OF });
  check('staff detail shows internal notes', sd.body.events.some(e => e.internal && e.body.startsWith('INTERNAL')) && sd.body.events.some(e => e.kind === 'assignment'));
  check('closed request cannot be assigned → 409', (await call('POST', `/services/${r4.id}/assign`, { token: AD, body: { user_id: S.users.admin.id } })).status === 409);
  check('rejected cannot be cancelled → 409', (await call('POST', `/services/mine/${r4.id}/cancel`, { token: BOB })).status === 409);

  const r5 = (await mk(BOB, { subject: 'To be cancelled soon' })).body;
  const cn = await call('POST', `/services/mine/${r5.id}/cancel`, { token: BOB, body: { note: 'Not needed' } });
  check('student cancels a submitted request', cn.status === 200 && cn.body.status === 'cancelled' && cn.body.closed_at);
  check('cancelled cannot be cancelled again → 409', (await call('POST', `/services/mine/${r5.id}/cancel`, { token: BOB })).status === 409);
  const r6 = (await mk(BOB, { subject: 'Cancel while in review' })).body; await st(r6.id, 'in_review');
  check('student cancels an in_review request', (await call('POST', `/services/mine/${r6.id}/cancel`, { token: BOB })).status === 200);
  const r7 = (await mk(BOB, { subject: 'Staff will cancel this' })).body;
  check('staff cancel needs a note → 422', (await st(r7.id, 'cancelled')).status === 422);
  check('staff can cancel with a note', (await st(r7.id, 'cancelled', 'Duplicate of another request')).status === 200);

  section('Notifications & audit');
  const bobN = await db.notification.findMany({ where: { user_id: S.users.bob.id, type: 'service_update' } });
  check('student notified of staff-visible changes (message, review, rejection…)', bobN.length >= 3 && bobN.every(n => n.link.startsWith('/student/services')), bobN.map(n => n.title));
  check('student not notified of internal notes', !bobN.some(n => /INTERNAL/.test(`${n.title} ${n.body}`)));
  check('staff notified of new requests', await db.notification.count({ where: { user_id: S.users.officer.id, type: 'service_request', title: 'New student request' } }) >= 5);
  check('another student not notified', await db.notification.count({ where: { user_id: S.users.cid.id, type: { in: ['service_update', 'service_request'] } } }) === 0);
  check('transitions audited', await db.academicAudit.count({ where: { target_type: 'service_request', action: { startsWith: 'service.' } } }) >= 10);
  check('audit holds before/after', (await db.academicAudit.findFirst({ where: { target_id: r4.id, action: 'service.rejected' } }))?.after?.status === 'rejected');
  const evs = await db.serviceRequestEvent.findMany({ where: { request_id: id1 }, orderBy: { created_at: 'asc' } });
  check('every transition recorded as an event', ['submitted', 'in_review', 'awaiting_info', 'in_review', 'approved', 'completed'].every((s, i) => evs.filter(e => e.kind === 'status')[i]?.to_status === s), evs.map(e => e.to_status));

  section('Limits, races, SLA');
  const lim = await S.addStudent('Lim', S.cls.y1);
  let last;
  for (let i = 0; i < 10; i++) last = await mk(lim.token, { subject: `Request number ${i}` });
  check('10 open requests are accepted', last.status === 201);
  const over = await mk(lim.token, { subject: 'One too many' });
  check('11th open request → 429', over.status === 429, over.body);
  const lmine = await call('GET', '/services/mine', { token: lim.token });
  await call('POST', `/services/mine/${lmine.body[0].id}/cancel`, { token: lim.token });
  check('after cancelling one, a new one is allowed', (await mk(lim.token, { subject: 'Now it fits' })).status === 201);
  // concurrent transitions: only one wins
  const rc = (await mk(BOB, { subject: 'Race for the review' })).body;
  const race = await Promise.all([st(rc.id, 'in_review'), st(rc.id, 'in_review'), call('POST', `/services/mine/${rc.id}/cancel`, { token: BOB })]);
  // a student may cancel while in review, so "in_review then cancelled" is a legal order: the invariant is that the two identical transitions never both win
  check('concurrent transitions: the two identical in_review calls never both succeed', race.slice(0, 2).filter(r => r.status === 200).length <= 1 && race.every(r => r.status === 200 || r.status === 409), race.map(r => r.status));
  const rcFinal = (await call('GET', '/services/mine', { token: BOB })).body.find(x => x.id === rc.id);
  check('concurrent transitions: the request ends in one consistent state', ['in_review', 'cancelled'].includes(rcFinal?.status) && (race[2].status !== 200 || rcFinal.status === 'cancelled'), rcFinal?.status);
  // concurrent creation: references unique
  const many = await Promise.all(Array.from({ length: 8 }, (_, i) => mk(tok.cid, { subject: `Parallel ${i}` })));
  check('parallel creates: all unique references (up to the open limit)', new Set(many.filter(m => m.status === 201).map(m => m.body.reference)).size === many.filter(m => m.status === 201).length && many.every(m => [201, 429].includes(m.status)));
  // SLA
  const old = (await mk(tok.dee, { subject: 'Old pending request' })).body;
  await db.serviceRequest.update({ where: { id: old.id }, data: { created_at: new Date(Date.now() - 9 * 86_400_000) } });
  const qs = await call('GET', '/services?overdue=1', { token: OF });
  check('overdue filter returns the old request', qs.body.total === 1 && qs.body.items[0].id === old.id && qs.body.items[0].overdue === true && qs.body.items[0].age_days >= 9, qs.body.items?.[0]);
  const aw = (await mk(tok.dee, { subject: 'Old but waiting on student' })).body;
  await st(aw.id, 'in_review'); await st(aw.id, 'awaiting_info', 'Need a document');
  await db.serviceRequest.update({ where: { id: aw.id }, data: { created_at: new Date(Date.now() - 9 * 86_400_000) } });
  check('awaiting_info is not counted overdue (waiting on the student)', (await call('GET', '/services?overdue=1', { token: OF })).body.total === 1);

  section('Tenant isolation');
  const oAnn = O.tok.ann;
  check('other school cannot see these requests', (await call('GET', `/services/${id1}`, { token: O.tok.officer })).status === 404);
  check('other school queue is empty', (await call('GET', '/services', { token: O.tok.officer })).body.total === 0);
  check('other school student cannot open them', (await call('GET', `/services/mine/${id1}`, { token: oAnn })).status === 404);
  const oc = await mk(oAnn, {});
  check('other school can create its own', oc.status === 201 && (await call('GET', '/services', { token: OF })).body.items.every(i => i.id !== oc.body.id));
  check('other school cannot change our request', (await call('POST', `/services/${old.id}/status`, { token: O.tok.admin, body: { to: 'in_review' } })).status === 404);

  await finish(platformClient);
})().catch(e => { console.error(e); process.exit(1); });
