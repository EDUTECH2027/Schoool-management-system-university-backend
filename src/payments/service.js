// Provider-independent payment service. ALL money movement into the ledger goes through this file:
//
//   createTransaction()  student starts a payment      → PaymentTransaction (initiated → pending) + provider call
//   verifyAndApply()     ask the provider what happened → applyResult()
//   applyResult()        the ONLY place a transaction becomes 'successful' and an invoice is credited:
//                        compare-and-set on status, row-lock on the invoice, one Payment (receipt) per transaction.
//   reviewBankTransfer() finance officer approves / rejects a bank transfer
//   recordManualPayment()/refund()  authorised finance actions, always audited
//
// A browser redirect or a webhook body is NEVER trusted for money: webhooks only trigger verifyAndApply(),
// which re-queries the provider (or, for Stripe, retrieves the session) server-side.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const cfg = require('./config');
const providers = require('./providers');
const { ProviderError } = require('./http');

const FINAL = new Set(['successful', 'failed', 'cancelled', 'expired', 'refunded']);
const OPEN = ['initiated', 'pending', 'processing', 'awaiting_verification'];
const RESOLVABLE = ['initiated', 'pending', 'processing', 'awaiting_verification'];   // may still become successful/failed
const LATE_OK = new Set(['failed', 'cancelled', 'expired']);                           // …and money may arrive after we gave up

class PaymentError extends Error {
  constructor(message, status = 422, code) { super(message); this.status = status; this.code = code; }
}

// ── money helpers ───────────────────────────────────────────────────────────────
const round = (n, cur = cfg.currency()) => (cfg.isZeroDecimal(cur) ? Math.round(n) : Math.round(n * 100) / 100);
const sameAmount = (a, b, cur) => Math.abs(round(a, cur) - round(b, cur)) < (cfg.isZeroDecimal(cur) ? 0.5 : 0.005);

function invoiceStatus(rec) {
  if (rec.status === 'waived') return 'waived';
  if (rec.balance <= 0) return 'paid';
  if (rec.amount_paid > 0) return 'partial';
  const today = new Date().toISOString().slice(0, 10);
  if (rec.due_date && rec.due_date < today) return 'overdue';
  return 'pending';
}

const invoiceNumber = f => f.invoice_number || `INV-${String(f.academic_year || new Date(f.created_at || Date.now()).getFullYear()).slice(0, 4)}-${f.id.slice(0, 8).toUpperCase()}`;

// ── ids / tokens ────────────────────────────────────────────────────────────────
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I — safe to read out and type from a bank slip
function newReference() {
  const d = new Date();
  let s = '';
  for (const b of crypto.randomBytes(7)) s += ALPHABET[b % ALPHABET.length];
  return `EDU-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-${s}`;
}
const callbackToken = reference => crypto.createHmac('sha256', cfg.webhookKey()).update(reference).digest('hex').slice(0, 32);
function checkCallbackToken(reference, token) {
  const a = Buffer.from(callbackToken(reference)), b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── persistence helpers ────────────────────────────────────────────────────────
async function addEvent(client, tx, { from, to, source, actor, note, payload }) {
  await client.paymentEvent.create({
    data: {
      id: uuid(), transaction_id: tx.id, from_status: from ?? null, to_status: to, source,
      actor_id: actor?.id ?? null, actor_name: actor?.name ?? null, note: note ?? null, payload: payload ?? undefined,
    },
  });
}

async function audit(client, actor, action, targetType, targetId, { reason, before, after } = {}) {
  await client.financeAudit.create({
    data: {
      id: uuid(), actor_id: actor?.id ?? null, actor_name: actor?.name ?? null, actor_role: actor?.role ?? null,
      action, target_type: targetType, target_id: targetId, reason: reason ?? null, before: before ?? undefined, after: after ?? undefined,
    },
  });
}

async function nextReceiptNumber(client) {
  const [{ n }] = await client.$queryRaw`SELECT nextval('receipt_seq')::int AS n`;
  return `RC-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
}

// Locks the invoice row, applies a delta to what has been paid, recomputes balance + status. Call inside $transaction.
async function creditInvoice(client, feeId, delta) {
  await client.$queryRaw`SELECT id FROM fee_records WHERE id = ${feeId} FOR UPDATE`;
  const fee = await client.feeRecord.findUnique({ where: { id: feeId } });
  const paid = round(fee.amount_paid + delta, fee.currency);
  const balance = Math.max(0, round(fee.amount_due - paid, fee.currency));
  const next = { ...fee, amount_paid: paid, balance };
  const updated = await client.feeRecord.update({
    where: { id: feeId }, data: { amount_paid: paid, balance, status: invoiceStatus(next), updated_at: new Date() },
  });
  return { before: fee, after: updated };
}

// ── transaction lifecycle ──────────────────────────────────────────────────────
function urlsFor(tx, schoolId) {
  const api = cfg.apiPublicUrl();
  const t = callbackToken(tx.reference);
  return {
    callbackUrl: api ? `${api}/api/payments/webhooks/${tx.provider}/${schoolId}/${encodeURIComponent(tx.reference)}?t=${t}` : undefined,
    returnUrl: `${cfg.frontendUrl()}/student/fees?ref=${encodeURIComponent(tx.reference)}`,
    cancelUrl: `${cfg.frontendUrl()}/student/fees?ref=${encodeURIComponent(tx.reference)}&cancelled=1`,
  };
}

async function createTransaction(db, { student, invoiceId, amount, providerId, phone, idempotencyKey, actor, schoolId, lang }) {
  const provider = providers.get(providerId);
  if (!provider) throw new PaymentError('Unknown payment method');
  if (!provider.isConfigured()) throw new PaymentError(`${provider.label} is not available yet. Please choose another method or contact the finance office.`, 503, 'provider_not_configured');

  // Idempotency: the same key from the same student returns the same transaction (double-click / retry safe).
  if (idempotencyKey) {
    const existing = await db.paymentTransaction.findFirst({ where: { student_id: student.id, idempotency_key: idempotencyKey } });
    if (existing) return { tx: existing, reused: true };
  }

  const invoice = await db.feeRecord.findUnique({ where: { id: String(invoiceId || '') } });
  if (!invoice || invoice.student_id !== student.id) throw new PaymentError('Invoice not found', 404);
  if (invoice.status === 'waived') throw new PaymentError('This invoice has been waived — nothing to pay.');
  if (invoice.balance <= 0) throw new PaymentError('This invoice is already fully paid.');

  const cur = invoice.currency;
  if (provider.currency().toUpperCase() !== cur.toUpperCase() && !(provider.supportsCurrency && provider.supportsCurrency(cur))) {
    throw new PaymentError(`${provider.label} cannot be used for invoices in ${cur}.`, 422, 'currency_unsupported');
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new PaymentError('Enter a valid amount.');
  if (cfg.isZeroDecimal(cur) && !Number.isInteger(amt)) throw new PaymentError(`Amounts in ${cur} must be whole numbers.`);
  if (!cfg.isZeroDecimal(cur) && Math.round(amt * 100) !== amt * 100 && Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) throw new PaymentError('At most 2 decimals are allowed.');
  if (amt > invoice.balance + 1e-9) throw new PaymentError(`The amount cannot exceed the outstanding balance (${invoice.balance.toLocaleString()} ${cur}).`);
  if (!cfg.allowPartial() && !sameAmount(amt, invoice.balance, cur)) throw new PaymentError('Partial payments are not accepted: please pay the full balance.');
  if (amt < cfg.minAmount() && !sameAmount(amt, invoice.balance, cur)) throw new PaymentError(`The minimum payment is ${cfg.minAmount().toLocaleString()} ${cur} (or the remaining balance).`);

  const open = await db.paymentTransaction.count({ where: { fee_record_id: invoice.id, status: { in: OPEN } } });
  if (open >= cfg.maxOpenPerInvoice()) throw new PaymentError('You already have pending payments for this invoice. Wait for them to complete or cancel one first.', 409, 'too_many_open');
  const recent = await db.paymentTransaction.count({ where: { student_id: student.id, created_at: { gte: new Date(Date.now() - 3600_000) } } });
  if (recent >= 15) throw new PaymentError('Too many payment attempts. Please try again later.', 429);

  let payerPhone = null;
  if (provider.requiresPhone) {
    payerPhone = provider.normalizePhone ? provider.normalizePhone(phone) : String(phone || '').replace(/\D/g, '');
    if (!payerPhone) throw new PaymentError('Enter a valid mobile money number (e.g. 6 7X XX XX XX).');
  }

  let tx;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      tx = await db.paymentTransaction.create({
        data: {
          id: uuid(), reference: newReference(), fee_record_id: invoice.id, student_id: student.id, amount: round(amt, cur), currency: cur,
          provider: providerId, status: 'initiated', payer_phone: payerPhone, idempotency_key: idempotencyKey || null,
          initiated_by: actor?.id ?? null, expires_at: providerId === 'bank_transfer' ? new Date(Date.now() + 14 * 86400_000) : new Date(Date.now() + cfg.pendingTtlMinutes() * 60_000),
        },
      });
      break;
    } catch (e) {
      if (e.code === 'P2002' && String(e.meta?.target).includes('reference')) continue;      // reference collision: retry with a new one
      if (e.code === 'P2002' && idempotencyKey) {                                           // lost an idempotency race
        const existing = await db.paymentTransaction.findFirst({ where: { student_id: student.id, idempotency_key: idempotencyKey } });
        if (existing) return { tx: existing, reused: true };
      }
      throw e;
    }
  }
  await addEvent(db, tx, { to: 'initiated', source: 'student', actor, note: `Started ${provider.label} payment of ${tx.amount} ${cur}` });

  try {
    const r = await provider.initiate(tx, { ...urlsFor(tx, schoolId), schoolId, lang, studentName: `${student.first_name} ${student.last_name}`, feeName: invoice.fee_name });
    tx = await db.paymentTransaction.update({
      where: { id: tx.id },
      data: { status: r.status || 'pending', provider_ref: r.providerRef ?? null, provider_secret: r.providerSecret ?? null, checkout_url: r.checkoutUrl ?? null, updated_at: new Date() },
    });
    await addEvent(db, tx, { from: 'initiated', to: tx.status, source: 'system', note: 'Provider accepted the request' });
    return { tx, reused: false };
  } catch (e) {
    const reason = e instanceof ProviderError ? e.message : 'Unexpected error';
    // A timeout is ambiguous (the provider may have created the charge): keep it for the reconciler instead of failing it.
    const ambiguous = e instanceof ProviderError && /timed out|unreachable/i.test(e.message) && providerId !== 'bank_transfer';
    const status = ambiguous ? 'pending' : 'failed';
    tx = await db.paymentTransaction.update({ where: { id: tx.id }, data: { status, failure_reason: ambiguous ? null : reason.slice(0, 300), updated_at: new Date() } });
    await addEvent(db, tx, { from: 'initiated', to: status, source: 'system', note: ambiguous ? `Provider did not answer (${reason}); will be re-checked` : `Provider rejected the request: ${reason}`, payload: e.body ? { body: e.body } : undefined });
    if (ambiguous) throw new PaymentError('The payment provider is slow to respond. We will keep checking — your payment status will update automatically.', 202, 'provider_slow');
    throw new PaymentError(e instanceof ProviderError && !e.status && !e.retryable ? reason : 'The payment provider could not start the payment. Please try again or choose another method.', 502, 'provider_error');
  }
}

// The single gate through which a transaction can become successful / failed / expired.
async function applyResult(db, txId, result, { source, actor, note } = {}) {
  const status = result.status;
  return db.$transaction(async client => {
    const tx = await client.paymentTransaction.findUnique({ where: { id: txId } });
    if (!tx) throw new PaymentError('Transaction not found', 404);
    if (tx.status === status) return { tx, changed: false };

    if (status === 'successful') {
      if (tx.status === 'successful' || tx.status === 'refunded') return { tx, changed: false };   // duplicate notification
      if (!RESOLVABLE.includes(tx.status) && !LATE_OK.has(tx.status)) return { tx, changed: false };
      // Server-side amount/currency validation against what we asked for.
      if (result.currency && String(result.currency).toUpperCase() !== tx.currency.toUpperCase()) {
        await client.paymentTransaction.update({ where: { id: tx.id }, data: { needs_review: true, review_note: `Provider reported currency ${result.currency}, expected ${tx.currency}`, updated_at: new Date() } });
        await addEvent(client, tx, { from: tx.status, to: tx.status, source, actor, note: `REJECTED: currency mismatch (${result.currency} vs ${tx.currency}) — not credited`, payload: result.raw });
        return { tx: await client.paymentTransaction.findUnique({ where: { id: tx.id } }), changed: false, mismatch: true };
      }
      if (result.amount !== undefined && !sameAmount(result.amount, tx.amount, tx.currency)) {
        await client.paymentTransaction.update({ where: { id: tx.id }, data: { needs_review: true, review_note: `Provider reported ${result.amount}, expected ${tx.amount}`, updated_at: new Date() } });
        await addEvent(client, tx, { from: tx.status, to: tx.status, source, actor, note: `REJECTED: amount mismatch (${result.amount} vs ${tx.amount}) — not credited`, payload: result.raw });
        return { tx: await client.paymentTransaction.findUnique({ where: { id: tx.id } }), changed: false, mismatch: true };
      }

      // Compare-and-set: only one concurrent caller can flip the status; the loser sees count 0 and exits.
      const claim = await client.paymentTransaction.updateMany({
        where: { id: tx.id, status: { in: [...RESOLVABLE, ...LATE_OK] } },
        data: { status: 'successful', provider_txn_id: result.providerTxnId ?? tx.provider_txn_id, failure_reason: null, verified_at: new Date(), verified_by: actor?.id ?? null, updated_at: new Date() },
      });
      if (claim.count === 0) return { tx: await client.paymentTransaction.findUnique({ where: { id: tx.id } }), changed: false };

      const { before, after } = await creditInvoice(client, tx.fee_record_id, tx.amount);
      const overpaid = tx.amount > before.balance + 1e-9;
      const payment = await client.payment.create({
        data: {
          id: uuid(), fee_record_id: tx.fee_record_id, amount: tx.amount, method: tx.provider, reference: tx.reference,
          payment_date: new Date().toISOString().slice(0, 10), receipt_number: await nextReceiptNumber(client),
          transaction_id: tx.id, kind: 'payment', recorded_by: actor?.id ?? null,
        },
      });
      const late = LATE_OK.has(tx.status);
      const done = await client.paymentTransaction.update({
        where: { id: tx.id },
        data: {
          payment_id: payment.id,
          needs_review: overpaid || late || tx.needs_review,
          review_note: [overpaid ? 'Paid more than the remaining balance — review for credit/refund' : null, late ? `Confirmed after the transaction was marked ${tx.status}` : null].filter(Boolean).join('; ') || tx.review_note,
        },
      });
      await addEvent(client, tx, { from: tx.status, to: 'successful', source, actor, note: note || (late ? `Late confirmation (was ${tx.status})` : 'Payment verified'), payload: { providerTxnId: result.providerTxnId, receipt: payment.receipt_number, balanceAfter: after.balance } });
      return { tx: done, changed: true, payment };
    }

    // non-success outcomes: only from a still-open state
    if (!RESOLVABLE.includes(tx.status)) return { tx, changed: false };
    const claim = await client.paymentTransaction.updateMany({
      where: { id: tx.id, status: { in: RESOLVABLE } },
      data: { status, failure_reason: result.reason ? String(result.reason).slice(0, 300) : null, verified_at: ['failed', 'cancelled', 'expired'].includes(status) ? new Date() : null, verified_by: actor?.id ?? null, updated_at: new Date() },
    });
    if (claim.count === 0) return { tx: await client.paymentTransaction.findUnique({ where: { id: tx.id } }), changed: false };
    const done = await client.paymentTransaction.findUnique({ where: { id: tx.id } });
    await addEvent(client, tx, { from: tx.status, to: status, source, actor, note: note || result.reason, payload: result.raw });
    return { tx: done, changed: true };
  }, { timeout: 15000 });
}

// Ask the provider (server-to-server) what happened, then apply it.
async function verifyAndApply(db, tx, source = 'provider_poll', actor) {
  const provider = providers.get(tx.provider);
  if (!provider || tx.provider === 'bank_transfer' || !provider.isConfigured()) return { tx, changed: false };
  let result;
  try { result = await provider.verify(tx); }
  catch (e) {
    await addEvent(db, tx, { from: tx.status, to: tx.status, source: 'system', note: `Status check failed: ${e.message}` });
    return { tx, changed: false, error: e.message };
  }
  if (result.status === 'pending' && tx.status === 'pending') return { tx, changed: false };
  return applyResult(db, tx.id, result, { source, actor });
}

// Expire attempts that never completed (after one last provider check), and re-check everything still open.
async function sweepOpen(db, { now = new Date() } = {}) {
  const stale = new Date(now.getTime() - 60_000);
  const open = await db.paymentTransaction.findMany({
    where: { status: { in: ['initiated', 'pending', 'processing'] }, provider: { not: 'bank_transfer' }, created_at: { lt: stale }, updated_at: { lt: stale } },
    take: 50, orderBy: { created_at: 'asc' },
  });
  let changed = 0;
  for (const tx of open) {
    let current = tx;
    if (tx.provider_ref) { const r = await verifyAndApply(db, tx, 'provider_poll'); if (r.changed) { changed++; continue; } current = r.tx || tx; }
    if (FINAL.has(current.status)) continue;
    if (current.expires_at && current.expires_at < now) {
      const r = await applyResult(db, current.id, { status: 'expired', reason: 'No confirmation received in time' }, { source: 'system', note: 'Expired after the time limit' });
      if (r.changed) changed++;
    } else {
      await db.paymentTransaction.update({ where: { id: current.id }, data: { updated_at: now } });   // throttle: next check in ≥ 60 s
    }
  }
  // bank transfers nobody ever followed up on
  const bank = await db.paymentTransaction.findMany({ where: { provider: 'bank_transfer', status: 'pending', expires_at: { lt: now } }, take: 50 });
  for (const tx of bank) { const r = await applyResult(db, tx.id, { status: 'expired', reason: 'No transfer proof received' }, { source: 'system' }); if (r.changed) changed++; }
  return changed;
}

async function cancelByStudent(db, tx, actor) {
  if (!['initiated', 'pending'].includes(tx.status)) throw new PaymentError('This payment can no longer be cancelled.', 409);
  const provider = providers.get(tx.provider);
  if (provider?.cancel) { try { await provider.cancel(tx); } catch { /* best effort */ } }
  const r = await applyResult(db, tx.id, { status: 'cancelled', reason: 'Cancelled by the student' }, { source: 'student', actor });
  return r.tx;
}

// Bank transfer proof upload → stays pending (awaiting_verification) until a finance officer decides.
async function attachBankReceipt(db, tx, file, bankReference, actor) {
  if (tx.provider !== 'bank_transfer') throw new PaymentError('Only bank transfers take a receipt upload.');
  if (!['pending', 'awaiting_verification'].includes(tx.status)) throw new PaymentError('This transfer can no longer be updated.', 409);
  const updated = await db.paymentTransaction.update({
    where: { id: tx.id },
    data: {
      status: 'awaiting_verification', receipt_name: file.originalname, receipt_mime: file.mimetype, receipt_size: file.size, receipt_data: file.buffer,
      bank_reference: bankReference ? String(bankReference).slice(0, 80) : tx.bank_reference, updated_at: new Date(),
    },
  });
  await addEvent(db, tx, { from: tx.status, to: 'awaiting_verification', source: 'student', actor, note: `Transfer proof uploaded (${file.originalname})` });
  return updated;
}

async function reviewBankTransfer(db, tx, { decision, reason, bankReference, actor }) {
  if (tx.provider !== 'bank_transfer') throw new PaymentError('Not a bank transfer.');
  if (!['pending', 'awaiting_verification'].includes(tx.status)) throw new PaymentError(`This transfer is already ${tx.status}.`, 409);
  if (decision === 'approve') {
    if (bankReference) await db.paymentTransaction.update({ where: { id: tx.id }, data: { bank_reference: String(bankReference).slice(0, 80) } });
    const r = await applyResult(db, tx.id, { status: 'successful', amount: tx.amount, currency: tx.currency }, { source: 'finance_officer', actor, note: reason || 'Bank transfer verified' });
    // A concurrent reviewer got there first: report it instead of silently succeeding (and don't double-audit).
    if (!r.changed) throw new PaymentError(`This transfer is already ${r.tx.status}.`, 409);
    await audit(db, actor, 'bank_transfer.approve', 'payment_transaction', tx.id, { reason, after: { reference: tx.reference, amount: tx.amount } });
    return r;
  }
  if (decision === 'reject') {
    if (!reason || !reason.trim()) throw new PaymentError('Give a reason for rejecting this transfer.');
    const r = await applyResult(db, tx.id, { status: 'failed', reason: reason.trim() }, { source: 'finance_officer', actor, note: `Rejected: ${reason.trim()}` });
    if (!r.changed) throw new PaymentError(`This transfer is already ${r.tx.status}.`, 409);
    await audit(db, actor, 'bank_transfer.reject', 'payment_transaction', tx.id, { reason });
    return r;
  }
  throw new PaymentError('decision must be approve or reject');
}

// Cash / counter / off-platform payment recorded by authorised staff.
async function recordManualPayment(db, { feeId, amount, method, reference, reason, paymentDate, actor }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new PaymentError('Enter a valid amount.');
  if (!reason || !reason.trim()) throw new PaymentError('A reason is required for manual payments.');
  return db.$transaction(async client => {
    const fee = await client.feeRecord.findUnique({ where: { id: feeId } });
    if (!fee) throw new PaymentError('Invoice not found', 404);
    if (cfg.isZeroDecimal(fee.currency) && !Number.isInteger(amt)) throw new PaymentError(`Amounts in ${fee.currency} must be whole numbers.`);
    const { before, after } = await creditInvoice(client, feeId, amt);
    const payment = await client.payment.create({
      data: {
        id: uuid(), fee_record_id: feeId, amount: round(amt, fee.currency), method: method || 'manual', reference: reference || null,
        payment_date: paymentDate || new Date().toISOString().slice(0, 10), receipt_number: await nextReceiptNumber(client), kind: 'payment', recorded_by: actor?.id ?? null,
      },
    });
    await audit(client, actor, 'payment.manual', 'payment', payment.id, { reason, before: { amount_paid: before.amount_paid, balance: before.balance }, after: { amount_paid: after.amount_paid, balance: after.balance, amount: payment.amount, method: payment.method } });
    return { payment, invoice: after };
  }, { timeout: 15000 });
}

async function refund(db, { paymentId, amount, reason, providerRefund, actor }) {
  if (!reason || !reason.trim()) throw new PaymentError('A reason is required for a refund.');
  const payment = await db.payment.findUnique({ where: { id: paymentId }, include: { fee_record: true } });
  if (!payment || payment.kind !== 'payment') throw new PaymentError('Payment not found', 404);
  const already = (await db.payment.aggregate({ where: { reverses_payment_id: paymentId }, _sum: { amount: true } }))._sum.amount || 0;   // negative numbers
  const refundable = round(payment.amount + already, payment.fee_record.currency);
  const amt = amount === undefined || amount === null || amount === '' ? refundable : Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new PaymentError('Enter a valid refund amount.');
  if (amt > refundable + 1e-9) throw new PaymentError(`Only ${refundable.toLocaleString()} ${payment.fee_record.currency} can still be refunded for this payment.`);

  const tx = payment.transaction_id ? await db.paymentTransaction.findUnique({ where: { id: payment.transaction_id } }) : null;
  let providerResult = null;
  if (providerRefund) {
    const p = tx && providers.get(tx.provider);
    if (!p || !p.refund || !p.isConfigured()) throw new PaymentError('This payment cannot be refunded through its provider — record it as a manual refund instead.');
    try { providerResult = await p.refund(tx, amt); }
    catch (e) { throw new PaymentError(`The provider refused the refund: ${e.message}`, 502); }
  }
  return db.$transaction(async client => {
    const { before, after } = await creditInvoice(client, payment.fee_record_id, -amt);
    const refundRow = await client.payment.create({
      data: {
        id: uuid(), fee_record_id: payment.fee_record_id, amount: -round(amt, payment.fee_record.currency), method: payment.method, reference: payment.reference,
        payment_date: new Date().toISOString().slice(0, 10), receipt_number: await nextReceiptNumber(client), kind: 'refund', reverses_payment_id: payment.id, recorded_by: actor?.id ?? null,
      },
    });
    if (tx) {
      const total = round(tx.refunded_amount + amt, tx.currency);
      await client.paymentTransaction.update({ where: { id: tx.id }, data: { refunded_amount: total, status: total >= tx.amount - 1e-9 ? 'refunded' : tx.status, updated_at: new Date() } });
      await addEvent(client, tx, { from: tx.status, to: total >= tx.amount - 1e-9 ? 'refunded' : tx.status, source: 'finance_officer', actor, note: `Refund of ${amt} ${tx.currency}: ${reason}`, payload: providerResult ? { provider: providerResult } : { provider: 'manual' } });
    }
    await audit(client, actor, 'payment.refund', 'payment', payment.id, { reason, before: { amount_paid: before.amount_paid, balance: before.balance }, after: { amount_paid: after.amount_paid, balance: after.balance, refunded: amt, provider_refund: !!providerResult } });
    return { refund: refundRow, invoice: after, provider: providerResult };
  }, { timeout: 15000 });
}

// What may leave the server about a transaction (never provider_secret / receipt bytes).
function txDto(tx, { staff = false } = {}) {
  if (!tx) return null;
  const { provider_secret, receipt_data, idempotency_key, ...rest } = tx;   // eslint-disable-line no-unused-vars
  const out = { ...rest, has_receipt: !!tx.receipt_name };
  delete out.fee_record; delete out.student; delete out.events; delete out.payment;
  if (!staff) { delete out.needs_review; delete out.review_note; delete out.initiated_by; delete out.verified_by; }
  return out;
}

module.exports = {
  PaymentError, FINAL, OPEN, round, sameAmount, invoiceStatus, invoiceNumber, newReference, checkCallbackToken, callbackToken,
  createTransaction, applyResult, verifyAndApply, sweepOpen, cancelByStudent, attachBankReceipt, reviewBankTransfer,
  recordManualPayment, refund, audit, addEvent, creditInvoice, txDto,
};
