// Validation / formatting helpers for the careers module.
// Free text is stored as plain text (control characters stripped) and rendered escaped by the UI.
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v, max, { multiline = false } = {}) => {
  if (v === undefined || v === null) return undefined;
  let s = String(v).replace(CTRL, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.trim();
  if (s.length > max) { const e = new Error(`Text too long (max ${max} characters)`); e.status = 422; throw e; }
  return s || null;
};
const bad = msg => { const e = new Error(msg); e.status = 422; return e; };
const url = (v, label = 'URL') => {
  const s = clean(v, 500);
  if (!s) return s;
  let u; try { u = new URL(s); } catch { throw bad(`${label} is not a valid URL`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad(`${label} must start with http:// or https://`);
  return u.toString();
};
const email = (v, label = 'E-mail') => {
  const s = clean(v, 160);
  if (!s) return s;
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s)) throw bad(`${label} is not a valid e-mail address`);
  return s;
};
const dateStr = (v, label = 'Date') => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(+d) || d.toISOString().slice(0, 10) !== v) throw bad(`${label} is not a valid date`);
  return v;
};
const today = () => new Date().toISOString().slice(0, 10);
const paging = q => {
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
};
const csvCell = v => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const isStaff = u => ['super_admin', 'head_teacher', 'academic_officer'].includes(u.role);
const actorOf = u => ({ id: u.id, name: u.name, role: u.role === 'head_teacher' ? 'super_admin' : u.role });

module.exports = { clean, url, email, dateStr, today, paging, csvCell, isStaff, actorOf, bad };
