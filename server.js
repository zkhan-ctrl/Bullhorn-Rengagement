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
// Response format: results[0].schema (column defs) + results[0].rows (arrays of values)
// Must convert to array of objects using the schema column names.

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

// ─── Routes ───────────────────────────────────────────────────────────────────

// Debug — test any table: /api/debug?table=Note
app.get('/api/debug', async (req, res) => {
  const auth  = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  const table = (req.query.table || 'ClientCorporation').replace(/[^a-zA-Z]/g, '');
  const sql   = `SELECT TOP 2 * FROM BullhornCRM1.BullhornCRM.${table}`;
  try {
    const r  = await axios.post(CDATA_API, { query: sql, connection: CDATA_CONNECTION },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
    const rs = r.data.results?.[0];
    res.json({ sql, columns: rs?.schema?.map(c => c.columnName) || [], rows: rs?.rows?.length || 0, firstRow: rs?.rows?.[0] });
  } catch (e) {
    res.json({ sql, error: e.message, raw: e.response?.data });
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
    res.json(Object.keys(rows[0]).map(k => ({ name: k, label: k, type: typeof rows[0][k] === 'number' ? 'Integer' : 'String' })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Main: stale companies
app.get('/api/stale-companies', async (req, res) => {
  try {
    const days   = parseInt(req.query.days) || 90;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    // Find recently active company IDs across notes, jobs, placements
    const [recentNotes, recentJobs, recentPlacements] = await Promise.all([
      cdataQuery(`SELECT ClientCorporationid FROM ${T('Note')} WHERE DateAdded > '${cutoff}' AND ClientCorporationid IS NOT NULL LIMIT 500`).catch(() => []),
      cdataQuery(`SELECT ClientCorporationid FROM ${T('JobOrder')} WHERE DateAdded > '${cutoff}' AND ClientCorporationid IS NOT NULL LIMIT 500`).catch(() => []),
      cdataQuery(`SELECT ClientCorporationid FROM ${T('Placement')} WHERE DateBegin > '${cutoff}' AND ClientCorporationid IS NOT NULL LIMIT 500`).catch(() => [])
    ]);

    const activeIds = new Set([
      ...recentNotes.map(n => n.ClientCorporationid).filter(Boolean),
      ...recentJobs.map(j => j.ClientCorporationid).filter(Boolean),
      ...recentPlacements.map(p => p.ClientCorporationid).filter(Boolean)
    ]);

    // Get all companies (no isDeleted filter — field doesn't exist in CData view)
    const allCompanies = await cdataQuery(
      `SELECT TOP 500 ID, CompanyName, BusinessSectors, CompanyWebsite, ClientScore, DateLastModified, BusinessDevelopmentManager
       FROM ${T('ClientCorporation')}
       ORDER BY CompanyName`
    );

    const staleCompanies = allCompanies.filter(c => !activeIds.has(c.ID));

    // Last note date per stale company for accurate "days stale"
    let lastNoteMap = {};
    if (staleCompanies.length > 0) {
      const ids = staleCompanies.slice(0, 100).map(c => c.ID).join(',');
      const lastNotes = await cdataQuery(
        `SELECT ClientCorporationid, DateAdded FROM ${T('Note')} WHERE ClientCorporationid IN (${ids}) ORDER BY DateAdded DESC LIMIT 500`
      ).catch(() => []);
      lastNotes.forEach(n => {
        if (n.ClientCorporationid && !lastNoteMap[n.ClientCorporationid]) {
          lastNoteMap[n.ClientCorporationid] = n.DateAdded;
        }
      });
    }

    const result = staleCompanies.map(c => {
      const lastActivity = lastNoteMap[c.ID] || c.DateLastModified;
      const bdOwner      = c.BusinessDevelopmentManager || 'Unassigned';
      const initials     = bdOwner !== 'Unassigned'
        ? bdOwner.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
        : '?';
      return {
        id:              c.ID,
        name:            c.CompanyName,
        industry:        c.BusinessSectors || 'N/A',
        score:           c.ClientScore ?? null,
        daysStale:       lastActivity ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86400000) : null,
        bdOwner,
        bdOwnerInitials: initials,
        website:         c.CompanyWebsite || null
      };
    }).sort((a, b) => {
      const sa = a.score ?? 99, sb = b.score ?? 99;
      if (sa !== sb) return sa - sb;
      return (b.daysStale || 0) - (a.daysStale || 0);
    });

    res.json({ data: result, total: result.length, scannedActive: activeIds.size });
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
    const rows = await cdataQuery(
      `SELECT TOP 50 ID, FirstName, LastName, Title, EmailAddress, Phone
       FROM ${T('ClientContact')}
       WHERE ClientCorporationid = ${id}`
    );

    const cats  = { Recruiting: [], Sales: [], HR: [], Ops: [], Other: [] };
    const rules = [
      ['Recruiting', /talent|recruit|acquisition|sourcing/i],
      ['Sales',      /sales|business dev|\bbd\b|account exec/i],
      ['HR',         /human res|\bhr\b|people ops|personnel/i],
      ['Ops',        /operat|\bcoo\b|chief operat|logistics/i]
    ];

    rows.forEach(c => {
      const match = rules.find(([, rx]) => rx.test(c.Title || ''));
      cats[match ? match[0] : 'Other'].push({
        id:       c.ID,
        name:     `${c.FirstName || ''} ${c.LastName || ''}`.trim() || 'Unknown',
        title:    c.Title || 'Contact',
        email:    c.EmailAddress || '',
        phone:    c.Phone || '',
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
  try {
    const rows = await cdataQuery(
      `SELECT TOP 20 ID, Title, DateAdded, EmploymentType, NumOpenings
       FROM ${T('JobOrder')}
       WHERE ClientCorporationid = ${id} AND Status = 'Accepting Candidates'
       ORDER BY DateAdded DESC`
    );
    res.json({
      data: rows.map(j => ({
        id:         j.ID,
        title:      j.Title,
        type:       j.EmploymentType || 'Full-time',
        openings:   j.NumOpenings || 1,
        daysPosted: j.DateAdded ? Math.floor((Date.now() - new Date(j.DateAdded).getTime()) / 86400000) : null
      }))
    });
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

function runJobSpy(companyName) {
  return new Promise(resolve => {
    const py    = spawn(PYTHON_BIN, [path.join(__dirname, 'scrape_jobs.py'), companyName]);
    let out = '', err = '';
    const timer = setTimeout(() => { py.kill(); resolve({ data: [], total: 0, error: 'Timed out' }); }, 55000);
    py.stdout.on('data', d => { out += d; });
    py.stderr.on('data', d => { err += d; });
    py.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); }
      catch { resolve({ data: [], total: 0, error: err.slice(0, 200) || 'No output' }); }
    });
  });
}

// External job postings via JobSpy (LinkedIn, Indeed, Glassdoor, ZipRecruiter)
app.get('/api/company/:id/external-jobs', async (req, res) => {
  const id       = parseInt(req.params.id);
  const cacheKey = `ext-${id}`;
  const cached   = externalJobCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return res.json(cached.data);

  let companyName = req.query.name || '';
  if (!companyName) {
    try {
      const rows  = await cdataQuery(`SELECT TOP 1 ID, CompanyName FROM ${T('ClientCorporation')} WHERE ID = ${id}`);
      companyName = rows[0]?.CompanyName || '';
    } catch (e) {
      return res.json({ data: [], companyName: '', error: e.message });
    }
  }

  if (!companyName) return res.json({ data: [], companyName: '' });

  const result  = await runJobSpy(companyName);
  const payload = { ...result, companyName };
  if (!result.error) externalJobCache.set(cacheKey, { ts: Date.now(), data: payload });
  res.json(payload);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ CGR Re-Engagement Tool → http://localhost:${PORT}\n`));
