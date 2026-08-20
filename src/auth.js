// Microsoft Entra ID (Azure AD) sign-in via MSAL, using the standard
// OpenID Connect authorization-code flow. This is server-side auth: the
// gate is applied in server.js BEFORE express.static, so unauthenticated
// visitors never receive the app's HTML/JS at all — not just a hidden UI
// behind a login screen.

const { ConfidentialClientApplication } = require('@azure/msal-node');

const required = ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_REDIRECT_URI', 'AUTH_SESSION_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
  }
}

const REDIRECT_URI = process.env.AZURE_REDIRECT_URI; // e.g. https://anchorcgr.up.railway.app/auth/callback
const POST_LOGOUT_REDIRECT_URI =
  process.env.AZURE_POST_LOGOUT_REDIRECT_URI || REDIRECT_URI.replace('/auth/callback', '/');

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    // Single-tenant authority: only accounts in your CGR Entra tenant can
    // even reach the Microsoft sign-in prompt for this app.
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
});

const SCOPES = ['openid', 'profile', 'email'];

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.session.postLoginRedirect = req.originalUrl;
  return res.redirect('/auth/login');
}

module.exports = {
  msalClient,
  REDIRECT_URI,
  POST_LOGOUT_REDIRECT_URI,
  SCOPES,
  requireAuth,
};
