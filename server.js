require('dotenv').config();
const express        = require('express');
const axios          = require('axios');
const path           = require('path');
const { spawn }      = require('child_process');
const fs             = require('fs');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

// ─── User store — parsed + hashed once at startup ─────────────────────────────
const USERS_MAP = new Map();
try {
  const rawUsers = JSON.parse(process.env.USERS || '[]');
  for (const u of rawUsers) {
    USERS_MAP.set(u.email.toLowerCase(), {
      name:         u.name,
      hash:         bcrypt.hashSync(u.password, 10),
      overloop_key: u.overloop_key,
      admin:        !!u.admin,
    });
  }
  console.log(`✅ Auth: ${USERS_MAP.size} users loaded`);
} catch (e) {
  console.error('❌ USERS env var parse error:', e.message);
}

// ─── Token store — 30-day bearer tokens, no cookies needed ───────────────────
// Using Authorization headers avoids all SameSite/proxy/iframe cookie issues.
const AUTH_TOKENS = new Map(); // token → { user, expires }
setInterval(() => {
  const now = Date.now();
  for (const [t, d] of AUTH_TOKENS) if (d.expires < now) AUTH_TOKENS.delete(t);
}, 60 * 60 * 1000); // prune expired tokens hourly

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.removeHeader('X-Frame-Options');
  next();
});

// ─── Auth middleware — checks Bearer token on all /api/* except /api/login ────
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const record = AUTH_TOKENS.get(token);
  if (!record || record.expires < Date.now()) {
    AUTH_TOKENS.delete(token);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.currentUser = record.user;
  next();
});

// ─── Rate limiter — 5 attempts per 15 min per IP ──────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = USERS_MAP.get(email.toLowerCase().trim());
  if (!user) {
    await bcrypt.compare(password, '$2b$10$invalidhashtopreventtimingattackxxxxxxxxxxxxxxxxxxxxxxx');
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const match = await bcrypt.compare(password, user.hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  const token = crypto.randomBytes(32).toString('hex');
  AUTH_TOKENS.set(token, {
    user: { email: email.toLowerCase().trim(), name: user.name, admin: user.admin, overloop_key: user.overloop_key },
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, token, name: user.name, admin: user.admin });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token) AUTH_TOKENS.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const { email, name, admin } = req.currentUser;
  res.json({ email, name, admin });
});

// ─── Overloop outreach integration ────────────────────────────────────────────
const OVERLOOP_BASE = 'https://api.overloop.com/public/v1';

function overloopHeaders(key) {
  return {
    'Authorization': `apikey ${key}`,
    'Content-Type':  'application/vnd.api+json',
    'Accept':        'application/vnd.api+json',
  };
}

// List sequences from the BD's own Overloop account
app.get('/api/overloop/sequences', async (req, res) => {
  const key = req.currentUser?.overloop_key;
  if (!key) return res.status(400).json({ error: 'No Overloop API key configured for your account. Contact your admin.' });
  try {
    const r = await axios.get(`${OVERLOOP_BASE}/sequences`, { headers: overloopHeaders(key) });
    const sequences = (r.data.data || []).map(s => ({
      id:   s.id,
      name: s.attributes?.name || s.attributes?.title || `Sequence ${s.id}`,
    }));
    res.json({ sequences });
  } catch (e) {
    const status = e.response?.status;
    if (status === 401 || status === 403) return res.status(400).json({ error: 'Invalid Overloop API key. Contact your admin.' });
    res.status(400).json({ error: e.response?.data?.errors?.[0]?.detail || e.message });
  }
});

// Create prospect + enroll in a sequence (single or bulk contacts)
app.post('/api/overloop/enroll', async (req, res) => {
  const key = req.currentUser?.overloop_key;
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
  if (!req.currentUser?.admin) return res.status(403).json({ error: 'Admin only' });
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
app.get('/api/debug', async (req, res) => {
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
app.get('/api/debug-fields', async (req, res) => {
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
app.get('/api/debug-sql', async (req, res) => {
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
app.get('/api/status', async (req, res) => {
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

    res.json({ data: result, total: result.length, bdOwners });
  } catch (e) {
    console.error('stale-companies:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Contacts for a company
app.get('/api/company/:id/contacts', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  try {
    // ClientContact FK to ClientCorporation is 'Companyid' in CData's Bullhorn connector.
    // Email field is 'Email1', direct phone is 'DirectPhone'.
    let rows = await cdataQuery(
      `SELECT TOP 50 ID, FirstName, LastName, Title,
              Email1 AS EmailAddress, DirectPhone AS Phone, MobilePhone
       FROM ${T('ClientContact')}
       WHERE Companyid = ${id} AND Status = 'Active'`
    );
    // .catch() only fires on errors, not empty results — check length explicitly
    if (!rows.length) {
      rows = await cdataQuery(
        `SELECT TOP 50 ID, FirstName, LastName, Title,
                Email1 AS EmailAddress, DirectPhone AS Phone, MobilePhone
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
      const name = `${c.FirstName || ''} ${c.LastName || ''}`.trim();
      // Skip Bullhorn auto-generated placeholder contacts
      if (!name || /default\s*contact/i.test(name)) return;
      const match = rules.find(([, rx]) => rx.test(c.Title || ''));
      cats[match ? match[0] : 'Other'].push({
        id:       c.ID,
        name,
        title:    c.Title || 'Contact',
        email:    c.EmailAddress || '',
        phone:    c.Phone || c.MobilePhone || '',
        initials: `${(c.FirstName || '?')[0]}${(c.LastName || '?')[0]}`.toUpperCase()
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
  const { companyName, contactName, contactRole, jobTitle } = req.body;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg       = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages:   [{
          role:    'user',
          content: `You are a recruiter at a staffing agency. Write exactly ONE direct, warm re-engagement sentence to ${contactName} (${contactRole} at ${companyName}).${jobTitle ? ` They have an open "${jobTitle}" role.` : ''} Under 30 words. No greeting, no subject line, just the sentence. Do not start with "I".`
        }]
      });
      return res.json({ draft: msg.content[0].text.trim(), ai: true });
    } catch (e) {
      console.error('Claude API error:', e.message);
    }
  }

  const templates = {
    Recruiting: `Given your ${jobTitle ? `open ${jobTitle} role` : 'current openings'} at ${companyName}, I wanted to reconnect — we have strong, pre-vetted candidates ready for consideration.`,
    Sales:      `I noticed ${companyName} has active hiring needs and wanted to reconnect to explore how our staffing solutions can support your growth this quarter.`,
    HR:         `With ${companyName}'s current talent demands, I'd love to reconnect and share how our pipeline can accelerate your hiring process.`,
    Ops:        `Given your operational openings at ${companyName}, I wanted to reach out and discuss how our team can help fill these roles quickly and efficiently.`
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

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ CGR Re-Engagement Tool → http://localhost:${PORT}\n`);
});
