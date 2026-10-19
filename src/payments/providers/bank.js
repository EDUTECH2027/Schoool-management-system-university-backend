// Bank transfer. There is no public API shared by Cameroonian banks, so this is a manual flow:
//   1. student gets the university's official account details + a unique payment reference,
//   2. transfers the money and (optionally) uploads the bank slip → status "awaiting_verification",
//   3. a finance officer approves/rejects it — or a bank-statement CSV import auto-matches the reference.
// Nothing is credited until step 3. A direct bank API connector can be added as another adapter once the
// university names its bank (see docs/PAYMENTS.md).
const env = process.env;
const REQUIRED = ['BANK_ACCOUNT_NAME', 'BANK_ACCOUNT_NUMBER', 'BANK_NAME'];

module.exports = {
  id: 'bank_transfer',
  label: 'Bank transfer',
  flow: 'manual',
  requiresPhone: false,
  currency: () => (env.PAYMENT_CURRENCY || 'XAF').toUpperCase(),
  missing: () => REQUIRED.filter(k => !env[k]),
  isConfigured() { return this.missing().length === 0; },
  details() {
    return {
      bank_name: env.BANK_NAME, account_name: env.BANK_ACCOUNT_NAME, account_number: env.BANK_ACCOUNT_NUMBER,
      swift: env.BANK_SWIFT || null, branch: env.BANK_BRANCH || null, notes: env.BANK_INSTRUCTIONS || null,
    };
  },
  async initiate() { return { status: 'pending' }; },
  async verify(tx) { return { status: tx.status }; },     // cannot be confirmed automatically
};
