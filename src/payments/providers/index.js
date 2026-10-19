const providers = {
  orange_money: require('./orangeMoney'),
  mtn_momo: require('./mtnMomo'),
  bank_transfer: require('./bank'),
  stripe: require('./stripe'),
};

const get = id => providers[id] || null;
const all = () => Object.values(providers);

// What the browser may know about a provider: no secrets, no env var names.
function publicInfo(p) {
  const configured = p.isConfigured();
  return {
    id: p.id, label: p.label, flow: p.flow, requires_phone: !!p.requiresPhone, configured,
    currency: p.currency(),
    ...(p.id === 'bank_transfer' && configured ? { bank: p.details() } : {}),
  };
}

module.exports = { get, all, publicInfo };
