// Jitsi Meet room access. Secrets stay on the server: the browser only ever
// receives a short-lived signed token for one specific room.
//
// Two supported deployments (pick one via env, see backend/README.md):
//   • Self-hosted Jitsi with JWT auth  → JITSI_DOMAIN + JITSI_APP_ID + JITSI_APP_SECRET (HS256)
//   • 8x8 JaaS (Jitsi as a Service)    → JITSI_JAAS_APP_ID + JITSI_JAAS_KID + JITSI_JAAS_PRIVATE_KEY (RS256)
const jwt = require('jsonwebtoken');

function mode() {
  if (process.env.JITSI_JAAS_APP_ID && process.env.JITSI_JAAS_KID && process.env.JITSI_JAAS_PRIVATE_KEY) return 'jaas';
  if (process.env.JITSI_DOMAIN && process.env.JITSI_APP_ID && process.env.JITSI_APP_SECRET) return 'self';
  return null;
}

const isConfigured = () => mode() !== null;

// Returns { domain, roomName, jwt, scriptUrl } for the given user and room.
function buildAccess({ roomName, user, moderator, ttlSeconds }) {
  const m = mode();
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  const context = {
    user: { id: user.id, name: user.name, email: user.email || undefined, moderator: !!moderator },
    features: { recording: !!moderator, livestreaming: false, 'screen-sharing': !!moderator },
  };

  if (m === 'jaas') {
    const appId = process.env.JITSI_JAAS_APP_ID;
    const key = process.env.JITSI_JAAS_PRIVATE_KEY.replace(/\\n/g, '\n');
    const token = jwt.sign(
      { aud: 'jitsi', iss: 'chat', sub: appId, room: roomName, nbf: now - 10, exp: now + ttlSeconds,
        context: { ...context, user: { ...context.user, moderator: String(!!moderator) } } },
      key,
      { algorithm: 'RS256', header: { kid: process.env.JITSI_JAAS_KID, typ: 'JWT' } },
    );
    return { domain: '8x8.vc', roomName: `${appId}/${roomName}`, jwt: token, scriptUrl: `https://8x8.vc/${appId}/external_api.js` };
  }

  const domain = process.env.JITSI_DOMAIN;
  const token = jwt.sign(
    { aud: 'jitsi', iss: process.env.JITSI_APP_ID, sub: domain, room: roomName, nbf: now - 10, exp: now + ttlSeconds, context },
    process.env.JITSI_APP_SECRET,
    { algorithm: 'HS256' },
  );
  return { domain, roomName, jwt: token, scriptUrl: `https://${domain}/external_api.js` };
}

module.exports = { isConfigured, buildAccess };
