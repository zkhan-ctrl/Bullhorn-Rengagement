require('dotenv').config();
const express        = require('express');
const axios          = require('axios');
const path           = require('path');
const { spawn }      = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow Bullhorn to embed this tool in an iframe
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.removeHeader('X-Frame-Options');
  next();
});

const externalJobCache = new Map();

// ─── CData Connect AI — SQL Query API ────────────────────────────────────────
// Uses POST /api/query with plain SQL. No workspace required — works directly
// with the BullhornCRM1 connection and BullhornCRM schema.

const CDATA_API        = 'https://cloud.cdata.com/api/query';
const CDATA_CONNECTION = 'BullhornCRM1';
const CDATA_SCHEMA     = 'BullhornCRM';

function odataToSQL(table, p = {}) {
  const select = p['$select'] || '*';
  let sql = `SELECT ${select} FROM ${CDATA_SCHEMA}.${table}`;

  if (p['$filter']) {
    let w = p['$filter']
      .replace(/ eq null\b/g,  ' IS NULL')
      .replace(/ ne null\b/g,  ' IS NOT NULL')
      .replace(/ eq true\b/g,  " = TRUE")
      .replace(/ eq false\b/g, " = FALSE")
      .replace(/ eq /g,  ' = ')
      .replace(/ ne /g,  ' <> ')
      .replace(/ gt /g,  ' > ')
      .replace(/ lt /g,  ' < ')
      .replace(/ ge /g,  ' >= ')
      .replace(/ le /g,  ' <= ')
      .replace(/ and /gi, ' AND ')
      .replace(/ or /gi,  ' OR ');
    // Wrap bare ISO date strings in quotes
    w = w.replace(/([><=!]+\s*)(\d{4}-\d{2}-\d{2}T[\d:.Z]+)/g, "$1'$2'");
    sql += ` WHERE ${w}`;
  }

  if (p['$orderby']) {
    sql += ` ORDER BY ${p['$orderby'].replace(/ desc$/i, ' DESC').replace(/ asc$/i, ' ASC')}`;
  }

  if (p['$top']) sql += ` LIMIT ${p['$top']}`;

  return sql;
}

async function cdataGet(table, params = {}) {
  const auth = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  const sql  = odataToSQL(table, params);
  try {
    const r = await axios.post(
      CDATA_API,
      { query: sql, connection: CDATA_CONNECTION },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    return r.data.results || r.data.value || [];
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
    throw new Error(`CData [${table}]: ${msg}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Temporary debug endpoint — shows raw CData response to diagnose field names
app.get('/api/debug', async (req, res) => {
  const auth  = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  const query = req.query.q || 'SELECT TOP 3 * FROM BullhornCRM.ClientCorporation';
  try {
    const r = await axios.post(
      'https://cloud.cdata.com/api/query',
      { query, connection: 'BullhornCRM1' },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    res.json({ sql: query, httpStatus: r.status, rawResponse: r.data });
  } catch (e) {
    res.json({ sql: query, error: e.message, httpStatus: e.response?.status, rawResponse: e.response?.data });
  }
});

// Health check — verifies CData credentials and connection
app.get('/api/status', async (req, res) => {
  const needed  = ['CDATA_USER', 'CDATA_PAT'];
  const missing = needed.filter(k => !process.env[k]);
  if (missing.length) return res.json({ ok: false, missing });
  try {
    await cdataGet('ClientCorporation', { '$top': 1, '$select': 'id' });
    res.json({
      ok:            true,
      aiEnabled:     !!process.env.ANTHROPIC_API_KEY,
      adzunaEnabled: true  // JobSpy: no API key required
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Field discovery — reads a sample row to show available fields in Settings panel
app.get('/api/meta/company-fields', async (req, res) => {
  try {
    const sample = await cdataGet('ClientCorporation', { '$top': 1 });
    if (!sample.length) return res.json([]);
    const fields = Object.keys(sample[0])
      .filter(k => !k.startsWith('@'))
      .map(k => ({
        name:  k,
        label: k,
        type:  typeof sample[0][k] === 'number' ? 'Integer' : 'String'
      }));
    res.json(fields);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Main: stale companies
app.get('/api/stale-companies', async (req, res) => {
  try {
    const days       = parseInt(req.query.days) || 90;
    const scoreField = req.query.scoreField || 'customInt2';
    const cutoff     = new Date(Date.now() - days * 86400000).toISOString();

    // Find recently active company IDs across notes, jobs, and placements
    const [recentNotes, recentJobs, recentPlacements] = await Promise.all([
      cdataGet('Note', {
        '$filter': `dateAdded gt ${cutoff} and ClientCorporationID ne null`,
        '$select': 'ClientCorporationID',
        '$top':    500
      }),
      cdataGet('JobOrder', {
        '$filter': `dateAdded gt ${cutoff} and isDeleted eq false`,
        '$select': 'ClientCorporationID',
        '$top':    500
      }),
      cdataGet('Placement', {
        '$filter': `dateBegin gt ${cutoff}`,
        '$select': 'ClientCorporationID',
        '$top':    500
      }).catch(() => [])
    ]);

    const activeIds = new Set([
      ...recentNotes.filter(n => n.ClientCorporationID).map(n => n.ClientCorporationID),
      ...recentJobs.filter(j => j.ClientCorporationID).map(j => j.ClientCorporationID),
      ...recentPlacements.filter(p => p.ClientCorporationID).map(p => p.ClientCorporationID)
    ]);

    // Get all active companies
    const allCompanies = await cdataGet('ClientCorporation', {
      '$filter':  "isDeleted eq false and status eq 'Active'",
      '$select':  `id,name,industryList,companyURL,${scoreField},dateLastModified,OwnerFirstName,OwnerLastName`,
      '$top':     500,
      '$orderby': 'name'
    });

    const staleCompanies = allCompanies.filter(c => !activeIds.has(c.id));

    // Batch-fetch last note date per stale company for accurate "days stale"
    let lastNoteMap = {};
    if (staleCompanies.length > 0) {
      const ids      = staleCompanies.slice(0, 100).map(c => c.id).join(',');
      const lastNotes = await cdataGet('Note', {
        '$filter':  `ClientCorporationID in (${ids})`,
        '$select':  'ClientCorporationID,dateAdded',
        '$orderby': 'dateAdded desc',
        '$top':     500
      }).catch(() => []);

      lastNotes.forEach(n => {
        if (n.ClientCorporationID && !lastNoteMap[n.ClientCorporationID]) {
          lastNoteMap[n.ClientCorporationID] = n.dateAdded;
        }
      });
    }

    const result = staleCompanies.map(c => {
      const lastActivity = lastNoteMap[c.id] || c.dateLastModified;
      return {
        id:              c.id,
        name:            c.name,
        industry:        (c.industryList || '').split(';').filter(Boolean).join(', ') || 'N/A',
        score:           c[scoreField] ?? null,
        daysStale:       lastActivity ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86400000) : null,
        bdOwner:         `${c.OwnerFirstName || ''} ${c.OwnerLastName || ''}`.trim() || 'Unassigned',
        bdOwnerInitials: c.OwnerFirstName ? `${c.OwnerFirstName[0]}${(c.OwnerLastName || '?')[0]}`.toUpperCase() : '?',
        website:         c.companyURL || null
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

// Contacts for a company, categorized by role
app.get('/api/company/:id/contacts', async (req, res) => {
  try {
    const rows = await cdataGet('ClientContact', {
      '$filter': `ClientCorporationID eq ${req.params.id} and isDeleted eq false and status eq 'Active'`,
      '$select': 'id,firstName,lastName,title,occupation,email,phone',
      '$top':    50
    });

    const cats  = { Recruiting: [], Sales: [], HR: [], Ops: [], Other: [] };
    const rules = [
      ['Recruiting', /talent|recruit|acquisition|sourcing/i],
      ['Sales',      /sales|business dev|\bbd\b|account exec/i],
      ['HR',         /human res|\bhr\b|people ops|personnel/i],
      ['Ops',        /operat|\bcoo\b|chief operat|logistics/i]
    ];

    rows.forEach(c => {
      const text   = `${c.title || ''} ${c.occupation || ''}`;
      const match  = rules.find(([, rx]) => rx.test(text));
      cats[match ? match[0] : 'Other'].push({
        id:       c.id,
        name:     `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown',
        title:    c.title || c.occupation || 'Contact',
        email:    c.email || '',
        phone:    c.phone || '',
        initials: `${(c.firstName || '?')[0]}${(c.lastName || '?')[0]}`.toUpperCase()
      });
    });

    res.json(cats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open job orders for a company (from Bullhorn via CData)
app.get('/api/company/:id/jobs', async (req, res) => {
  try {
    const rows = await cdataGet('JobOrder', {
      '$filter':  `ClientCorporationID eq ${req.params.id} and isDeleted eq false and status eq 'Accepting Candidates'`,
      '$select':  'id,title,dateAdded,employmentType,numOpenings',
      '$top':     20,
      '$orderby': 'dateAdded desc'
    });
    res.json({
      data: rows.map(j => ({
        id:         j.id,
        title:      j.title,
        type:       j.employmentType || 'Full-time',
        openings:   j.numOpenings || 1,
        daysPosted: j.dateAdded ? Math.floor((Date.now() - new Date(j.dateAdded).getTime()) / 86400000) : null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI email draft (Claude if key present, templates as fallback)
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

// Prefer the venv Python (Railway/Nix), fall back to system python3 (local dev)
const fs         = require('fs');
const PYTHON_BIN = fs.existsSync(path.join(__dirname, '.venv', 'bin', 'python3'))
  ? path.join(__dirname, '.venv', 'bin', 'python3')
  : 'python3';

// Run JobSpy Python script as subprocess, returns parsed JSON
function runJobSpy(companyName) {
  return new Promise(resolve => {
    const script = path.join(__dirname, 'scrape_jobs.py');
    const py     = spawn(PYTHON_BIN, [script, companyName]);
    let out = '', err = '';

    const timer = setTimeout(() => {
      py.kill();
      resolve({ data: [], total: 0, error: 'Job search timed out after 55s' });
    }, 55000);

    py.stdout.on('data', d => { out += d; });
    py.stderr.on('data', d => { err += d; });
    py.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ data: [], total: 0, error: err.slice(0, 200) || 'No output from job scraper' });
      }
    });
  });
}

// External job postings via JobSpy (LinkedIn, Indeed, Glassdoor, ZipRecruiter)
app.get('/api/company/:id/external-jobs', async (req, res) => {
  const cacheKey = `ext-${req.params.id}`;
  const cached   = externalJobCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return res.json(cached.data);

  let companyName = req.query.name || '';
  if (!companyName) {
    try {
      const rows  = await cdataGet('ClientCorporation', { '$filter': `id eq ${req.params.id}`, '$select': 'id,name', '$top': 1 });
      companyName = rows[0]?.name || '';
    } catch (e) {
      return res.json({ data: [], companyName: '', error: e.message });
    }
  }

  if (!companyName) return res.json({ data: [], companyName: '' });

  const result  = await runJobSpy(companyName);
  const payload = { ...result, companyName };

  if (!result.error && result.data.length >= 0) {
    externalJobCache.set(cacheKey, { ts: Date.now(), data: payload });
  }

  res.json(payload);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ CGR Re-Engagement Tool → http://localhost:${PORT}\n`));
