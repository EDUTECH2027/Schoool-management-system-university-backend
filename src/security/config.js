// Every threshold is read lazily from the environment so tests/deployments can tune it without code changes.
const num = (name, def, min = 0) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && process.env[name] !== '' && process.env[name] !== undefined ? n : def; };

module.exports = {
  loginMaxFailures: () => Math.max(1, Math.floor(num('LOGIN_MAX_FAILURES', 5, 1))),
  loginLockMinutes: () => num('LOGIN_LOCK_MINUTES', 15, 0.01),
  // per-IP / per-account windows on the credential endpoints
  loginIp: () => ({ max: num('RATE_LOGIN_IP_MAX', 60, 1), windowMs: num('RATE_LOGIN_IP_WINDOW_SEC', 900, 1) * 1000 }),
  loginAccount: () => ({ max: num('RATE_LOGIN_ACCOUNT_MAX', 20, 1), windowMs: num('RATE_LOGIN_ACCOUNT_WINDOW_SEC', 900, 1) * 1000 }),
  resetIp: () => ({ max: num('RATE_RESET_IP_MAX', 30, 1), windowMs: num('RATE_RESET_IP_WINDOW_SEC', 900, 1) * 1000 }),
  resetAccount: () => ({ max: num('RATE_RESET_ACCOUNT_MAX', 8, 1), windowMs: num('RATE_RESET_ACCOUNT_WINDOW_SEC', 900, 1) * 1000 }),
  globalApi: () => ({ max: num('RATE_GLOBAL_MAX', 3000, 1), windowMs: num('RATE_GLOBAL_WINDOW_SEC', 60, 1) * 1000 }),
  authCacheMs: () => num('AUTH_USER_CACHE_SEC', 15, 0) * 1000,
  jsonLimit: () => process.env.BODY_LIMIT_DEFAULT || '2mb',
  jsonLimitLarge: () => process.env.BODY_LIMIT_LARGE || '10mb',
  isProd: () => process.env.NODE_ENV === 'production',
};
