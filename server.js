require('dotenv').config();
const express        = require('express');
const axios          = require('axios');
const path           = require('path');
const { spawn }      = require('child_process');
const fs             = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.removeHeader('X-Frame-Options');
  next();
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
// Buckets by max(DH Final Score, CT Final Score):
//   1 = best  (>= 7.0)   2 = good (5.0–6.99)
//   3 = low   (3.0–4.99) 4 = minimal (< 3.0)
const CSV_SCORE = new Map([
  // ── Score 1 ──
  [719,1],[8568,1],[46904,1],[53797,1],[62243,1],[62442,1],[41263,1],[32243,1],[4466,1],[47137,1],
  [2,1],[8314,1],[30,1],[47123,1],[45102,1],[46851,1],[36878,1],[62449,1],[47754,1],[4325,1],
  [16900,1],[89,1],[30845,1],[47575,1],[43023,1],[46905,1],[998,1],[384,1],[43485,1],[46068,1],
  [47088,1],[46932,1],[475,1],[43027,1],[42956,1],[594,1],[47055,1],[43512,1],[46919,1],[46954,1],
  [40399,1],[518,1],[47603,1],[47750,1],[444,1],[46926,1],[34050,1],[32086,1],[43196,1],[23393,1],
  [30799,1],[34052,1],[59,1],[125,1],[1597,1],[46921,1],[47698,1],[25311,1],[550,1],[45868,1],
  [34054,1],[258,1],[31962,1],[35994,1],[44104,1],[47094,1],[45656,1],[46963,1],[4473,1],[47748,1],
  [870,1],[45464,1],[345,1],[4268,1],[53841,1],[47205,1],[47753,1],[47745,1],[30934,1],[12275,1],
  [43475,1],[47229,1],[294,1],[41291,1],[33706,1],[47725,1],[38969,1],[9219,1],[408,1],[45849,1],
  [47112,1],[35995,1],[47602,1],[34057,1],[99,1],[470,1],[116,1],[33774,1],[32110,1],[32051,1],
  [33823,1],[35974,1],[32119,1],[56177,1],[46850,1],[32115,1],[33990,1],[46962,1],[42328,1],
  [35121,1],[32111,1],[1453,1],[47719,1],
  // ── Score 2 ──
  [45064,2],[53849,2],[46133,2],[52,2],[34053,2],[6127,2],[47121,2],[47362,2],[46909,2],[47661,2],
  [47675,2],[34051,2],[46917,2],[30937,2],[5786,2],[45429,2],[47759,2],[42761,2],[751,2],[36101,2],
  [306,2],[47165,2],[768,2],[47469,2],[42836,2],[46881,2],[32087,2],[32116,2],[4711,2],[56227,2],
  [382,2],[42837,2],[32167,2],[47108,2],[56165,2],[30859,2],[9090,2],[62279,2],[56365,2],[34966,2],
  [407,2],[160,2],[23338,2],[34048,2],[123,2],[47136,2],[43006,2],[113,2],[33890,2],[138,2],
  [47120,2],[136,2],[12862,2],[8127,2],[27399,2],[47204,2],[34,2],[46938,2],[33827,2],[47758,2],
  [62481,2],[47045,2],[43837,2],[5707,2],[32124,2],[50783,2],[6052,2],[33892,2],[32113,2],[30820,2],
  [24331,2],[32114,2],[32109,2],[5601,2],[34055,2],[47090,2],[5595,2],[46848,2],[32138,2],[30712,2],
  [47068,2],[32281,2],[47142,2],[62568,2],[47161,2],[5897,2],[47113,2],[249,2],[32139,2],[47319,2],
  [14435,2],[46973,2],[840,2],[34884,2],[46197,2],[165,2],[46914,2],[296,2],[154,2],[33618,2],
  [33279,2],[176,2],[33952,2],[10027,2],[33996,2],[46374,2],[36932,2],[40114,2],[27132,2],[31963,2],
  [7018,2],[56153,2],[33817,2],[47146,2],[33643,2],[45070,2],[6116,2],[47148,2],[25,2],[13,2],
  [32105,2],[46950,2],[390,2],[330,2],[1647,2],[56022,2],[43043,2],[30868,2],[103,2],[47724,2],
  [47081,2],[31936,2],[42994,2],[47380,2],[30857,2],[32623,2],[47147,2],[32112,2],[226,2],
  // ── Score 3 ──
  [35172,3],[39403,3],[39412,3],[422,3],[35182,3],[5695,3],[47304,3],[46953,3],[47604,3],[46920,3],
  [32264,3],[46968,3],[47696,3],[12359,3],[47043,3],[46471,3],[540,3],[47751,3],[33810,3],[647,3],
  [6110,3],[47607,3],[46971,3],[115,3],[47572,3],[44320,3],[43454,3],[355,3],[40528,3],[43004,3],
  [33951,3],[33859,3],[47154,3],[242,3],[15,3],[863,3],[47299,3],[46916,3],[435,3],[47119,3],
  [46944,3],[47684,3],[47436,3],[47316,3],[62238,3],[14849,3],[33503,3],[32084,3],[30691,3],[30971,3],
  [175,3],[4573,3],[45239,3],[42804,3],[47704,3],[879,3],[47731,3],[56174,3],[46976,3],[46830,3],
  [297,3],[53844,3],[25703,3],[45715,3],[56215,3],[47693,3],[62428,3],[47107,3],[747,3],[47691,3],
  [47114,3],[32159,3],[43495,3],[9668,3],[46828,3],[43755,3],[46910,3],[1504,3],[35110,3],[42591,3],
  [47694,3],[47757,3],[47468,3],[32063,3],[47080,3],[47379,3],[46911,3],[46927,3],[47705,3],[47095,3],
  [47122,3],[30784,3],[46906,3],[45149,3],[11447,3],[43161,3],[33779,3],[32126,3],[47103,3],[47307,3],
  [139,3],[33741,3],[14250,3],[39977,3],[38990,3],[45212,3],[46935,3],[4472,3],[62350,3],[62488,3],
  [47085,3],[62354,3],[23430,3],[82,3],[6360,3],[46961,3],[47576,3],[47668,3],[47087,3],[47682,3],
  [47313,3],[47358,3],[5845,3],[185,3],[43754,3],[33283,3],[47049,3],[30739,3],[12396,3],[34037,3],
  [47086,3],[43848,3],[70,3],[46114,3],[45740,3],[31012,3],[46956,3],[46969,3],[44303,3],[24147,3],
  [5511,3],[47093,3],[34024,3],[33602,3],[35143,3],[46406,3],[47155,3],[47115,3],[47151,3],[5464,3],
  [748,3],[46960,3],[46965,3],[47145,3],[47157,3],[47315,3],[47366,3],[4575,3],[47058,3],[46952,3],
  [668,3],[43917,3],[46975,3],[45704,3],[46391,3],[28699,3],[47074,3],[12681,3],[1325,3],[43536,3],
  [33876,3],[33620,3],[247,3],[61240,3],[35239,3],[47311,3],[47437,3],[47164,3],[47067,3],[47707,3],
  [45111,3],[47746,3],[32133,3],[40577,3],[46093,3],[1274,3],
  // ── Score 4 ──
  [40571,4],[710,4],[35943,4],[47303,4],[62207,4],[33936,4],[36507,4],[1012,4],[47156,4],[234,4],
  [33945,4],[47709,4],[47729,4],[43995,4],[47092,4],[35279,4],[18205,4],[47230,4],[44026,4],[381,4],
  [43133,4],[19885,4],[47056,4],[43086,4],[32117,4],[47716,4],[47117,4],[26942,4],[5836,4],[47160,4],
  [47141,4],[50930,4],[46834,4],[47662,4],[36933,4]
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
        score:           CSV_SCORE.get(c.ID) ?? null,
        bdOwner:         bdName,
        bdOwnerInitials: initials,
        ownerAM:         c.OwnerAM || null,
        website
      };
    }).sort((a, b) => {
      const sa = a.score ?? 5, sb = b.score ?? 5;
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
    const timer = setTimeout(() => { py.kill(); resolve({ data: [], total: 0, error: 'Timed out' }); }, 30000);
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
