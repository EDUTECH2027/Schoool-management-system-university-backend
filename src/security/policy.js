// Password policy: length, not derived from the account identity, not a very common password.
const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'p@ssword1', '12345678', '123456789', '1234567890', '123123123', '11111111', '00000000', '87654321', 'qwertyui', 'qwerty123', 'qwertyuiop', 'azertyui', 'azerty123', 'azertyuiop', 'abc12345', 'abcd1234', 'iloveyou', 'letmein1', 'welcome1', 'welcome12', 'welcome123', 'admin123', 'admin1234', 'administrator', 'changeme', 'changeme1', 'changeme123', 'school123', 'student123', 'teacher123', 'monkey123', 'dragon123', 'football1', 'baseball1', 'sunshine1', 'master123', 'login123', 'test1234', 'default1', 'motdepasse', 'motdepasse1', 'bonjour123', 'cameroun1', 'cameroun123', 'superadmin', 'superadmin123']);

const MIN = 8, MAX = 72;   // bcrypt only uses the first 72 bytes

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

/** → null if acceptable, else a human-readable reason. `ctx` = { email, name, current (current plaintext, optional) }. */
function checkPassword(pw, ctx = {}) {
  if (typeof pw !== 'string' || !pw) return 'Password is required.';
  if (pw.length < MIN) return `Password must be at least ${MIN} characters long.`;
  if (Buffer.byteLength(pw) > MAX) return `Password must be at most ${MAX} bytes long.`;
  if (!pw.trim()) return 'Password cannot be only spaces.';
  const p = norm(pw);
  const email = norm(ctx.email), local = email.split('@')[0];
  if (p === email || (local && p === local)) return 'Password must not be the same as your email address.';
  const name = norm(ctx.name);
  if (name && (p === name || p === [...String(ctx.name || '').toLowerCase().split(/\s+/)].reverse().join(''))) return 'Password must not be the same as your name.';
  if (COMMON.has(p)) return 'This password is too common. Choose something less predictable.';
  if (/^(.)\1+$/.test(pw)) return 'Password cannot be a single repeated character.';
  if (ctx.current !== undefined && pw === ctx.current) return 'The new password must be different from the current one.';
  return null;
}

module.exports = { checkPassword, MIN, MAX, COMMON };
