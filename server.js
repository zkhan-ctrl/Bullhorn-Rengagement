require('dotenv').config();
const express        = require('express');
const axios          = require('axios');
const path           = require('path');
const { spawn }      = require('child_process');
const fs             = require('fs');
const crypto         = require('crypto');
const session   = require('express-session');
const helmet    = require('helmet');
const {
  msalClient,
  REDIRECT_URI,
  POST_LOGOUT_REDIRECT_URI,
  SCOPES,
  requireAuth,
} = require('./src/auth');
const { loadUsers, saveUsers, getUserMap } = require('./src/users-store');

// ─── User config — authorization/config lookup by email, NOT authentication.
// Identity is proven by Entra ID sign-in; this store only controls which
// per-BD Overloop/Instantly keys and admin rights an authenticated user gets.
// Backed by src/users-store.js (a JSON file) instead of the static USERS
// env var, so admins can manage this from the in-app Settings panel
// without a redeploy. Read fresh at login time — see /auth/callback below.

const app = express();
app.use(express.json());

// Railway sits in front of this app behind a proxy — required for
// secure:true cookies to be set correctly over HTTPS.
app.set('trust proxy', 1);

app.use(
  session({
    name: 'anchor_sid',
    secret: process.env.AUTH_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

app.use(helmet({
  // The app's own inline <script> tags in public/index.html would be
  // blocked by helmet's default (restrictive) Content-Security-Policy,
  // so that sub-module is disabled here; frame-ancestors is set
  // explicitly below instead, which is the one CSP directive that
  // actually matters for this app's threat model (clickjacking).
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use((req, res, next) => {
  // Only this app's own pages may frame it — closes the clickjacking
  // gap left by the previous "frame-ancestors *" override. helmet's
  // frameguard() above already sends X-Frame-Options: SAMEORIGIN for
  // older browsers; this CSP header is what modern browsers actually
  // honor.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
});

// ─── Auth routes — reachable WITHOUT a session ─────────────────────────────
app.get('/auth/login', async (req, res) => {
  try {
    // A random, session-bound state value — checked on the way back in
    // /auth/callback so a stray/attacker-supplied authorization code
    // aimed at this callback can't be swapped in for a real login
    // (authorization code injection protection).
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;

    const authCodeUrlParameters = { scopes: SCOPES, redirectUri: REDIRECT_URI, state };
    // ?switch=1 forces Microsoft's account picker instead of silently
    // reusing whatever Microsoft account is already signed in on this
    // browser (used by the "not provisioned" page's "try a different
    // account" link).
    if (req.query.switch === '1') {
      authCodeUrlParameters.prompt = 'select_account';
    }
    const authUrl = await msalClient.getAuthCodeUrl(authCodeUrlParameters);
    res.redirect(authUrl);
  } catch (err) {
    console.error('Login redirect error:', err);
    res.status(500).send('Sign-in is not configured correctly. Contact IT.');
  }
});

app.get('/auth/callback', async (req, res) => {
  if (req.query.error) {
    console.error('Entra returned an error:', req.query.error, req.query.error_description);
    return res.status(401).send('Sign-in failed or was cancelled.');
  }

  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (!expectedState || req.query.state !== expectedState) {
    console.warn('Auth callback rejected: state mismatch (possible CSRF/replay attempt)');
    return res.status(401).send('Sign-in session expired or invalid. Please try signing in again.');
  }

  try {
    const tokenResponse = await msalClient.acquireTokenByCode({
      code: req.query.code,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
    });

    const email = tokenResponse.account.username.toLowerCase(); // UPN, e.g. user@cgrteam.com
    const config = getUserMap().get(email);
    if (!config) {
      console.warn(`Blocked sign-in from ${email}: not provisioned in USERS`);
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Anchor — Not provisioned</title></head>
        <body style="font-family: -apple-system, Segoe UI, sans-serif; background:#0a0f1e; color:#e5e7eb; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0;">
          <div style="max-width:420px; text-align:center; padding:32px;">
            <h1 style="font-size:20px; margin-bottom:12px;">Account not authorized</h1>
            <p style="color:#9ca3af; line-height:1.5;">
              You signed in successfully as <strong>${email}</strong>, but this account
              isn't provisioned for Anchor. Contact IT to be added, or try a different account.
            </p>
            <a href="/auth/login?switch=1" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#2563eb; color:white; border-radius:8px; text-decoration:none; font-weight:500;">
              Try a different Microsoft account
            </a>
          </div>
        </body>
        </html>
      `);
    }

    req.session.user = {
      email,
      name: config.name || tokenResponse.account.name,
      admin: config.admin,
      overloop_key: config.overloop_key,
      instantly_key: config.instantly_key,
    };
    const dest = req.session.postLoginRedirect || '/';
    delete req.session.postLoginRedirect;
    res.redirect(dest);
  } catch (err) {
    console.error('Auth callback error:', err);
    res.status(500).send('Sign-in failed. Please try again.');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    const logoutUrl =
      `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/logout` +
      `?post_logout_redirect_uri=${encodeURIComponent(POST_LOGOUT_REDIRECT_URI)}`;
    res.redirect(logoutUrl);
  });
});

// ─── Everything below requires a signed-in, provisioned session ───────────
app.use(requireAuth);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/me', (req, res) => {
  const { email, name, admin } = req.session.user;
  res.json({ email, name, admin });
});

// ─── Admin: manage the USERS list from Settings — no redeploy needed ──────
function requireAdmin(req, res, next) {
  if (!req.session.user?.admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// List all provisioned users (admin only). Full record, including keys,
// is returned because only admins can reach this route — same visibility
// they already had via the Railway USERS variable.
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(loadUsers());
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { email, name, admin, overloop_key, instantly_key } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  const users = loadUsers();
  const normalizedEmail = email.trim().toLowerCase();
  if (users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
    return res.status(409).json({ error: 'That email is already provisioned' });
  }
  users.push({
    email: normalizedEmail,
    name: name || '',
    admin: !!admin,
    overloop_key: overloop_key || undefined,
    instantly_key: instantly_key || undefined,
  });
  saveUsers(users);
  res.json({ ok: true });
});

app.put('/api/admin/users/:email', requireAdmin, (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
  const users = loadUsers();
  const idx = users.findIndex((u) => u.email.toLowerCase() === targetEmail);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { name, admin, overloop_key, instantly_key } = req.body || {};

  // Guard: don't allow removing the last remaining admin (including
  // demoting yourself if you're the only one), to prevent locking
  // everyone out of the admin panel entirely.
  const isDemotingLastAdmin =
    users[idx].admin && admin === false && users.filter((u) => u.admin).length === 1;
  if (isDemotingLastAdmin) {
    return res.status(400).json({ error: 'Cannot remove the last remaining admin' });
  }

  users[idx] = {
    ...users[idx],
    ...(name !== undefined && { name }),
    ...(admin !== undefined && { admin: !!admin }),
    ...(overloop_key !== undefined && { overloop_key }),
    ...(instantly_key !== undefined && { instantly_key }),
  };
  saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:email', requireAdmin, (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
  const users = loadUsers();
  const target = users.find((u) => u.email.toLowerCase() === targetEmail);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.admin && users.filter((u) => u.admin).length === 1) {
    return res.status(400).json({ error: 'Cannot remove the last remaining admin' });
  }
  if (targetEmail === req.session.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot remove your own account while signed in' });
  }

  saveUsers(users.filter((u) => u.email.toLowerCase() !== targetEmail));
  res.json({ ok: true });
});

// ─── Overloop outreach integration ────────────────────────────────────────────
const OVERLOOP_BASE = 'https://api.overloop.ai/public/v1';

function overloopHeaders(key) {
  return {
    'Authorization': key,   // Overloop API: raw key, no "apikey" prefix
    'Content-Type':  'application/vnd.api+json',
    'Accept':        'application/vnd.api+json',
  };
}


// Create prospect + enroll in a sequence (single or bulk contacts)
app.post('/api/overloop/enroll', async (req, res) => {
  const key = req.session.user?.overloop_key;
  if (!key) return res.status(400).json({ error: 'No Overloop API key configured for your account.' });

  const { contacts, sequenceId } = req.body || {};
  // contacts = [{ firstName, lastName, email, companyName }, ...]
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'No contacts provided.' });
  if (!sequenceId) return res.status(400).json({ error: 'No sequence selected.' });

  const hdrs = overloopHeaders(key);
  const results = [];

  for (const ct of contacts) {
    const { firstName = '', lastName = '', email, companyName = '' } = ct;
    if (!email) { results.push({ email: '', ok: false, error: 'Missing email' }); continue; }

    try {
      // Create prospect — Overloop returns 422 if email already exists
      let prospectId;
      try {
        const pRes = await axios.post(`${OVERLOOP_BASE}/prospects`, {
          data: {
            type: 'prospects',
            attributes: { email, first_name: firstName, last_name: lastName, organization_name: companyName },
          }
        }, { headers: hdrs });
        prospectId = pRes.data.data.id;
      } catch (pErr) {
        if (pErr.response?.status === 422) {
          // Already exists — look up by email
          const search = await axios.get(
            `${OVERLOOP_BASE}/prospects?filter[email]=${encodeURIComponent(email)}`,
            { headers: hdrs }
          );
          prospectId = search.data?.data?.[0]?.id;
          if (!prospectId) throw pErr;
        } else throw pErr;
      }

      // Enroll in sequence
      await axios.post(`${OVERLOOP_BASE}/sequence_states`, {
        data: {
          type: 'sequence_states',
          attributes: {},
          relationships: {
            prospect: { data: { type: 'prospects', id: String(prospectId) } },
            sequence:  { data: { type: 'sequences',  id: String(sequenceId)  } },
          },
        }
      }, { headers: hdrs });

      results.push({ email, ok: true, prospectId });
    } catch (e) {
      const detail = e.response?.data?.errors?.[0]?.detail || e.message;
      results.push({ email, ok: false, error: detail });
    }
  }

  const failed = results.filter(r => !r.ok);
  res.json({ results, enrolled: results.length - failed.length, failed: failed.length });
});

// Bulk enroll all contacts from multiple T3/T4 companies into a sequence
app.post('/api/overloop/bulk-enroll', async (req, res) => {
  const key = req.session.user?.overloop_key;
  if (!key) return res.status(400).json({ error: 'No Overloop API key configured for your account.' });

  const { companies, sequenceId, jobTitle, jobUrl } = req.body || {};
  if (!Array.isArray(companies) || !companies.length) return res.status(400).json({ error: 'No companies provided.' });
  if (!sequenceId) return res.status(400).json({ error: 'No sequence selected.' });

  const hdrs = overloopHeaders(key);
  let enrolled = 0, failed = 0, skippedNoContacts = 0;

  // Fetch all contacts in a single CData query using IN clause
  const idList = companies.map(c => parseInt(c.id)).filter(Boolean).join(',');
  const nameMap = Object.fromEntries(companies.map(c => [String(c.id), c.name || '']));

  let contactRows = [];
  try {
    contactRows = await cdataQuery(
      `SELECT TOP 2000 Companyid, FirstName, LastName, Email1
       FROM ${T('ClientContact')}
       WHERE Companyid IN (${idList}) AND Email1 IS NOT NULL AND Email1 <> ''
       ORDER BY Companyid`
    );
  } catch (e) {
    return res.status(500).json({ error: `Failed to fetch contacts: ${e.message}` });
  }

  // Group contacts by company
  const byCompany = {};
  for (const row of contactRows) {
    const cid = String(row.Companyid);
    if (!byCompany[cid]) byCompany[cid] = [];
    const email = (row.Email1 || '').trim();
    if (email) byCompany[cid].push({ email, firstName: row.FirstName || '', lastName: row.LastName || '', companyName: nameMap[cid] || '' });
  }

  for (const co of companies) {
    const cid = String(co.id);
    const contacts = byCompany[cid] || [];
    if (!contacts.length) { skippedNoContacts++; continue; }

    for (const ct of contacts) {
      try {
        const attrs = {
          email: ct.email, first_name: ct.firstName, last_name: ct.lastName,
          organization_name: ct.companyName,
        };
        if (jobTitle) attrs.job_title = jobTitle;
        if (jobUrl)   attrs.website   = jobUrl;

        let prospectId;
        try {
          const pRes = await axios.post(`${OVERLOOP_BASE}/prospects`, {
            data: { type: 'prospects', attributes: attrs }
          }, { headers: hdrs });
          prospectId = pRes.data.data.id;
        } catch (pErr) {
          if (pErr.response?.status === 422) {
            const search = await axios.get(
              `${OVERLOOP_BASE}/prospects?filter[email]=${encodeURIComponent(ct.email)}`,
              { headers: hdrs }
            );
            prospectId = search.data?.data?.[0]?.id;
            // Update job fields on existing prospect if we have them
            if (prospectId && (jobTitle || jobUrl)) {
              await axios.patch(`${OVERLOOP_BASE}/prospects/${prospectId}`, {
                data: { type: 'prospects', id: String(prospectId), attributes: attrs }
              }, { headers: hdrs }).catch(() => {});
            }
            if (!prospectId) throw pErr;
          } else throw pErr;
        }

        await axios.post(`${OVERLOOP_BASE}/sequence_states`, {
          data: {
            type: 'sequence_states',
            attributes: {},
            relationships: {
              prospect: { data: { type: 'prospects', id: String(prospectId) } },
              sequence:  { data: { type: 'sequences',  id: String(sequenceId)  } },
            },
          }
        }, { headers: hdrs });

        enrolled++;
      } catch (e) {
        failed++;
      }
    }
  }

  res.json({ enrolled, failed, skippedNoContacts });
});

// Campaign Builder enrollment — per-company job summaries pre-computed client-side
app.post('/api/overloop/campaign-enroll', async (req, res) => {
  const key = req.session.user?.overloop_key;
  if (!key) return res.status(400).json({ error: 'No Overloop API key configured for your account.' });

  const { companies, sequenceId } = req.body || {};
  // companies = [{ id, name, jobSummary, primaryJobUrl }, ...]
  if (!Array.isArray(companies) || !companies.length) return res.status(400).json({ error: 'No companies provided.' });
  if (!sequenceId) return res.status(400).json({ error: 'No sequence selected.' });

  const hdrs = overloopHeaders(key);
  let enrolled = 0, failed = 0, skippedNoContacts = 0;

  const idList    = companies.map(c => parseInt(c.id)).filter(Boolean).join(',');
  const companyMap = Object.fromEntries(companies.map(c => [String(c.id), c]));

  let contactRows = [];
  try {
    contactRows = await cdataQuery(
      `SELECT TOP 2000 Companyid, FirstName, LastName, Email1
       FROM ${T('ClientContact')}
       WHERE Companyid IN (${idList}) AND Email1 IS NOT NULL AND Email1 <> ''
       ORDER BY Companyid`
    );
  } catch (e) {
    return res.status(500).json({ error: `Failed to fetch contacts: ${e.message}` });
  }

  const byCompany = {};
  for (const row of contactRows) {
    const cid = String(row.Companyid);
    if (!byCompany[cid]) byCompany[cid] = [];
    const email = (row.Email1 || '').trim();
    if (email) byCompany[cid].push({ email, firstName: row.FirstName || '', lastName: row.LastName || '' });
  }

  for (const co of companies) {
    const cid      = String(co.id);
    const contacts = byCompany[cid] || [];
    if (!contacts.length) { skippedNoContacts++; continue; }

    for (const ct of contacts) {
      try {
        const attrs = {
          email: ct.email, first_name: ct.firstName, last_name: ct.lastName,
          organization_name: co.name || '',
        };
        if (co.jobSummary)    attrs.job_title = co.jobSummary;
        if (co.primaryJobUrl) attrs.website   = co.primaryJobUrl;

        let prospectId;
        try {
          const pRes = await axios.post(`${OVERLOOP_BASE}/prospects`,
            { data: { type: 'prospects', attributes: attrs } }, { headers: hdrs });
          prospectId = pRes.data.data.id;
        } catch (pErr) {
          if (pErr.response?.status === 422) {
            const search = await axios.get(
              `${OVERLOOP_BASE}/prospects?filter[email]=${encodeURIComponent(ct.email)}`,
              { headers: hdrs }
            );
            prospectId = search.data?.data?.[0]?.id;
            if (prospectId) {
              await axios.patch(`${OVERLOOP_BASE}/prospects/${prospectId}`,
                { data: { type: 'prospects', id: String(prospectId), attributes: attrs } },
                { headers: hdrs }).catch(() => {});
            }
            if (!prospectId) throw pErr;
          } else throw pErr;
        }

        await axios.post(`${OVERLOOP_BASE}/sequence_states`, {
          data: {
            type: 'sequence_states', attributes: {},
            relationships: {
              prospect: { data: { type: 'prospects', id: String(prospectId) } },
              sequence:  { data: { type: 'sequences',  id: String(sequenceId)  } },
            },
          }
        }, { headers: hdrs });

        enrolled++;
      } catch (e) {
        failed++;
      }
    }
  }

  res.json({ enrolled, failed, skippedNoContacts });
});

// Test-enroll a single prospect into an Overloop list (for connection testing)
// Enrollment in Overloop v2: add prospect with lists:[listName] → auto-enrolls in connected automation
app.post('/api/overloop/test-enroll', async (req, res) => {
  const key = req.session.user?.overloop_key;
  if (!key) return res.status(400).json({ error: 'No Overloop API key configured for your account.' });

  const { listName, email, firstName = '', lastName = '', companyName = '', jobTitle = '' } = req.body || {};
  if (!email)    return res.status(400).json({ error: 'email is required' });
  if (!listName) return res.status(400).json({ error: 'listName is required' });

  const hdrs  = overloopHeaders(key);
  const attrs = { email, first_name: firstName, last_name: lastName, organization_name: companyName, lists: [listName] };
  if (jobTitle) attrs.job_title = jobTitle;

  try {
    const pRes = await axios.post(`${OVERLOOP_BASE}/prospects`, { data: { type: 'prospects', attributes: attrs } }, { headers: hdrs });
    return res.json({ ok: true, prospectId: pRes.data?.data?.id, listName });
  } catch (pErr) {
    if (pErr.response?.status === 422) {
      // Prospect exists — patch to add the list
      const search = await axios.get(`${OVERLOOP_BASE}/prospects?filter[email]=${encodeURIComponent(email)}`, { headers: hdrs }).catch(() => null);
      const prospectId = search?.data?.data?.[0]?.id;
      if (prospectId) {
        await axios.patch(`${OVERLOOP_BASE}/prospects/${prospectId}`,
          { data: { type: 'prospects', id: String(prospectId), attributes: { lists: [listName], job_title: jobTitle || undefined } } },
          { headers: hdrs }).catch(() => {});
        return res.json({ ok: true, prospectId, listName });
      }
    }
    const detail = pErr.response?.data?.errors?.[0]?.detail || pErr.message;
    return res.status(400).json({ error: `Could not create prospect: ${detail}` });
  }
});

// Enroll company contacts into an Overloop automation via list membership
app.post('/api/overloop/create-and-enroll', async (req, res) => {
  const key = req.session.user?.overloop_key;
  if (!key) return res.status(400).json({ error: 'No Overloop API key configured for your account.' });

  const { companies, campaignName, listName } = req.body || {};
  if (!Array.isArray(companies) || !companies.length) return res.status(400).json({ error: 'No companies provided.' });
  if (!listName) return res.status(400).json({ error: 'No Overloop list name provided.' });

  const hdrs = overloopHeaders(key);

  // Fetch contacts from CData for all companies
  const idList = companies.map(c => parseInt(c.id)).filter(Boolean).join(',');
  let contactRows = [];
  try {
    if (idList) {
      contactRows = await cdataQuery(
        `SELECT TOP 2000 Companyid, FirstName, LastName, Email1, Email2
         FROM ${T('ClientContact')}
         WHERE Companyid IN (${idList})
         ORDER BY Companyid`
      );
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to fetch contacts: ${e.message}` });
  }

  const isEmailStr = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
  const byCompany = {};

  // Inject demo company contact (id 99999 — not in Bullhorn)
  if (companies.some(c => String(c.id) === '99999')) {
    byCompany['99999'] = [{ email: 'zkhan@cgrteam.com', firstName: 'Zohair', lastName: 'Khan' }];
  }
  for (const row of contactRows) {
    const cid      = String(row.Companyid);
    const lastIsEml = isEmailStr(row.LastName);
    const email    = (row.Email1 || row.Email2 || (lastIsEml ? row.LastName : '') || '').trim();
    if (!email) continue;
    if (!byCompany[cid]) byCompany[cid] = [];
    byCompany[cid].push({ email, firstName: row.FirstName || '', lastName: lastIsEml ? '' : (row.LastName || '') });
  }

  let enrolled = 0, failed = 0, skippedNoContacts = 0;

  for (const co of companies) {
    const contacts = byCompany[String(co.id)] || [];
    if (!contacts.length) { skippedNoContacts++; continue; }

    for (const ct of contacts) {
      try {
        const attrs = {
          email: ct.email, first_name: ct.firstName, last_name: ct.lastName,
          organization_name: co.name || '',
          lists: [listName],
        };
        if (co.jobSummary)    attrs.job_title = co.jobSummary;
        if (co.primaryJobUrl) attrs.website   = co.primaryJobUrl;

        try {
          await axios.post(`${OVERLOOP_BASE}/prospects`,
            { data: { type: 'prospects', attributes: attrs } }, { headers: hdrs });
        } catch (pErr) {
          if (pErr.response?.status === 422) {
            // Prospect exists — patch to update job info and add list
            const search = await axios.get(
              `${OVERLOOP_BASE}/prospects?filter[email]=${encodeURIComponent(ct.email)}`, { headers: hdrs }
            );
            const pid = search.data?.data?.[0]?.id;
            if (pid) await axios.patch(`${OVERLOOP_BASE}/prospects/${pid}`,
              { data: { type: 'prospects', id: String(pid), attributes: attrs } }, { headers: hdrs });
            else throw pErr;
          } else throw pErr;
        }
        enrolled++;
      } catch (e) {
        failed++;
      }
    }
  }

  res.json({ listName, campaignName: campaignName || listName, enrolled, failed, skippedNoContacts });
});

// ─── Instantly.ai outreach integration ───────────────────────────────────────
const INSTANTLY_BASE = 'https://api.instantly.ai';

function instantlyHeaders(key) {
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// List campaigns for dropdown
app.get('/api/instantly/campaigns', async (req, res) => {
  const key = req.session.user?.instantly_key;
  if (!key) return res.status(400).json({ error: 'No Instantly API key configured for your account.' });
  try {
    const r = await axios.get(`${INSTANTLY_BASE}/api/v2/campaigns`, {
      headers: instantlyHeaders(key),
      params: { limit: 100 },
    });
    const items = Array.isArray(r.data?.items) ? r.data.items : (Array.isArray(r.data) ? r.data : []);
    res.json({ campaigns: items.map(c => ({ id: c.id, name: c.name, status: c.status })) });
  } catch (e) {
    const detail = e.response?.data?.message || e.message;
    res.status(e.response?.status || 500).json({ error: detail });
  }
});

// Test-enroll a single lead into an Instantly campaign
app.post('/api/instantly/test-enroll', async (req, res) => {
  const key = req.session.user?.instantly_key;
  if (!key) return res.status(400).json({ error: 'No Instantly API key configured for your account.' });

  const { campaignId, email, firstName = '', lastName = '', companyName = '', jobSummary = '' } = req.body || {};
  if (!email)      return res.status(400).json({ error: 'email is required' });
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  const lead = { email, first_name: firstName, last_name: lastName, company_name: companyName };
  if (jobSummary) lead.custom_variables = { consolidated_job_descriptions: jobSummary };

  try {
    await axios.post(`${INSTANTLY_BASE}/api/v2/leads/add`, {
      campaign_id: campaignId, leads: [lead], skip_if_in_workspace: false,
    }, { headers: instantlyHeaders(key) });
    res.json({ ok: true, campaignId });
  } catch (e) {
    const detail = e.response?.data?.message || e.message;
    res.status(e.response?.status || 400).json({ error: detail });
  }
});

// Campaign Builder bulk-enroll into an Instantly campaign
app.post('/api/instantly/create-and-enroll', async (req, res) => {
  const key = req.session.user?.instantly_key;
  if (!key) return res.status(400).json({ error: 'No Instantly API key configured for your account.' });

  const { companies, campaignName, campaignId } = req.body || {};
  if (!Array.isArray(companies) || !companies.length) return res.status(400).json({ error: 'No companies provided.' });
  if (!campaignId) return res.status(400).json({ error: 'No campaign selected.' });

  const realIds = companies.map(c => parseInt(c.id)).filter(id => id && id !== 99999);
  let contactRows = [];
  if (realIds.length) {
    try {
      contactRows = await cdataQuery(
        `SELECT TOP 2000 Companyid, FirstName, LastName, Email1, Email2
         FROM ${T('ClientContact')}
         WHERE Companyid IN (${realIds.join(',')})
         ORDER BY Companyid`
      );
    } catch (e) {
      return res.status(500).json({ error: `Failed to fetch contacts: ${e.message}` });
    }
  }

  const isEmailStr = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
  const byCompany = {};

  if (companies.some(c => String(c.id) === '99999')) {
    byCompany['99999'] = [{ email: 'zkhan@cgrteam.com', firstName: 'Zohair', lastName: 'Khan' }];
  }
  for (const row of contactRows) {
    const cid      = String(row.Companyid);
    const lastIsEml = isEmailStr(row.LastName);
    const email    = (row.Email1 || row.Email2 || (lastIsEml ? row.LastName : '') || '').trim();
    if (!email) continue;
    if (!byCompany[cid]) byCompany[cid] = [];
    byCompany[cid].push({ email, firstName: row.FirstName || '', lastName: lastIsEml ? '' : (row.LastName || '') });
  }

  const allLeads = [];
  let skippedNoContacts = 0;

  for (const co of companies) {
    const contacts = byCompany[String(co.id)] || [];
    if (!contacts.length) { skippedNoContacts++; continue; }
    for (const ct of contacts) {
      const lead = { email: ct.email, first_name: ct.firstName, last_name: ct.lastName, company_name: co.name || '' };
      if (co.jobSummary)    lead.custom_variables = { consolidated_job_descriptions: co.jobSummary };
      if (co.primaryJobUrl) lead.website           = co.primaryJobUrl;
      allLeads.push(lead);
    }
  }

  if (!allLeads.length) {
    return res.json({ campaignId, campaignName: campaignName || '', enrolled: 0, failed: 0, skippedNoContacts });
  }

  let enrolled = 0, failed = 0;
  for (let i = 0; i < allLeads.length; i += 1000) {
    const chunk = allLeads.slice(i, i + 1000);
    try {
      await axios.post(`${INSTANTLY_BASE}/api/v2/leads/add`, {
        campaign_id: campaignId, leads: chunk, skip_if_in_workspace: false,
      }, { headers: instantlyHeaders(key) });
      enrolled += chunk.length;
    } catch (e) {
      failed += chunk.length;
    }
  }

  res.json({ campaignId, campaignName: campaignName || '', enrolled, failed, skippedNoContacts });
});

// Analytics overview + per-campaign breakdown
app.get('/api/instantly/analytics', async (req, res) => {
  const key = req.session.user?.instantly_key;
  if (!key) return res.status(400).json({ error: 'No Instantly API key configured for your account.' });
  try {
    const hdrs = instantlyHeaders(key);
    const [overviewRes, campaignsRes] = await Promise.all([
      axios.get(`${INSTANTLY_BASE}/api/v2/campaigns/analytics/overview`, { headers: hdrs }).catch(e => ({ data: null })),
      axios.get(`${INSTANTLY_BASE}/api/v2/campaigns`, { headers: hdrs, params: { limit: 100 } }).catch(e => ({ data: null })),
    ]);

    const overview = overviewRes.data || {};
    const campaigns = (() => {
      const raw = campaignsRes.data;
      return Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
    })();

    // Fetch per-campaign analytics in parallel (up to 20 campaigns)
    const top = campaigns.slice(0, 20);
    const analyticsResults = await Promise.all(
      top.map(c =>
        axios.get(`${INSTANTLY_BASE}/api/v2/campaigns/analytics`, { headers: hdrs, params: { campaign_id: c.id } })
          .then(r => r.data)
          .catch(() => null)
      )
    );

    const enriched = top.map((c, i) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      metrics: analyticsResults[i] || {},
    }));

    res.json({ overview, campaigns: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const externalJobCache = new Map();

// ─── CData Connect AI — SQL Query API ─────────────────────────────────────────
const CDATA_API        = 'https://cloud.cdata.com/api/query';
const CDATA_CONNECTION = 'BullhornCRM1';
const T                = (name) => `BullhornCRM1.BullhornCRM.${name}`;

async function cdataQuery(sql) {
  const auth = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  try {
    const r  = await axios.post(
      CDATA_API,
      { query: sql, connection: CDATA_CONNECTION },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    const rs = r.data.results?.[0];
    if (!rs?.schema || !rs?.rows) return [];
    const cols = rs.schema.map(c => c.columnName);
    return rs.rows.map(row => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
    throw new Error(`CData: ${msg}`);
  }
}

// ─── FK field names ────────────────────────────────────────────────────────────
// CData's Bullhorn connector uses 'Companyid' as the FK to ClientCorporation in
// Placement, ClientContact, and JobOrder (confirmed from live schema inspection).
// Hard-coded here to avoid heavy SELECT * probes at startup that hit rate limits.

const FIELD = {
  placementCorpField: 'Companyid',
  jobOrderCorpField:  'Companyid',
};

// ─── Placement query helpers ─────────────────────────────────────────────────
function placementCorpSql_recent(cutoff) {
  return `SELECT TOP 2000 ${FIELD.placementCorpField} AS ClientCorporationid
          FROM ${T('Placement')}
          WHERE ${FIELD.placementCorpField} IS NOT NULL AND DateAdded > '${cutoff}'`;
}

// Fetch all recent placements ordered newest-first so we can find lastPlaced per company
// without an IN (500 IDs) clause, which exceeds CData's query length limit.
function placementCorpSql_last() {
  return `SELECT TOP 5000 ${FIELD.placementCorpField} AS ClientCorporationid, DateAdded
          FROM ${T('Placement')}
          ORDER BY DateAdded DESC`;
}


// ─── Routes ───────────────────────────────────────────────────────────────────

// Admin-only: check which CData columns contain score data for a specific company
// GET /api/admin/score-fields?id=47758
app.get('/api/admin/score-fields', async (req, res) => {
  if (!req.session.user?.admin) return res.status(403).json({ error: 'Admin only' });
  const companyId = parseInt(req.query.id) || 47758;
  try {
    const rows = await cdataQuery(
      `SELECT TOP 1 * FROM ${T('ClientCorporation')} WHERE id = ${companyId}`
    );
    if (!rows.length) return res.json({ error: `Company ${companyId} not found` });
    const row = rows[0];
    // Return only columns that are non-null and whose name looks like a custom or score field
    const scoreKeywords = /score|tier|rank|rating|client|dh|contract|custom/i;
    const relevant = Object.entries(row)
      .filter(([k, v]) => v != null && v !== '' && scoreKeywords.test(k))
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
    const allNonNull = Object.entries(row)
      .filter(([, v]) => v != null && v !== '')
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
    res.json({ companyId, scoreRelatedColumns: relevant, allNonNullColumns: allNonNull });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug — inspect any table: GET /api/debug?table=Placement
app.get('/api/debug', requireAdmin, async (req, res) => {
  const auth  = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  const table = (req.query.table || 'ClientCorporation').replace(/[^a-zA-Z]/g, '');
  const sql   = `SELECT TOP 2 * FROM BullhornCRM1.BullhornCRM.${table}`;
  try {
    const r  = await axios.post(CDATA_API, { query: sql, connection: CDATA_CONNECTION },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
    const rs = r.data.results?.[0];
    res.json({
      sql,
      httpStatus: r.status,
      rawResultCount: r.data.results?.length,
      rawResult: rs,
      columns: rs?.schema?.map(c => c.columnName) || [],
      rows: rs?.rows?.length || 0,
      firstRow: rs?.rows?.[0]
    });
  } catch (e) {
    res.json({ sql, error: e.message, httpStatus: e.response?.status, raw: e.response?.data });
  }
});

// Debug — show auto-detected field names + column lists for Placement & JobOrder
app.get('/api/debug-fields', requireAdmin, async (req, res) => {
  const auth = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  const result = { detected: FIELD };
  for (const table of ['Placement', 'JobOrder', 'ClientContact', 'ClientCorporation']) {
    try {
      const r  = await axios.post(CDATA_API,
        { query: `SELECT TOP 1 * FROM BullhornCRM1.BullhornCRM.${table}`, connection: CDATA_CONNECTION },
        { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
      result[table] = r.data.results?.[0]?.schema?.map(c => c.columnName) || [];
    } catch (e) {
      result[table] = { error: e.message };
    }
  }
  res.json(result);
});

// Debug — run an arbitrary SELECT (read-only): GET /api/debug-sql?q=SELECT+TOP+5+ID,Title+FROM+JobOrder
app.get('/api/debug-sql', requireAdmin, async (req, res) => {
  const sql = (req.query.q || '').trim();
  if (!sql || !/^select\b/i.test(sql)) return res.status(400).json({ error: 'Only SELECT queries allowed' });
  try {
    const rows = await cdataQuery(sql);
    res.json({ sql, rows, count: rows.length, cols: rows.length ? Object.keys(rows[0]) : [] });
  } catch (e) {
    res.json({ sql, error: e.message });
  }
});

// Health check
app.get('/api/status', requireAdmin, async (req, res) => {
  const needed  = ['CDATA_USER', 'CDATA_PAT'];
  const missing = needed.filter(k => !process.env[k]);
  if (missing.length) return res.json({ ok: false, missing });
  try {
    await cdataQuery(`SELECT TOP 1 ID FROM ${T('ClientCorporation')}`);
    res.json({ ok: true, aiEnabled: !!process.env.ANTHROPIC_API_KEY, adzunaEnabled: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Field discovery for Settings panel
app.get('/api/meta/company-fields', async (req, res) => {
  try {
    const rows = await cdataQuery(`SELECT TOP 1 * FROM ${T('ClientCorporation')}`);
    if (!rows.length) return res.json([]);
    res.json(Object.keys(rows[0]).map(k => ({
      name: k, label: k,
      type: typeof rows[0][k] === 'number' ? 'Integer' : 'String'
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All Active Account companies with live DH/CT scores from Bullhorn
app.get('/api/stale-companies', async (req, res) => {
  try {
    const rows = await cdataQuery(
      `SELECT TOP 1000 ID, CompanyName, BusinessSectors, CompanyWebsite,
              BusinessDevelopmentManager, OwnerAM,
              DHScore, DHTier, ContractingScore, ContractingTier
       FROM ${T('ClientCorporation')}
       WHERE Status = 'Active Account'
       ORDER BY CompanyName`
    );

    const bdOwners = [...new Set(
      rows.map(c => c.BusinessDevelopmentManager).filter(Boolean)
    )].sort();

    const result = rows.map(c => {
      const bdName   = c.BusinessDevelopmentManager || 'Unassigned';
      const initials = bdName !== 'Unassigned'
        ? bdName.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
        : '?';

      let website = c.CompanyWebsite ? c.CompanyWebsite.trim() : null;
      if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

      return {
        id:               c.ID,
        name:             c.CompanyName,
        industry:         c.BusinessSectors || 'N/A',
        dhScore:          c.DHScore          != null ? Number(c.DHScore)          : null,
        dhTier:           c.DHTier           != null ? Number(c.DHTier)           : null,
        contractingScore: c.ContractingScore != null ? Number(c.ContractingScore) : null,
        contractingTier:  c.ContractingTier  != null ? Number(c.ContractingTier)  : null,
        bdOwner:          bdName,
        bdOwnerInitials:  initials,
        ownerAM:          c.OwnerAM || null,
        website
      };
    });

    // Inject demo company (fake ID 99999 — used for Campaign Builder testing)
    const DEMO = {
      id: 99999, name: 'Example Company (Demo)', industry: 'Energy / Marine',
      dhScore: null, dhTier: 4, contractingScore: null, contractingTier: 4,
      bdOwner: 'Zohair Khan', bdOwnerInitials: 'ZK', ownerAM: null, website: null,
    };
    result.unshift(DEMO);
    const allBdOwners = ['Zohair Khan', ...bdOwners.filter(b => b !== 'Zohair Khan')];

    res.json({ data: result, total: result.length, bdOwners: allBdOwners });
  } catch (e) {
    console.error('stale-companies:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Contacts for a company
app.get('/api/company/:id/contacts', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });

  // Demo company — return hardcoded contact
  if (id === 99999) {
    return res.json({
      Sales: [{ id: 1, name: 'Zohair Khan', title: 'Business Development Manager', email: 'zkhan@cgrteam.com', phone: '', initials: 'ZK' }],
      Recruiting: [], HR: [], Ops: [], Other: []
    });
  }
  try {
    const isEmailStr = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
    const hasEmail   = r => isEmailStr(r.Email1) || isEmailStr(r.Email2) || isEmailStr(r.LastName);

    // First try Active contacts. If none have a usable email, fall back to all statuses.
    // (The old fallback triggered on 0 rows, which missed companies where Active contacts
    // exist but have no email while New Lead contacts do — e.g. Memorial Hermann 149 contacts.)
    let rows = await cdataQuery(
      `SELECT TOP 100 ID, FirstName, LastName, Title,
              Email1, Email2, DirectPhone AS Phone, MobilePhone
       FROM ${T('ClientContact')}
       WHERE Companyid = ${id} AND Status = 'Active'`
    );
    if (!rows.some(hasEmail)) {
      rows = await cdataQuery(
        `SELECT TOP 100 ID, FirstName, LastName, Title,
                Email1, Email2, DirectPhone AS Phone, MobilePhone
         FROM ${T('ClientContact')}
         WHERE Companyid = ${id}`
      );
    }

    const cats  = { Recruiting: [], Sales: [], HR: [], Ops: [], Other: [] };
    const rules = [
      ['Recruiting', /talent|recruit|acquisition|sourcing/i],
      ['Sales',      /sales|business dev|\bbd\b|account exec/i],
      ['HR',         /human res|\bhr\b|people ops|personnel/i],
      ['Ops',        /operat|\bcoo\b|chief operat|logistics/i]
    ];

    rows.forEach(c => {
      const lastIsEmail = isEmailStr(c.LastName);
      // When LastName contains an email (common BH data-entry error), exclude it from display name
      const name = lastIsEmail
        ? (c.FirstName || '').trim()
        : `${c.FirstName || ''} ${c.LastName || ''}`.trim();
      if (!name || /default\s*contact/i.test(name)) return;

      // Resolve email: Email1 → Email2 → LastName (if it's an email) → ''
      const email = (c.Email1 || c.Email2 || (lastIsEmail ? c.LastName : '') || '').trim();

      const match = rules.find(([, rx]) => rx.test(c.Title || ''));
      cats[match ? match[0] : 'Other'].push({
        id:       c.ID,
        name,
        title:    c.Title || 'Contact',
        email,
        phone:    c.Phone || c.MobilePhone || '',
        initials: lastIsEmail
          ? `${(c.FirstName || '??').slice(0, 2)}`.toUpperCase()
          : `${(c.FirstName || '?')[0]}${(c.LastName || '?')[0]}`.toUpperCase(),
      });
    });

    res.json(cats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open job orders for a company (from Bullhorn via CData)
app.get('/api/company/:id/jobs', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });

  const toJob = j => ({
    id:         j.ID,
    title:      j.Title || '(Untitled)',
    status:     j.Status || '',
    type:       j.EmploymentType || 'Full-time',
    openings:   j.NumOpenings || 1,
    daysPosted: j.DateAdded ? Math.floor((Date.now() - new Date(j.DateAdded).getTime()) / 86400000) : null
  });

  const jf = FIELD.jobOrderCorpField || 'Companyid';
  let rows = null, fieldErr = null;
  for (const field of [jf, jf === 'Companyid' ? 'ClientCorporationid' : 'Companyid']) {
    try {
      rows = await cdataQuery(
        `SELECT TOP 20 ID, Title, DateAdded, Status, EmploymentType, NumOpenings
         FROM ${T('JobOrder')}
         WHERE ${field} = ${id}
         ORDER BY DateAdded DESC`
      );
      break;
    } catch (e) {
      fieldErr = e.message;
    }
  }
  if (rows === null) return res.json({ data: [], error: fieldErr });

  // Exclude statuses that are definitively closed
  const CLOSED = /archiv|cancel|fill|closed|deleted/i;
  res.json({ data: rows.filter(j => !CLOSED.test(j.Status || '')).map(toJob) });
});

// Batch job counts — called once after companies list loads
app.get('/api/job-counts', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(Number).filter(n => n > 0).slice(0, 300);
  if (!ids.length) return res.json({});
  const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const idList     = ids.join(',');

  const f = FIELD.jobOrderCorpField || 'Companyid';
  const toCounts = rows => {
    const m = {};
    rows.forEach(r => { if (r.ClientCorporationid) m[r.ClientCorporationid] = (m[r.ClientCorporationid] || 0) + 1; });
    return m;
  };

  try {
    let counts = {};
    try {
      const rows = await cdataQuery(
        `SELECT ${f} AS ClientCorporationid, COUNT(*) AS cnt
         FROM ${T('JobOrder')}
         WHERE ${f} IN (${idList}) AND DateAdded > '${oneYearAgo}'
         GROUP BY ${f}`
      );
      rows.forEach(r => { if (r.ClientCorporationid) counts[r.ClientCorporationid] = parseInt(r.cnt) || 0; });
    } catch (_) {
      const rows = await cdataQuery(
        `SELECT TOP 5000 ${f} AS ClientCorporationid FROM ${T('JobOrder')}
         WHERE ${f} IN (${idList}) AND DateAdded > '${oneYearAgo}'`
      ).catch(() => []);
      counts = toCounts(rows);
    }
    return res.json(counts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI email draft
app.post('/api/draft-email', async (req, res) => {
  const { companyName, contactName, contactRole, jobs = [], jobTitle } = req.body;
  const jobList = jobs.length ? jobs : (jobTitle ? [jobTitle] : []);
  const jobsContext = jobList.length
    ? `They are currently hiring for: ${jobList.join(', ')}.`
    : '';

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg       = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages:   [{
          role:    'user',
          content: `You are a BD rep at Core Group Resources, a maritime and energy staffing agency. Write a short re-engagement email body to ${contactName} (${contactRole} at ${companyName}). ${jobsContext} Rules: reference their specific open roles by name if provided, 2-3 sentences max, warm and human (not salesy), mention we have pre-vetted candidates ready. No subject line, no greeting, no sign-off — body text only.`
        }]
      });
      return res.json({ draft: msg.content[0].text.trim(), ai: true });
    } catch (e) {
      console.error('Claude API error:', e.message);
    }
  }

  // Fallback template with job list
  const roleStr = jobList.length
    ? `your open ${jobList.slice(0, 3).join(', ')}${jobList.length > 3 ? ` and ${jobList.length - 3} other` : ''} role${jobList.length !== 1 ? 's' : ''}`
    : 'your current openings';
  const templates = {
    Recruiting: `I noticed ${companyName} is hiring for ${roleStr} and wanted to reconnect — we have strong, pre-vetted candidates ready for immediate consideration.`,
    Sales:      `I saw ${companyName} is actively building out ${roleStr} and wanted to reach back out — our team has qualified candidates who would be a great fit.`,
    HR:         `With ${companyName} hiring for ${roleStr}, I'd love to reconnect and share how our pipeline can accelerate your search.`,
    Ops:        `Given your operational openings (${roleStr}) at ${companyName}, I wanted to reach out — we can help fill these roles quickly with pre-vetted talent.`
  };
  res.json({ draft: templates[contactRole] || templates.Sales, ai: false });
});

// JobSpy Python subprocess
const PYTHON_BIN = fs.existsSync(path.join(__dirname, '.venv', 'bin', 'python3'))
  ? path.join(__dirname, '.venv', 'bin', 'python3')
  : 'python3';

function runJobScraper(companyName, websiteUrl) {
  return new Promise(resolve => {
    const args = [path.join(__dirname, 'scrape_jobs.py'), companyName];
    if (websiteUrl) args.push(websiteUrl);
    const py  = spawn(PYTHON_BIN, args);
    let out = '', err = '';
    const timer = setTimeout(() => { py.kill(); resolve({ data: [], total: 0, error: 'Timed out' }); }, 45000);
    py.stdout.on('data', d => { out += d; });
    py.stderr.on('data', d => { err += d; });
    py.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); }
      catch { resolve({ data: [], total: 0, error: err.slice(0, 300) || 'No output' }); }
    });
  });
}

// External job postings — Indeed RSS + Monster + career page + JobSpy
app.get('/api/company/:id/external-jobs', async (req, res) => {
  const id       = parseInt(req.params.id);

  // Demo company — return hardcoded jobs instantly
  if (id === 99999) {
    return res.json({
      data: [
        { title: 'ROV Pilot',       url: 'https://example.com/jobs/rov-pilot',       source: 'Demo' },
        { title: 'NDT Technician',  url: 'https://example.com/jobs/ndt-technician',  source: 'Demo' },
        { title: 'Pipefitter',      url: 'https://example.com/jobs/pipefitter',       source: 'Demo' },
      ],
      companyName: 'Example Company (Demo)', error: null
    });
  }

  const cacheKey = `ext-${id}`;
  const cached   = externalJobCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return res.json(cached.data);

  let companyName = req.query.name    || '';
  let websiteUrl  = req.query.website || '';

  if (!companyName) {
    try {
      const rows  = await cdataQuery(`SELECT TOP 1 ID, CompanyName, CompanyWebsite FROM ${T('ClientCorporation')} WHERE ID = ${id}`);
      companyName = rows[0]?.CompanyName    || '';
      websiteUrl  = websiteUrl || rows[0]?.CompanyWebsite || '';
    } catch (e) {
      return res.json({ data: [], companyName: '', error: e.message });
    }
  }

  if (!companyName) return res.json({ data: [], companyName: '' });

  // Ensure website has a protocol
  if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) websiteUrl = `https://${websiteUrl}`;

  const result  = await runJobScraper(companyName, websiteUrl);
  const payload = { ...result, companyName };
  if (!result.error) externalJobCache.set(cacheKey, { ts: Date.now(), data: payload });
  res.json(payload);
});

// ─── BD Dashboard routes ──────────────────────────────────────────────────────
const { getDashboardData, getOtherBdsData, getAccountDetail } = require('./src/bd-queries');

app.get('/api/bd/dashboard', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    res.json(await getDashboardData({ force }));
  } catch (err) {
    console.error('BD dashboard:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bd/dashboard/other-bds', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    res.json(await getOtherBdsData({ force }));
  } catch (err) {
    console.error('BD other-bds:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bd/accounts/:id', async (req, res) => {
  try {
    const detail = await getAccountDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Account not found' });
    res.json(detail);
  } catch (err) {
    console.error('BD account detail:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ CGR Re-Engagement Tool → http://localhost:${PORT}\n`);
  // Warm BD dashboard cache in background
  getDashboardData().catch((e) => console.error('BD cache warm-up:', e.message));
});
