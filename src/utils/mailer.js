// SMTP delivery (nodemailer). Nothing is simulated: without SMTP_HOST the mailer reports "not configured" and the
// outbox worker marks mails as skipped. Settings are read on every call so tests / operators can change the env.
const nodemailer = require('nodemailer');

const cfg = () => ({
  host: process.env.SMTP_HOST || '', port: Number(process.env.SMTP_PORT) || 587,
  user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  secure: /^(1|true|yes|on)$/i.test(process.env.SMTP_SECURE || ''),
});

const isConfigured = () => { const c = cfg(); return !!(c.host && c.from); };

let cached = null, cachedKey = '';
function transport() {
  const c = cfg(); const key = JSON.stringify(c);
  if (cached && key === cachedKey) return cached;
  cached = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure, ...(c.user && { auth: { user: c.user, pass: c.pass } }),
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000,
  });
  cachedKey = key;
  return cached;
}

/** Sends one mail; throws on any SMTP error (the worker records it). */
async function send({ to, subject, text, html }) {
  if (!isConfigured()) throw new Error('SMTP is not configured');
  const c = cfg();
  return transport().sendMail({ from: c.from, to, subject, text, ...(html && { html }) });
}

const status = () => { const c = cfg(); return { configured: isConfigured(), host: c.host ? c.host : null, port: c.host ? c.port : null, from: c.from || null, secure: c.secure, worker: String(process.env.MAIL_WORKER || 'on').toLowerCase() !== 'off' }; };

module.exports = { isConfigured, send, status };
