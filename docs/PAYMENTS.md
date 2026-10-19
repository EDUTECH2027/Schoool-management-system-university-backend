# EduTech payments — architecture, configuration and go-live checklist

## What exists

| Area | Where |
|---|---|
| Provider-independent service (the only code that credits an invoice) | `src/payments/service.js` |
| Provider adapters | `src/payments/providers/{orangeMoney,mtnMomo,stripe,bank}.js` |
| Student API (`/api/payments/me/*`) | `src/routes/payments.js` |
| Provider notifications (`/api/payments/webhooks/*`) | `src/routes/paymentWebhooks.js` |
| Finance back-office API (`/api/finance/*`) | `src/routes/finance.js` |
| Background re-check / expiry job | `src/payments/reconciler.js` |
| Student dashboard | `EDUTECH/src/pages/student/StudentFees.tsx` |
| Finance dashboards | `EDUTECH/src/pages/finance/*` (finance officers get their own portal; admins see the same pages under **Finance**) |

Data model (migration `…_payments_finance_and_indexes`): an **invoice** is the existing `fee_records` row; a **payment attempt** is a `payment_transactions` row with an event history (`payment_events`); a confirmed payment/receipt is a `payments` row (one per transaction, enforced by a unique key); every sensitive finance action is in `finance_audit`; every provider notification is in `payment_webhook_events`.

## How money is protected

1. **Only verified results credit an invoice.** `applyResult()` is the single gate. A browser redirect, a "success" page or a webhook body is never trusted:
   * Stripe — the webhook signature is verified, then the Checkout Session is *retrieved from Stripe*.
   * MTN / Orange — callbacks carry an HMAC token we issued (and Orange's stored `notif_token`), and are only a *hint*: the result is always confirmed with the provider's status API.
   * Bank transfer — a finance officer (or an exact reference + amount match in an imported bank statement) approves it.
2. **Idempotent.** Compare-and-set on the transaction status + a row lock on the invoice + `payments.transaction_id` unique ⇒ replays, concurrent checks and duplicate webhooks can never credit twice (covered by tests: 10 parallel checks, 3× re-delivered Stripe events, two simultaneous bank approvals).
3. **Server-side validation** of amount (≤ balance, minimum, whole XAF), currency, ownership of the invoice, open-attempt limit (3 per invoice), rate limit (15/hour/student), student idempotency keys.
4. **Mismatches are never credited.** A provider-reported amount/currency different from what was requested is rejected and flagged "needs review". Late confirmations (money taken after we expired/failed the attempt) *are* credited — the money exists — and flagged for review. Overpayments are credited and flagged for refund.
5. **Roles.** Students: own data only. Finance officers: read, verify bank transfers, record manual payments, reconcile, export. **Refunds and invoice adjustments: administrators only.** Reasons are mandatory; every action is audited (actor, role, time, before/after, reason).
6. **Fixed along the way:** the old `/api/fees` routes let *any logged-in user* (including students) list every student's fees and record payments. They are now restricted to administrators and finance officers.

## Providers — status and prerequisites

Nothing is simulated. A provider whose variables are missing is reported **"not configured"** to staff (names of missing variables only) and **"Not available yet"** to students.

| Provider | Status in this repo | What you need before go-live |
|---|---|---|
| **Orange Money (Cameroon)** | Adapter + settlement logic complete; exercised against a local mock of the WebPay API. **Not verified against Orange's real sandbox.** | Orange Developer account → app subscribed to *Orange Money WebPay*; approved merchant account with Orange Money Cameroon. Set `ORANGE_MONEY_CONSUMER_AUTH` (base64 `consumer_key:consumer_secret`), `ORANGE_MONEY_MERCHANT_KEY`, `API_PUBLIC_URL`. Use `ORANGE_MONEY_COUNTRY=dev` + `ORANGE_MONEY_CURRENCY=OUV` for the sandbox. Confirm the exact request/response fields in your sandbox. |
| **MTN Mobile Money (Cameroon)** | Adapter + settlement logic complete; exercised against a local mock of the Collection API. **Not verified against MTN's real sandbox.** | MTN MoMo developer portal: *Collections* subscription key, API user + API key (sandbox), then production credentials after merchant KYC with MTN Cameroon. Set `MTN_MOMO_SUBSCRIPTION_KEY`, `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY`; `MTN_MOMO_API_BASE` (`https://sandbox.momodeveloper.mtn.com` for sandbox, MTN's production gateway for live), `MTN_MOMO_TARGET_ENV` (`sandbox` / the Cameroon production environment name MTN gives you), `MTN_MOMO_CURRENCY` (sandbox only accepts EUR). |
| **Bank transfer** | Complete manual flow: instructions + unique reference, optional slip upload, finance verification, bank-statement CSV reconciliation. | Set `BANK_NAME`, `BANK_ACCOUNT_NAME`, `BANK_ACCOUNT_NUMBER` (+ optional `BANK_SWIFT`, `BANK_BRANCH`, `BANK_INSTRUCTIONS`). **No direct bank-API connector is included:** there is no public API common to Cameroonian banks. Once the university names its bank (Afriland, BICEC, Ecobank, UBA, SGC…) and gets API access, a connector is one more file implementing `initiate/verify` in `providers/`. |
| **Stripe** | Adapter complete (Checkout, signed webhooks, refunds, zero-decimal handling); exercised against a local mock. | **Eligibility first.** Stripe lets a business open an account only in its supported countries. Per stripe.com/global (checked while building this), **Cameroon is not listed**. A Cameroon-registered university cannot simply activate Stripe; do not try to work around the provider's eligibility rules. Compliant options: (a) a legally established entity + bank account in a Stripe-supported country (e.g. through Stripe Atlas) *if that matches the university's real structure and your legal advice*; (b) use a gateway that serves Cameroon (Orange/MTN above, or an aggregator such as Flutterwave / CinetPay — a new adapter). If you do hold a Stripe account: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCIES` (explicit list; XAF is *not* assumed to be enabled) and register `https://<api>/api/payments/webhooks/stripe` for `checkout.session.completed`, `…async_payment_succeeded`, `…async_payment_failed`, `…expired`. |

### Environment variables

```
# core
PAYMENT_CURRENCY=XAF                 # invoice currency stamped on new invoices
PAYMENT_MIN_AMOUNT=500               # minimum single payment (the remaining balance is always allowed)
PAYMENT_ALLOW_PARTIAL=true
PAYMENT_PENDING_TTL_MINUTES=30       # mobile-money/Stripe attempts not confirmed by then are expired (after a last provider check)
PAYMENT_MAX_OPEN_PER_INVOICE=3
PAYMENT_PROVIDER_TIMEOUT_MS=15000
PAYMENT_WEBHOOK_SECRET=<long random> # signs per-transaction callback URLs (defaults to JWT_SECRET)
PAYMENT_RECONCILER=on                # background re-check job; "off" disables
PAYMENT_RECEIPT_FOOTER=...
FINANCE_TZ_OFFSET_MIN=60             # school-local midnight for "today / this week" (Africa/Douala = +60)
API_PUBLIC_URL=https://<your-api>    # providers call back here (required for Orange; recommended for MTN)
FRONTEND_URL=https://<your-frontend> # where providers send the student back
# orange / mtn / stripe / bank: see the table above
```

Provider credentials are read **only** on the server and are never returned by any API (`/api/finance/providers` lists missing variable *names*).

## Operating it

* Create finance staff in **User Management** with role *finance officer*; they log in to their own portal (`/finance`).
* Students pay from **My Fees**; staff follow everything in **Finance → Transactions**, verify bank transfers in **Reconciliation** (single approve/reject or import a bank-statement CSV: rows containing the student's reference are matched on reference + exact amount; preview first, then apply), and export CSVs in **Reports**.
* Transactions flagged ⚑ (late confirmation, overpayment, provider amount mismatch) need a human decision: check the provider/bank statement, refund if necessary (administrator), then *Mark resolved* with a note.
* Faculties/departments are not part of the platform's data model; reports are by **class** and **academic year**.

## Known limitations

* Provider credentials are global per deployment (one merchant account per provider for all schools hosted on the same backend). Per-school credentials would need an encrypted secrets store.
* Real-provider behaviour (field names, sandbox quirks, callback formats, limits, fees) must be validated with each provider's sandbox before going live; the automated tests use local mocks.
* Parents cannot pay from the parent portal yet (read-only view unchanged).
* Mobile-money refunds are recorded in the ledger but the money must be returned to the payer through MTN/Orange yourself; Stripe refunds can be issued through the API.
* Webhooks need `API_PUBLIC_URL` to be reachable from the internet. Without it, payments still complete through polling (students' open tracker every 4 s, and the background job every minute).

## Tests

`node scripts/test-payments.js` (179 checks) runs against a live API + a *throwaway local Postgres* + local mock providers (`scripts/lib/payment-mocks.js`); see the header of the file for the environment it needs. It refuses to run against a non-local database.
