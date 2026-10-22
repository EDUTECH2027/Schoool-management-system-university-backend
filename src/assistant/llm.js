// Chooses the assistant's model provider. ASSISTANT_PROVIDER=qoder|anthropic; unset → qoder when QODER_ACCESS_TOKEN is set, else anthropic.
const anthropic = require('./anthropic');
const qoder = require('./qoder');

const name = () => {
  const v = (process.env.ASSISTANT_PROVIDER || '').trim().toLowerCase();
  if (v === 'qoder' || v === 'anthropic') return v;
  return (process.env.QODER_ACCESS_TOKEN || '').trim() ? 'qoder' : 'anthropic';
};
const impl = () => (name() === 'qoder' ? qoder : anthropic);

module.exports = {
  name,
  isConfigured: () => impl().isConfigured(),
  complete: args => impl().complete(args),
  dailyLimit: () => anthropic.config().dailyLimit,
  UpstreamError: anthropic.UpstreamError,
};
