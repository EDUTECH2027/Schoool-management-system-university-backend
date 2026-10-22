// Student service requests: types, state machine, SLA and the transition engine (used by routes/services.js).
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const docs = require('../academics/documents');
const { audit } = require('../academics/registration');
const { actorOf } = require('../academics/results');

const TYPES = ['certificate', 'transcript', 'correction', 'leave', 'complaint', 'other'];
const STATUSES = ['submitted', 'in_review', 'awaiting_info', 'approved', 'rejected', 'completed', 'cancelled'];
const OPEN = ['submitted', 'in_review', 'awaiting_info', 'approved'];        // not finished: comments allowed
const CANCELLABLE = ['submitted', 'in_review', 'awaiting_info'];            // the student may withdraw these
const FLOW = {
  submitted: ['in_review', 'cancelled'],
  in_review: ['awaiting_info', 'approved', 'rejected', 'cancelled'],
  awaiting_info: ['in_review', 'rejected', 'cancelled'],
  approved: ['completed'],
  rejected: [], completed: [], cancelled: [],
};
const NOTE_REQUIRED = new Set(['awaiting_info', 'rejected', 'cancelled']);
const DOC_TYPE = { certificate: 'enrolment_certificate', transcript: 'transcript' };
const MAX_OPEN_PER_STUDENT = 10;
const SLA_DAYS = Math.max(1, Number(process.env.SERVICE_SLA_DAYS) || 5);
const SLA_STATUSES = ['submitted', 'in_review', 'approved'];                 // awaiting_info waits on the student, not on staff
const LIMITS = { subject: [3, 150], description: [0, 4000], comment: [1, 2000] };

class ServiceError extends Error { constructor(message, status = 422) { super(message); this.status = status; } }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReference(now = new Date()) {
  let s = ''; for (const b of crypto.randomBytes(6)) s += ALPHABET[b % ALPHABET.length];
  return `SR-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}-${s}`;
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
/** Cleans the type-specific details; throws ServiceError on invalid input. */
function cleanPayload(type, raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(p).slice(0, 12)) {
    if (typeof v === 'string') out[String(k).slice(0, 40)] = v.trim().slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') out[String(k).slice(0, 40)] = v;
  }
  if (type === 'leave') {
    if (!out.start_date || !isDate(String(out.start_date))) throw new ServiceError('A leave request needs a valid start date (YYYY-MM-DD).');
    if (out.end_date && (!isDate(String(out.end_date)) || out.end_date < out.start_date)) throw new ServiceError('The end date must be a valid date on or after the start date.');
  }
  if (type === 'correction' && !String(out.field || '').trim()) throw new ServiceError('Say which data or grade must be corrected.');
  return out;
}

function validateText(label, v, [min, max]) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw new ServiceError(`${label} must be at least ${min} character${min > 1 ? 's' : ''}.`);
  if (s.length > max) throw new ServiceError(`${label} must be at most ${max} characters.`);
  return s;
}

const ageDays = r => ((r.closed_at ?? new Date()).getTime() - r.created_at.getTime()) / 86_400_000;
const sla = r => { const age = ageDays(r); return { age_days: Math.round(age * 10) / 10, sla_days: SLA_DAYS, overdue: SLA_STATUSES.includes(r.status) && age > SLA_DAYS }; };

const studentName = s => (s ? `${s.first_name} ${s.last_name}` : null);
const eventDto = e => ({ id: e.id, kind: e.kind, from_status: e.from_status, to_status: e.to_status, body: e.body, internal: e.internal, author_name: e.author_name, author_role: e.author_role, created_at: e.created_at });
// What a student may see: no assignee, no internal events, no staff user ids.
const studentDto = r => ({ id: r.id, reference: r.reference, type: r.type, subject: r.subject, description: r.description, status: r.status, decision_note: r.decision_note, document_id: r.document_id, payload: r.payload, created_at: r.created_at, updated_at: r.updated_at, closed_at: r.closed_at, can_cancel: CANCELLABLE.includes(r.status), can_comment: OPEN.includes(r.status) });
const staffDto = (r, assignee) => ({ ...studentDto(r), priority: r.priority, assigned_to: r.assigned_to, assignee_name: assignee ?? null, student_id: r.student_id, student: studentName(r.student), matricule: r.student?.student_number ?? null, class_name: r.student?.class_name ?? null, ...sla(r) });

async function addEvent(db, requestId, actor, { kind, from, to, body, internal = false }) {
  return db.serviceRequestEvent.create({ data: { id: uuid(), request_id: requestId, kind, from_status: from ?? null, to_status: to ?? null, body: body ?? null, internal, author_id: actor?.id ?? null, author_name: actor?.name ?? null, author_role: actor?.role ?? null } });
}

/**
 * Moves a request along FLOW. Optimistic: the row is claimed with its current status, so concurrent transitions cannot both win.
 * Completing an approved certificate/transcript issues the official document inside the same transaction.
 * Returns { request, document }.
 */
async function transition(db, request, to, { note, user, byStudent = false }) {
  if (!STATUSES.includes(to)) throw new ServiceError(`status must be one of ${STATUSES.join(', ')}`);
  if (!(FLOW[request.status] || []).includes(to)) throw new ServiceError(`A request that is ${request.status.replace('_', ' ')} cannot become ${to.replace('_', ' ')}.`, 409);
  const text = typeof note === 'string' ? note.trim() : '';
  if (NOTE_REQUIRED.has(to) && !byStudent && text.length < 3) throw new ServiceError(`A note explaining the decision is required to set a request to ${to.replace('_', ' ')}.`);
  if (text.length > LIMITS.comment[1]) throw new ServiceError(`The note must be at most ${LIMITS.comment[1]} characters.`);
  const actor = actorOf(user);
  let payload = null;
  const docType = to === 'completed' ? DOC_TYPE[request.type] : null;
  let student = null;
  if (docType && !request.document_id) {
    student = await docs.loadStudent(db, request.student_id);
    if (!student) throw new ServiceError('Student not found', 404);
    payload = await docs.buildPayload(db, docType, student, {});
    if (payload.error) throw new ServiceError(`The document cannot be issued: ${payload.error}`);
  }
  const now = new Date();
  const closing = ['rejected', 'completed', 'cancelled'].includes(to);
  const result = await db.$transaction(async tx => {
    const claim = await tx.serviceRequest.updateMany({ where: { id: request.id, status: request.status }, data: { status: to, updated_at: now, ...(closing && { closed_at: now }), ...((to === 'rejected' || to === 'approved' || to === 'completed') && text && { decision_note: text }) } });
    if (claim.count === 0) throw new ServiceError('The request was changed by someone else — reload and try again.', 409);
    let doc = null;
    if (payload) {
      for (let i = 0; i < 3 && !doc; i++) {
        try { doc = await tx.officialDocument.create({ data: { id: uuid(), code: docs.newCode(user.school_id), type: docType, student_id: student.id, payload, issued_by: user.id, issued_by_name: user.name } }); } catch (e) { if (e.code !== 'P2002') throw e; }
      }
      if (!doc) throw new ServiceError('Could not allocate a verification code, try again.', 500);
      await tx.serviceRequest.update({ where: { id: request.id }, data: { document_id: doc.id } });
      await audit(tx, actor, 'document.issue', 'official_document', doc.id, { after: { type: docType, code: doc.code, student_id: student.id, service_request: request.reference } });
    }
    await addEvent(tx, request.id, actor, { kind: 'status', from: request.status, to, body: text || null });
    if (doc) await addEvent(tx, request.id, actor, { kind: 'document', body: `Official document issued (${doc.code})` });
    await audit(tx, actor, `service.${to}`, 'service_request', request.id, { reason: text || undefined, before: { status: request.status }, after: { status: to, ...(doc && { document_id: doc.id }) } });
    return { doc };
  });
  const fresh = await db.serviceRequest.findUnique({ where: { id: request.id }, include: { student: true } });
  return { request: fresh, document: result.doc };
}

module.exports = { TYPES, STATUSES, OPEN, CANCELLABLE, FLOW, NOTE_REQUIRED, DOC_TYPE, MAX_OPEN_PER_STUDENT, SLA_DAYS, SLA_STATUSES, LIMITS, ServiceError, newReference, cleanPayload, validateText, sla, studentDto, staffDto, eventDto, addEvent, transition };
