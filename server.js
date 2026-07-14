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

// ─── CSV Score Lookup ──────────────────────────────────────────────────────────
// Derived from Client_Ranking_Workbook_8(Summary).csv
// Tiers: DH Final Score primary, CT Final Score fallback.
//   T1 >= 8.0 | T2 >= 6.0 | T3 >= 4.0 | T4 < 4.0 | not in map → T4
const CSV_SCORE = new Map([
  // -- Tier 1 --
  [2,1],[30,1],[719,1],[4325,1],[4466,1],[8314,1],[8568,1],[16900,1],[32243,1],[36878,1],[41263,1],[45102,1],
  [46851,1],[46904,1],[47123,1],[47137,1],[47754,1],[53797,1],[62243,1],[62442,1],[62449,1],
  // -- Tier 2 --
  [34,2],[52,2],[59,2],[89,2],[113,2],[116,2],[125,2],[136,2],[138,2],[160,2],[249,2],[258,2],[294,2],[306,2],
  [345,2],[382,2],[384,2],[407,2],[408,2],[444,2],[475,2],[518,2],[550,2],[594,2],[751,2],[768,2],[870,2],
  [998,2],[1453,2],[1597,2],[4268,2],[4473,2],[4711,2],[5595,2],[5601,2],[5707,2],[5786,2],[5897,2],[6052,2],
  [6127,2],[8127,2],[9090,2],[9219,2],[12275,2],[12862,2],[23338,2],[23393,2],[24331,2],[25311,2],[30712,2],
  [30799,2],[30820,2],[30845,2],[30859,2],[30934,2],[30937,2],[31962,2],[32051,2],[32086,2],[32087,2],
  [32109,2],[32111,2],[32113,2],[32114,2],[32115,2],[32116,2],[32119,2],[32124,2],[32138,2],[32139,2],
  [32167,2],[32281,2],[33706,2],[33823,2],[33827,2],[33892,2],[33990,2],[34048,2],[34050,2],[34051,2],
  [34052,2],[34053,2],[34054,2],[34055,2],[34057,2],[34966,2],[35974,2],[35995,2],[36101,2],[38969,2],
  [40399,2],[41291,2],[42328,2],[42761,2],[42836,2],[42837,2],[42956,2],[43006,2],[43023,2],[43027,2],
  [43196,2],[43475,2],[43485,2],[43512,2],[43837,2],[44104,2],[45064,2],[45429,2],[45464,2],[45656,2],
  [45849,2],[45868,2],[46068,2],[46133,2],[46848,2],[46850,2],[46881,2],[46905,2],[46909,2],[46917,2],
  [46919,2],[46921,2],[46926,2],[46932,2],[46938,2],[46954,2],[46962,2],[46963,2],[47045,2],[47055,2],
  [47068,2],[47088,2],[47090,2],[47094,2],[47112,2],[47113,2],[47120,2],[47121,2],[47136,2],[47142,2],
  [47161,2],[47165,2],[47204,2],[47205,2],[47229,2],[47362,2],[47469,2],[47575,2],[47602,2],[47661,2],
  [47675,2],[47698,2],[47719,2],[47725,2],[47745,2],[47748,2],[47750,2],[47753,2],[53841,2],[53849,2],
  [56165,2],[56177,2],[56227,2],[56365,2],[62279,2],[62481,2],[62568,2],
  // -- Tier 3 --
  [154,3],[165,3],[176,3],[296,3],[330,3],[390,3],[422,3],[470,3],[840,3],[6116,3],[7018,3],[10027,3],
  [14435,3],[27132,3],[27399,3],[30857,3],[30868,3],[31936,3],[31963,3],[32105,3],[32112,3],[32623,3],
  [33618,3],[33643,3],[33774,3],[33817,3],[33952,3],[33996,3],[35172,3],[36932,3],[39403,3],[39412,3],
  [40114,3],[42994,3],[43043,3],[45070,3],[46197,3],[46374,3],[46914,3],[46973,3],[47108,3],[47148,3],
  [47319,3],[47380,3],[47724,3],[50783,3],[56022,3],[56153,3],
  // -- Tier 4 --
  [13,4],[15,4],[25,4],[70,4],[82,4],[99,4],[103,4],[115,4],[123,4],[139,4],[175,4],[185,4],[226,4],[234,4],
  [242,4],[247,4],[297,4],[355,4],[381,4],[435,4],[540,4],[647,4],[668,4],[710,4],[747,4],[748,4],[863,4],
  [879,4],[1012,4],[1274,4],[1325,4],[1504,4],[1647,4],[4472,4],[4573,4],[4575,4],[5464,4],[5511,4],[5695,4],
  [5836,4],[5845,4],[6110,4],[6360,4],[9668,4],[11447,4],[12359,4],[12396,4],[12681,4],[14250,4],[14849,4],
  [18205,4],[19885,4],[23430,4],[24147,4],[25703,4],[26942,4],[28699,4],[30691,4],[30739,4],[30784,4],
  [30971,4],[31012,4],[32063,4],[32084,4],[32110,4],[32117,4],[32126,4],[32133,4],[32159,4],[32264,4],
  [33279,4],[33283,4],[33503,4],[33602,4],[33620,4],[33741,4],[33779,4],[33810,4],[33859,4],[33876,4],
  [33890,4],[33936,4],[33945,4],[33951,4],[34024,4],[34037,4],[34884,4],[35110,4],[35121,4],[35143,4],
  [35182,4],[35239,4],[35279,4],[35943,4],[35994,4],[36507,4],[36933,4],[38990,4],[39977,4],[40528,4],
  [40571,4],[40577,4],[42591,4],[42804,4],[43004,4],[43086,4],[43133,4],[43161,4],[43454,4],[43495,4],
  [43536,4],[43754,4],[43755,4],[43848,4],[43917,4],[43995,4],[44026,4],[44303,4],[44320,4],[45111,4],
  [45149,4],[45212,4],[45239,4],[45704,4],[45715,4],[45740,4],[46093,4],[46114,4],[46391,4],[46406,4],
  [46471,4],[46828,4],[46830,4],[46834,4],[46906,4],[46910,4],[46911,4],[46916,4],[46920,4],[46927,4],
  [46935,4],[46944,4],[46950,4],[46952,4],[46953,4],[46956,4],[46960,4],[46961,4],[46965,4],[46968,4],
  [46969,4],[46971,4],[46975,4],[46976,4],[47043,4],[47049,4],[47056,4],[47058,4],[47067,4],[47074,4],
  [47080,4],[47081,4],[47085,4],[47086,4],[47087,4],[47092,4],[47093,4],[47095,4],[47103,4],[47107,4],
  [47114,4],[47115,4],[47117,4],[47119,4],[47122,4],[47141,4],[47145,4],[47146,4],[47147,4],[47151,4],
  [47154,4],[47155,4],[47156,4],[47157,4],[47160,4],[47164,4],[47230,4],[47299,4],[47303,4],[47304,4],
  [47307,4],[47311,4],[47313,4],[47315,4],[47316,4],[47358,4],[47366,4],[47379,4],[47436,4],[47437,4],
  [47468,4],[47572,4],[47576,4],[47603,4],[47604,4],[47607,4],[47662,4],[47668,4],[47682,4],[47684,4],
  [47691,4],[47693,4],[47694,4],[47696,4],[47704,4],[47705,4],[47707,4],[47709,4],[47716,4],[47729,4],
  [47731,4],[47746,4],[47751,4],[47757,4],[47758,4],[47759,4],[50930,4],[53844,4],[56174,4],[56215,4],
  [61240,4],[62207,4],[62238,4],[62350,4],[62354,4],[62428,4],[62488,4],
]);

// ─── Routes ───────────────────────────────────────────────────────────────────

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

// All Active Account companies, sorted by score then name
app.get('/api/stale-companies', async (req, res) => {
  try {
    const allCompanies = await cdataQuery(
      `SELECT TOP 1000 ID, CompanyName, BusinessSectors, CompanyWebsite,
              BusinessDevelopmentManager, OwnerAM
       FROM ${T('ClientCorporation')}
       WHERE Status = 'Active Account'
       ORDER BY CompanyName`
    );

    const bdOwners = [...new Set(
      allCompanies.map(c => c.BusinessDevelopmentManager).filter(Boolean)
    )].sort();

    const result = allCompanies.map(c => {
      const bdName   = c.BusinessDevelopmentManager || 'Unassigned';
      const initials = bdName !== 'Unassigned'
        ? bdName.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
        : '?';

      let website = c.CompanyWebsite ? c.CompanyWebsite.trim() : null;
      if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

      return {
        id:              c.ID,
        name:            c.CompanyName,
        industry:        c.BusinessSectors || 'N/A',
        score:           CSV_SCORE.get(c.ID) ?? 4,
        bdOwner:         bdName,
        bdOwnerInitials: initials,
        ownerAM:         c.OwnerAM || null,
        website
      };
    }).sort((a, b) => {
      const sa = a.score ?? 4, sb = b.score ?? 4;
      if (sa !== sb) return sa - sb;
      return (a.name || '').localeCompare(b.name || '');
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
