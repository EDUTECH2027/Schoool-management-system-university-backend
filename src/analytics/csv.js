// Minimal RFC 4180 CSV writer. Text cells starting with = + - @ are prefixed with ' so spreadsheets never run them as formulas.
const cell = v => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
function sendCsv(res, filename, rows, columns) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.send(toCsv(rows, columns));
}
module.exports = { toCsv, sendCsv };
