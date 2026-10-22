// Library module suite: catalogue, permissions per role, loans/fines math, reservations queue, concurrency, isolation.
// Needs the API running against the LOCAL scratch database (see lib/academic-harness.js).
const H = require('./lib/academic-harness');
const { call, check, section, seedSchool, finish, DAY } = H;

(async () => {
  const S = await seedSchool('LibA'), O = await seedSchool('LibB');
  const { tok, db } = S;
  const libU = await S.mkU('Lucy Librarian', 'librarian'); const LIB = H.mkToken(S.schoolId, libU);
  const parentU = await S.mkU('Pat Parent', 'parent'); const PAR = H.mkToken(S.schoolId, parentU);
  const A = tok.admin, OF = tok.officer, ANN = tok.ann, BOB = tok.bob, CID = tok.cid, DEE = tok.dee, TINA = tok.tina, FIN = tok.finance;
  const ann = S.students.ann, bob = S.students.bob, cid = S.students.cid, dee = S.students.dee;
  const mk = async (body, token = LIB) => (await call('POST', '/library/items', { token, body })).body;

  // ── items: permissions & validation ──────────────────────────────────────────
  section('Catalogue CRUD & permissions');
  const algo = await call('POST', '/library/items', { token: LIB, body: { title: 'Introduction to Algorithms', authors: 'Cormen; Leiserson', isbn: '978-0-262-03384-8', publisher: 'MIT Press', year: 2009, category: 'Computer Science', kind: 'book', location: 'A1-03', copies_total: 2 } });
  check('librarian creates an item', algo.status === 201 && algo.body.isbn === '9780262033848' && algo.body.copies_total === 2, algo);
  check('admin creates an item', (await call('POST', '/library/items', { token: A, body: { title: 'Operating Systems', category: 'Computer Science', copies_total: 1 } })).status === 201);
  check('academic officer creates an item', (await call('POST', '/library/items', { token: OF, body: { title: 'Calculus', authors: 'Stewart', category: 'Mathematics', copies_total: 3 } })).status === 201);
  check('student cannot create an item', (await call('POST', '/library/items', { token: ANN, body: { title: 'X' } })).status === 403);
  check('teacher cannot create an item', (await call('POST', '/library/items', { token: TINA, body: { title: 'X' } })).status === 403);
  check('finance officer has no library access', (await call('GET', '/library/items', { token: FIN })).status === 403);
  check('parent has no library access', (await call('GET', '/library/items', { token: PAR })).status === 403);
  check('anonymous → 401', (await call('GET', '/library/items')).status === 401);
  check('title required', (await call('POST', '/library/items', { token: LIB, body: { title: '  ' } })).status === 422);
  check('bad kind rejected', (await call('POST', '/library/items', { token: LIB, body: { title: 'T', kind: 'dvd' } })).status === 422);
  check('negative copies rejected', (await call('POST', '/library/items', { token: LIB, body: { title: 'T', copies_total: -1 } })).status === 422);
  check('bad ISBN rejected', (await call('POST', '/library/items', { token: LIB, body: { title: 'T', isbn: '12345' } })).status === 422);
  check('bad year rejected', (await call('POST', '/library/items', { token: LIB, body: { title: 'T', year: 20 } })).status === 422);
  check('bad digital_url rejected', (await call('POST', '/library/items', { token: LIB, body: { title: 'T', kind: 'digital', digital_url: 'javascript:alert(1)' } })).status === 422);
  const dup = await call('POST', '/library/items', { token: LIB, body: { title: 'Algorithms 2nd copy record', isbn: '9780262033848' } });
  check('duplicate ISBN is a warning, not an error', dup.status === 201 && dup.body.warnings?.[0]?.code === 'duplicate_isbn', dup.body);
  await call('DELETE', `/library/items/${dup.body.id}`, { token: LIB });
  const ebook = await mk({ title: 'Open Networks (e-book)', kind: 'digital', digital_url: 'https://example.org/book.pdf', copies_total: 1, category: 'Networks' });
  check('digital item with URL', ebook.kind === 'digital' && ebook.digital_url === 'https://example.org/book.pdf', ebook);
  const calc = (await call('GET', '/library/items?title=calculus', { token: LIB })).body.items[0];
  const os = (await call('GET', '/library/items?title=operating', { token: LIB })).body.items[0];
  const upd = await call('PUT', `/library/items/${algo.body.id}`, { token: LIB, body: { location: 'A1-04' } });
  check('partial update keeps other fields', upd.status === 200 && upd.body.location === 'A1-04' && upd.body.title === 'Introduction to Algorithms');
  check('student cannot update', (await call('PUT', `/library/items/${algo.body.id}`, { token: ANN, body: { location: 'x' } })).status === 403);
  check('update unknown → 404', (await call('PUT', '/library/items/nope', { token: LIB, body: { location: 'x' } })).status === 404);
  const audits = await db.academicAudit.count({ where: { action: 'library.item.create' } });
  check('item creation audited', audits >= 3, audits);

  // ── search ──────────────────────────────────────────────────────────────────
  section('Search, filters, pagination');
  for (let i = 1; i <= 25; i++) await mk({ title: `Filler volume ${String(i).padStart(2, '0')}`, authors: 'Anon Writer', category: 'Filler', copies_total: 1 });
  const p1 = (await call('GET', '/library/items?category=Filler&limit=10&page=1', { token: ANN })).body;
  const p3 = (await call('GET', '/library/items?category=Filler&limit=10&page=3', { token: ANN })).body;
  check('pagination total/limit', p1.total === 25 && p1.items.length === 10 && p3.items.length === 5, [p1.total, p1.items.length, p3.items.length]);
  check('search by title', (await call('GET', '/library/items?title=algorithms', { token: ANN })).body.items.some(i => i.id === algo.body.id));
  check('search by author', (await call('GET', '/library/items?author=stewart', { token: ANN })).body.items.some(i => i.id === calc.id));
  check('search by ISBN (hyphenated input)', (await call('GET', '/library/items?isbn=978-0-262', { token: ANN })).body.items.some(i => i.id === algo.body.id));
  check('free-text q', (await call('GET', '/library/items?q=cormen', { token: TINA })).body.items.length === 1);
  check('filter kind=digital', (await call('GET', '/library/items?kind=digital', { token: ANN })).body.items.every(i => i.kind === 'digital'));
  check('teachers can browse', (await call('GET', '/library/items', { token: TINA })).status === 200);
  const hidden = await mk({ title: 'Hidden Archive', copies_total: 1 });
  await call('PUT', `/library/items/${hidden.id}`, { token: LIB, body: { is_active: false } });
  check('inactive items hidden from students', (await call('GET', '/library/items?title=hidden', { token: ANN })).body.total === 0 && (await call('GET', `/library/items/${hidden.id}`, { token: ANN })).status === 404);
  check('inactive items visible to staff', (await call('GET', '/library/items?title=hidden', { token: LIB })).body.total === 1);
  check('categories list', (await call('GET', '/library/categories', { token: ANN })).body.includes('Mathematics'));

  // ── issue rules ─────────────────────────────────────────────────────────────
  section('Issuing loans');
  const st = (await call('GET', '/library/settings', { token: ANN })).body;
  check('default settings (14 days, 3 loans, 2 renewals)', st.loan_days === 14 && st.max_loans === 3 && st.max_renewals === 2 && st.block_on_fines === true, st);
  const issueBody = (item, who) => ({ item_id: item.id ?? item, ...(typeof who === 'string' && who.startsWith('U-') ? { matricule: who } : { student_id: who.id }) });
  const l1 = await call('POST', '/library/loans', { token: LIB, body: issueBody(algo.body, ann) });
  check('issue by student id', l1.status === 201 && l1.body.status === 'active' && l1.body.student_id === ann.id, l1);
  const dueDays = Math.round((new Date(l1.body.due_at) - Date.now()) / DAY);
  check('due date = loan_days from settings', dueDays === 14, dueDays);
  const l2 = await call('POST', '/library/loans', { token: LIB, body: issueBody(algo.body, bob.student_number) });
  check('issue by matricule', l2.status === 201 && l2.body.matricule === bob.student_number, l2);
  const noCopy = await call('POST', '/library/loans', { token: LIB, body: issueBody(algo.body, cid) });
  check('no copy left → 409 unavailable', noCopy.status === 409 && noCopy.body.code === 'unavailable', noCopy);
  check('same item twice to the same student → 409', (await call('POST', '/library/loans', { token: LIB, body: issueBody(calc, ann) })).status === 201 && (await call('POST', '/library/loans', { token: LIB, body: issueBody(calc, ann) })).body.code === 'already_holding');
  check('issue needs staff', (await call('POST', '/library/loans', { token: ANN, body: issueBody(os, ann) })).status === 403);
  check('unknown matricule → 404', (await call('POST', '/library/loans', { token: LIB, body: { item_id: os.id, matricule: 'NOPE' } })).status === 404);
  check('missing item_id → 422', (await call('POST', '/library/loans', { token: LIB, body: { matricule: ann.student_number } })).status === 422);
  check('missing student → 422', (await call('POST', '/library/loans', { token: LIB, body: { item_id: os.id } })).status === 422);
  check('inactive item cannot be issued', (await call('POST', '/library/loans', { token: LIB, body: issueBody(hidden, dee) })).body.code === 'inactive');
  check('digital item cannot be loaned', (await call('POST', '/library/loans', { token: LIB, body: issueBody(ebook, dee) })).body.code === 'digital');
  const past = await call('POST', '/library/loans', { token: LIB, body: { ...issueBody(os, dee), due_at: new Date(Date.now() - DAY).toISOString() } });
  check('due_at in the past rejected', past.status === 422);
  await db.student.update({ where: { id: dee.id }, data: { is_active: false } });
  check('inactive student cannot borrow', (await call('POST', '/library/loans', { token: LIB, body: issueBody(os, dee) })).body.code === 'student_inactive');
  await db.student.update({ where: { id: dee.id }, data: { is_active: true } });
  const fillers = (await call('GET', '/library/items?category=Filler&limit=5', { token: LIB })).body.items;
  await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[0], ann) });         // Ann: algo, calc, filler = 3
  const max = await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[1], ann) });
  check('max_loans enforced', max.status === 409 && max.body.code === 'max_loans', max);
  const stuLoans = (await call('GET', '/library/me', { token: ANN })).body;
  check('/me shows 3 active loans with days_left', stuLoans.loans.length === 3 && stuLoans.loans.every(l => l.days_left >= 13), stuLoans.loans.map(l => l.days_left));
  check('/me is student-only', (await call('GET', '/library/me', { token: LIB })).status === 403);
  check('/me isolation: Bob sees only his', (await call('GET', '/library/me', { token: BOB })).body.loans.every(l => l.student_id === bob.id));
  const lk = await call('GET', `/library/student-lookup?matricule=${ann.student_number}`, { token: LIB });
  check('student lookup', lk.status === 200 && lk.body.active_loans === 3 && lk.body.max_loans === 3 && lk.body.blocked === false, lk.body);
  check('student lookup staff-only', (await call('GET', `/library/student-lookup?matricule=${ann.student_number}`, { token: ANN })).status === 403);

  // ── returns & fines math ────────────────────────────────────────────────────
  section('Returns, fines (date manipulation)');
  const back = async (loanId, daysAgo, hoursExtra = 2) => db.libraryLoan.update({ where: { id: loanId }, data: { due_at: new Date(Date.now() - daysAgo * DAY - hoursExtra * 3_600_000) } });
  const lok = await call('GET', '/library/loans?status=active&student_id=' + ann.id, { token: LIB });
  const annCalc = lok.body.items.find(l => l.title === 'Calculus'), annFill = lok.body.items.find(l => l.title.startsWith('Filler'));
  const r0 = await call('POST', `/library/loans/${annFill.id}/return`, { token: LIB });
  check('on-time return: no fine, status returned', r0.status === 200 && r0.body.status === 'returned' && r0.body.fine_amount === 0 && r0.body.returned_at, r0.body);
  check('double return → 409', (await call('POST', `/library/loans/${annFill.id}/return`, { token: LIB })).status === 409);
  await back(annCalc.id, 5);
  const od = await call('GET', '/library/overdue', { token: LIB });
  const odRow = od.body.items.find(l => l.id === annCalc.id);
  check('overdue report lists it with 5 days and accrued 500', odRow && odRow.overdue_days === 5 && odRow.accrued_fine === 500, odRow);
  check('overdue report: staff only', (await call('GET', '/library/overdue', { token: ANN })).status === 403);
  check('overdue loan cannot be renewed', (await call('POST', `/library/loans/${annCalc.id}/renew`, { token: ANN })).body.code === 'overdue');
  const r1 = await call('POST', `/library/loans/${annCalc.id}/return`, { token: LIB });
  check('late return: fine = 5 days × 100', r1.body.fine_amount === 500 && r1.body.fine_open === true, r1.body);
  check('fine stored in DB', (await db.libraryLoan.findUnique({ where: { id: annCalc.id } })).fine_amount === 500);
  const annMe = (await call('GET', '/library/me', { token: ANN })).body;
  check('/me fines_total = 500 and lists the fine', annMe.fines_unpaid === 500 && annMe.fines.length === 1, annMe);
  const blocked = await call('POST', '/library/loans', { token: LIB, body: issueBody(os, ann) });
  check('unpaid fine blocks a new loan', blocked.status === 409 && blocked.body.code === 'unpaid_fines', blocked);
  check('lookup reports blocked', (await call('GET', `/library/student-lookup?matricule=${ann.student_number}`, { token: LIB })).body.blocked === true);
  await call('PUT', '/library/settings', { token: LIB, body: { block_on_fines: false } });
  const unblocked = await call('POST', '/library/loans', { token: LIB, body: issueBody(os, ann) });
  check('block_on_fines=false lets the loan through', unblocked.status === 201, unblocked.body);
  await call('POST', `/library/loans/${unblocked.body.id}/return`, { token: LIB });
  await call('PUT', '/library/settings', { token: LIB, body: { block_on_fines: true } });
  check('student cannot pay fines', (await call('POST', `/library/loans/${annCalc.id}/fine/pay`, { token: ANN })).status === 403);
  check('waive needs a reason', (await call('POST', `/library/loans/${annCalc.id}/fine/waive`, { token: LIB, body: {} })).status === 422);
  const pay = await call('POST', `/library/loans/${annCalc.id}/fine/pay`, { token: LIB });
  check('fine marked paid', pay.status === 200 && pay.body.fine_paid === true && pay.body.fine_open === false, pay.body);
  check('paying twice → 409', (await call('POST', `/library/loans/${annCalc.id}/fine/pay`, { token: LIB })).status === 409);
  const afterPay = await call('POST', '/library/loans', { token: LIB, body: issueBody(os, ann) });
  check('paid fine no longer blocks', afterPay.status === 201);
  await call('POST', `/library/loans/${afterPay.body.id}/return`, { token: LIB });
  // Bob: 3 days late with a waived fine
  const bobLoan = l2.body;
  await back(bobLoan.id, 3);
  const rb = await call('POST', `/library/loans/${bobLoan.id}/return`, { token: LIB });
  check('3 days late = 300', rb.body.fine_amount === 300, rb.body);
  const wv = await call('POST', `/library/loans/${bobLoan.id}/fine/waive`, { token: OF, body: { reason: 'Hospitalised' } });
  check('officer waives fine with reason', wv.status === 200 && wv.body.fine_waived === true && wv.body.fine_open === false, wv.body);
  const wAudit = await db.academicAudit.findFirst({ where: { action: 'library.loan.fine.waive', target_id: bobLoan.id } });
  check('waive audited with reason', wAudit?.reason === 'Hospitalised' && wAudit.actor_role === 'academic_officer', wAudit);
  check('fines list: unpaid/paid/waived filters', (await call('GET', '/library/fines?status=waived', { token: LIB })).body.items.length === 1 && (await call('GET', '/library/fines?status=paid', { token: LIB })).body.items.length === 1 && (await call('GET', '/library/fines?status=unpaid', { token: LIB })).body.total === 0);
  check('fines list is staff-only', (await call('GET', '/library/fines', { token: TINA })).status === 403);
  await call('PUT', '/library/settings', { token: A, body: { fine_per_day: 250.5 } });
  const l3 = (await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[2], bob) })).body;
  await back(l3.id, 2);
  check('fine uses the current fine_per_day', (await call('POST', `/library/loans/${l3.id}/return`, { token: LIB })).body.fine_amount === 501, null);
  await call('PUT', '/library/settings', { token: A, body: { fine_per_day: 100 } });
  const l4 = (await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[3], cid) })).body;
  const swift = await call('POST', `/library/loans/${l4.id}/return`, { token: LIB });
  check('returning < 1 day late costs nothing (full days only)', swift.body.fine_amount === 0);
  await db.libraryLoan.update({ where: { id: l3.id }, data: { fine_paid: true } });

  // ── renewals ────────────────────────────────────────────────────────────────
  section('Renewals');
  const rn = (await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[4], cid) })).body;
  const rn1 = await call('POST', `/library/loans/${rn.id}/renew`, { token: CID });
  check('student renews own loan (+14 days)', rn1.status === 200 && rn1.body.renewals === 1 && Math.round((new Date(rn1.body.due_at) - new Date(rn.due_at)) / DAY) === 14, rn1.body);
  check('another student cannot renew it', (await call('POST', `/library/loans/${rn.id}/renew`, { token: BOB })).status === 404);
  check('teacher cannot renew', (await call('POST', `/library/loans/${rn.id}/renew`, { token: TINA })).status === 403);
  check('second renewal OK', (await call('POST', `/library/loans/${rn.id}/renew`, { token: LIB })).body.renewals === 2);
  const rn3 = await call('POST', `/library/loans/${rn.id}/renew`, { token: CID });
  check('max_renewals enforced', rn3.status === 409 && rn3.body.code === 'max_renewals', rn3.body);
  const rn2 = (await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[0], cid) })).body;
  const resvF = await call('POST', '/library/reservations', { token: BOB, body: { item_id: fillers[0].id } });
  check('Bob reserves the (unavailable) filler', resvF.status === 201 && resvF.body.status === 'waiting', resvF);
  const rnBlocked = await call('POST', `/library/loans/${rn2.id}/renew`, { token: CID });
  check('renew refused while another student waits', rnBlocked.status === 409 && rnBlocked.body.code === 'reserved', rnBlocked.body);

  // ── reservations queue ─────────────────────────────────────────────────────
  section('Reservation queue (FIFO), ready + expiry, notifications');
  check('reserve own duplicate → 409', (await call('POST', '/library/reservations', { token: BOB, body: { item_id: fillers[0].id } })).body.code === 'duplicate');
  check('cannot reserve an available item', (await call('POST', '/library/reservations', { token: DEE, body: { item_id: fillers[3].id } })).body.code === 'available');
  check('cannot reserve what you already hold', (await call('POST', '/library/reservations', { token: CID, body: { item_id: fillers[0].id } })).body.code === 'already_holding');
  const resvD = await call('POST', '/library/reservations', { token: DEE, body: { item_id: fillers[0].id } });
  check('Dee queues behind Bob', resvD.status === 201);
  const queue = (await call('GET', '/library/reservations', { token: LIB })).body.filter(r => r.item_id === fillers[0].id);
  check('staff queue positions 1,2', queue.map(r => r.position).join() === '1,2' && queue[0].student_id === bob.id, queue);
  check('students cannot list all reservations', (await call('GET', '/library/reservations', { token: ANN })).status === 403);
  check('reserve unknown item → 404', (await call('POST', '/library/reservations', { token: BOB, body: { item_id: 'nope' } })).status === 404);
  const bobMe = (await call('GET', '/library/me', { token: BOB })).body;
  check('/me shows queue position', bobMe.reservations[0].position === 1 && (await call('GET', '/library/me', { token: DEE })).body.reservations[0].position === 2);
  check('student cancels only own reservation', (await call('POST', `/library/reservations/${resvD.body.id}/cancel`, { token: BOB })).status === 404);
  await call('POST', `/library/loans/${rn2.id}/return`, { token: LIB });
  const rb2 = (await call('GET', '/library/reservations?status=ready', { token: LIB })).body;
  check('return promotes the first waiting reservation to ready', rb2.length === 1 && rb2[0].student_id === bob.id && rb2[0].expires_at, rb2);
  const note = await db.notification.findFirst({ where: { user_id: S.users.bob.id, type: 'library' } });
  check('Bob notified (in-app)', !!note && /ready/i.test(note.title), note);
  check('no notification for Dee yet', (await db.notification.count({ where: { user_id: S.users.dee.id, type: 'library' } })) === 0);
  const sneak = await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[0], dee) });
  check('copy held for Bob: Dee cannot take it', sneak.status === 409, sneak.body);
  check('shown unavailable while held', (await call('GET', `/library/items/${fillers[0].id}`, { token: ANN })).body.available === 0);
  check('item flagged for the student in catalogue', (await call('GET', '/library/items?title=Filler volume', { token: BOB })).body.items.find(i => i.id === fillers[0].id).my_reservation.status === 'ready');
  const bl = await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[0], bob) });
  check('Bob collects it: loan issued', bl.status === 201);
  check('reservation fulfilled', (await db.libraryReservation.findUnique({ where: { id: resvF.body.id } })).status === 'fulfilled');
  // expiry: Dee next in line, copy returns, goes ready, then expires
  await call('POST', `/library/loans/${bl.body.id}/return`, { token: LIB });
  check('Dee is now ready', (await db.libraryReservation.findUnique({ where: { id: resvD.body.id } })).status === 'ready');
  const eve = await S.addStudent('Eve', S.cls.y1);
  const resvE = await call('POST', '/library/reservations', { token: eve.token, body: { item_id: fillers[0].id } });
  check('Eve queues (item held for Dee)', resvE.status === 201 && resvE.body.status === 'waiting', resvE.body);
  await db.libraryReservation.update({ where: { id: resvD.body.id }, data: { notified_at: new Date(Date.now() - 4 * DAY) } });
  const sw = await call('POST', '/library/sweep', { token: LIB });
  check('sweep expires stale ready reservations', sw.body.expired === 1, sw.body);
  check('Dee expired, Eve promoted', (await db.libraryReservation.findUnique({ where: { id: resvD.body.id } })).status === 'expired' && (await db.libraryReservation.findUnique({ where: { id: resvE.body.id } })).status === 'ready');
  check('Dee told it expired', (await db.notification.count({ where: { user_id: S.users.dee.id, title: { contains: 'expired' } } })) === 1);
  // lazy expiry on access
  await db.libraryReservation.update({ where: { id: resvE.body.id }, data: { notified_at: new Date(Date.now() - 4 * DAY) } });
  await call('GET', '/library/items', { token: ANN });
  check('expiry is also applied lazily on access', (await db.libraryReservation.findUnique({ where: { id: resvE.body.id } })).status === 'expired');
  // cancel of a ready hold frees the copy for the next student
  const fx = await mk({ title: 'Single copy', copies_total: 1 });
  await call('POST', '/library/loans', { token: LIB, body: issueBody(fx, ann) });
  const q1 = (await call('POST', '/library/reservations', { token: BOB, body: { item_id: fx.id } })).body, q2 = (await call('POST', '/library/reservations', { token: CID, body: { item_id: fx.id } })).body;
  const annFx = (await call('GET', '/library/loans?status=active&item_id=' + fx.id, { token: LIB })).body.items[0];
  await call('POST', `/library/loans/${annFx.id}/return`, { token: LIB });
  await call('POST', `/library/reservations/${q1.id}/cancel`, { token: BOB });
  check('cancelling a ready hold promotes the next one', (await db.libraryReservation.findUnique({ where: { id: q1.id } })).status === 'cancelled' && (await db.libraryReservation.findUnique({ where: { id: q2.id } })).status === 'ready');
  check('cancelling twice → 409', (await call('POST', `/library/reservations/${q1.id}/cancel`, { token: BOB })).status === 409);
  check('queue order respected: Bob (cancelled) skipped, Dee cannot jump Cid', (await call('POST', '/library/loans', { token: LIB, body: issueBody(fx, dee) })).status === 409);
  check('staff cancels a reservation (audited)', (await call('POST', `/library/reservations/${q2.id}/cancel`, { token: LIB })).status === 200 && (await db.academicAudit.count({ where: { action: 'library.reservation.cancel' } })) === 1);

  // ── lost ────────────────────────────────────────────────────────────────────
  section('Lost items');
  const lostItem = await mk({ title: 'Lost Causes', copies_total: 2 });
  const ll = (await call('POST', '/library/loans', { token: LIB, body: issueBody(lostItem, cid) })).body;
  await back(ll.id, 4);
  const lost = await call('POST', `/library/loans/${ll.id}/lost`, { token: LIB, body: { fine_amount: 8000 } });
  check('lost loan: replacement fine stored', lost.status === 200 && lost.body.status === 'lost' && lost.body.fine_amount === 8000, lost.body);
  const lItem = (await call('GET', `/library/items/${lostItem.id}`, { token: LIB })).body;
  check('lost copy leaves circulation (1 of 2 left)', lItem.available === 1 && lItem.lost_copies === 1, lItem);
  const ll2 = (await call('POST', '/library/loans', { token: LIB, body: issueBody(lostItem, bob) })).body;
  await back(ll2.id, 4);
  const lost2 = await call('POST', `/library/loans/${ll2.id}/lost`, { token: LIB, body: {} });
  check('lost without amount: accrued overdue fine (4 × 100)', lost2.body.fine_amount === 400, lost2.body);
  check('lost twice → 409', (await call('POST', `/library/loans/${ll.id}/lost`, { token: LIB })).status === 409);
  check('cannot cut copies below on-loan/lost', (await call('PUT', `/library/items/${lostItem.id}`, { token: LIB, body: { copies_total: 1 } })).status === 409);
  check('raising copies_total adds stock', (await call('PUT', `/library/items/${lostItem.id}`, { token: LIB, body: { copies_total: 3 } })).status === 200 && (await call('GET', `/library/items/${lostItem.id}`, { token: LIB })).body.available === 1);
  check('item with history cannot be deleted', (await call('DELETE', `/library/items/${lostItem.id}`, { token: LIB })).status === 409);
  check('item without history can be deleted', (await call('DELETE', `/library/items/${ebook.id}`, { token: LIB })).status === 204);
  check('available-only filter hides exhausted items', (await call('GET', '/library/items?available=true&title=Single copy', { token: ANN })).body.total === 1 && (await call('GET', `/library/items?available=true&title=Introduction to Algorithms`, { token: ANN })).body.total === 1);

  // ── settings ────────────────────────────────────────────────────────────────
  section('Settings');
  check('students cannot change settings', (await call('PUT', '/library/settings', { token: ANN, body: { loan_days: 1 } })).status === 403);
  check('invalid loan_days rejected', (await call('PUT', '/library/settings', { token: LIB, body: { loan_days: 0 } })).status === 422);
  check('negative fine rejected', (await call('PUT', '/library/settings', { token: LIB, body: { fine_per_day: -5 } })).status === 422);
  await call('PUT', '/library/settings', { token: LIB, body: { loan_days: 7, max_loans: 1 } });
  const short = await call('POST', '/library/loans', { token: LIB, body: issueBody(os, dee) });
  check('new loan_days applies (7)', Math.round((new Date(short.body.due_at) - Date.now()) / DAY) === 7);
  check('new max_loans applies (1)', (await call('POST', '/library/loans', { token: LIB, body: issueBody(fillers[1], dee) })).body.code === 'max_loans');
  await call('PUT', '/library/settings', { token: LIB, body: { loan_days: 14, max_loans: 3 } });
  check('settings change audited', (await db.academicAudit.count({ where: { action: 'library.settings' } })) >= 4);
  const stats = await call('GET', '/library/stats', { token: LIB });
  check('stats endpoint', stats.status === 200 && stats.body.active_loans >= 1 && typeof stats.body.unpaid_fines === 'number', stats.body);

  // ── concurrency ─────────────────────────────────────────────────────────────
  section('Concurrency: last copy');
  const last = await mk({ title: 'Last Copy Race', copies_total: 1 });
  const racers = [];
  for (let i = 0; i < 4; i++) racers.push(await S.mkS(`Racer${i}`, S.cls.y1));
  const results = await Promise.all(racers.map(s => call('POST', '/library/loans', { token: LIB, body: { item_id: last.id, student_id: s.id } })));
  const won = results.filter(r => r.status === 201).length, lostRace = results.filter(r => r.status === 409).length;
  check('exactly one of 4 simultaneous issues succeeds', won === 1 && lostRace === 3, results.map(r => r.status));
  check('DB agrees: one active loan', (await db.libraryLoan.count({ where: { item_id: last.id, status: 'active' } })) === 1);
  // same student, two simultaneous different items with max_loans = 1
  await call('PUT', '/library/settings', { token: LIB, body: { max_loans: 1 } });
  const x1 = await mk({ title: 'Race X1' }), x2 = await mk({ title: 'Race X2' });
  const fresh = await S.mkS('Fresh', S.cls.y1);
  const dbl = await Promise.all([x1, x2].map(it => call('POST', '/library/loans', { token: LIB, body: { item_id: it.id, student_id: fresh.id } })));
  check('max_loans cannot be bypassed by parallel issues', dbl.filter(r => r.status === 201).length === 1, dbl.map(r => r.status));
  // parallel returns of the same loan
  await call('PUT', '/library/settings', { token: LIB, body: { max_loans: 3 } });
  const dl = (await call('GET', '/library/loans?status=active&student_id=' + fresh.id, { token: LIB })).body.items[0];
  const rets = await Promise.all([1, 2, 3].map(() => call('POST', `/library/loans/${dl.id}/return`, { token: LIB })));
  check('parallel returns: exactly one succeeds', rets.filter(r => r.status === 200).length === 1, rets.map(r => r.status));
  // reservation promotion race: copy returns while two students waiting
  const rr = await mk({ title: 'Promotion Race', copies_total: 1 });
  const holder = (await call('POST', '/library/loans', { token: LIB, body: { item_id: rr.id, student_id: ann.id } })).body;
  await call('POST', '/library/reservations', { token: BOB, body: { item_id: rr.id } });
  await call('POST', '/library/reservations', { token: CID, body: { item_id: rr.id } });
  await call('POST', `/library/loans/${holder.id}/return`, { token: LIB });
  check('only one reservation becomes ready per freed copy', (await db.libraryReservation.count({ where: { item_id: rr.id, status: 'ready' } })) === 1);

  // ── tenant isolation ───────────────────────────────────────────────────────
  section('Tenant isolation');
  const oLib = await O.mkU('Olga Librarian', 'librarian'); const OLIB = H.mkToken(O.schoolId, oLib);
  check('other school sees an empty catalogue', (await call('GET', '/library/items', { token: OLIB })).body.total === 0);
  check('other school cannot read my item', (await call('GET', `/library/items/${algo.body.id}`, { token: OLIB })).status === 404);
  const cross = await call('POST', '/library/loans', { token: OLIB, body: { item_id: algo.body.id, student_id: O.students.ann.id } });
  check('other school cannot issue my item', cross.status === 404, cross.body);
  const oItem = await call('POST', '/library/items', { token: OLIB, body: { title: 'Other school book' } });
  check('other school creates its own', oItem.status === 201);
  check('cross-school student id unknown', (await call('POST', '/library/loans', { token: LIB, body: { item_id: oItem.body.id, student_id: O.students.ann.id } })).status === 404);
  check('settings are per school', (await call('GET', '/library/settings', { token: OLIB })).body.loan_days === 14);
  check('other school cannot cancel my reservation', (await call('POST', `/library/reservations/${resvF.body.id}/cancel`, { token: OLIB })).status === 404);

  await finish(H.platformClient);
})().catch(e => { console.error('SUITE CRASHED', e); process.exit(1); });
