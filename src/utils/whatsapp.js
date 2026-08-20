const { BirdClient } = require('@messagebird/sdk');

let client = null;
let warned = false;

function getClient() {
  if (client) return client;
  const apiKey = process.env.BIRD_API_KEY;
  if (!apiKey) {
    if (!warned) {
      console.warn('[whatsapp] BIRD_API_KEY not set — outgoing WhatsApp messages will be skipped.');
      warned = true;
    }
    return null;
  }
  client = new BirdClient({ apiKey });
  return client;
}

// WhatsApp only allows business-initiated messages through a pre-approved
// template (freeform text like the old email body isn't allowed), so this
// sends a template message rather than raw HTML/text. Register the template
// in Bird's dashboard first and set BIRD_WHATSAPP_TEMPLATE_SLUG to its slug.
// Never throws — a failed/unconfigured send is logged and swallowed so it
// can't take down the request that triggered it (e.g. school creation).
async function sendWhatsAppTemplate({ to, parameters }) {
  const c = getClient();
  const slug = process.env.BIRD_WHATSAPP_TEMPLATE_SLUG;
  if (!c || !slug) return { sent: false, reason: 'not_configured' };
  try {
    const msg = await c.whatsapp.send({
      to,
      template: {
        slug,
        components: [{ type: 'body', parameters: parameters.map(text => ({ type: 'text', text })) }],
      },
    });
    return { sent: true, id: msg.id };
  } catch (e) {
    console.error('[whatsapp] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendWhatsAppTemplate };
