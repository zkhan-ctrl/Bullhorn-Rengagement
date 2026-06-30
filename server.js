require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow Bullhorn to embed this app in an iframe
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.removeHeader('X-Frame-Options');
  next();
});

// Simple in-memory cache for external job results (1-hour TTL)
const externalJobCache = new Map();

// ─── Bullhorn Session ─────────────────────────────────────────────────────────
let bh = { token: null, url: null, exp: 0 };

async function getBH() {
  if (bh.token && Date.now() < bh.exp) return bh;

  const { BULLHORN_CLIENT_ID: cid, BULLHORN_CLIENT_SECRET: cs,
          BULLHORN_USERNAME: user, BULLHORN_PASSWORD: pass } = process.env;

  if (!cid || !cs || !user || !pass) {
    throw new Error('Missing Bullhorn credentials in .env file');
  }

  // Step 1: Get auth code (Bullhorn responds with a 302 redirect containing ?code=)
  let code;
  try {
    await axios.get('https://auth.bullhornstaffing.com/oauth/authorize', {
      params: { client_id: cid, response_type: 'code', action: 'Login', username: user, password: pass },
      maxRedirects: 0
    });
    throw new Error('Expected 302 redirect from Bullhorn auth but got 200');
  } catch (e) {
    if (e.response?.status === 302) {
      const loc = e.response.headers.location || '';
      const m = loc.match(/[?&]code=([^&]+)/);
      if (!m) throw new Error('No auth code in Bullhorn redirect. Check your client_id and credentials.');
      code = decodeURIComponent(m[1]);
    } else {
      throw new Error('Bullhorn auth step 1 failed: ' + e.message);
    }
  }

  // Step 2: Exchange code for access token
  const tokenRes = await axios.post('https://auth.bullhornstaffing.com/oauth/token', null, {
    params: { grant_type: 'authorization_code', code, client_id: cid, client_secret: cs }
  });

  // Step 3: Open REST session
  const loginRes = await axios.get('https://rest.bullhornstaffing.com/rest-services/login', {
    params: { version: '*', access_token: tokenRes.data.access_token }
  });

  bh = {
    token: loginRes.data.BhRestToken,
    url:   loginRes.data.restUrl,
    exp:   Date.now() + 9 * 60 * 1000
  };
  console.log('✓ Bullhorn session opened:', bh.url);
  return bh;
}

async function bhQuery(entity, params, retry = true) {
  const { token, url } = await getBH();
  try {
    const r = await axios.get(`${url}query/${entity}`, {
      params: { ...params, BhRestToken: token }
    });
    return r.data;
  } catch (e) {
    if (e.response?.status === 401 && retry) {
      bh.token = null;
      return bhQuery(entity, params, false);
    }
    const msg = e.response?.data?.errorMessage || e.message;
    throw new Error(`Bullhorn query/${entity} failed: ${msg}`);
  }
}

async function bhMeta(entity) {
  const { token, url } = await getBH();
  const r = await axios.get(`${url}meta/${entity}`, {
    params: { fields: '*', BhRestToken: token }
  });
  return r.data;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health / credentials check
app.get('/api/status', async (req, res) => {
  const needed = ['BULLHORN_CLIENT_ID','BULLHORN_CLIENT_SECRET','BULLHORN_USERNAME','BULLHORN_PASSWORD'];
  const missing = needed.filter(k => !process.env[k]);
  if (missing.length) return res.json({ ok: false, missing });
  try {
    const { url } = await getBH();
    res.json({
      ok: true,
      instance: url,
      aiEnabled: !!process.env.ANTHROPIC_API_KEY,
      adzunaEnabled: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY)
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Discover ClientCorporation fields (helps user find the score field name)
app.get('/api/meta/company-fields', async (req, res) => {
  try {
    const meta = await bhMeta('ClientCorporation');
    const fields = (meta.fields || [])
      .filter(f => ['Integer','Double','BigDecimal','String'].includes(f.dataType) && !f.name.startsWith('_'))
      .map(f => ({ name: f.name, label: f.label || f.name, type: f.dataType }));
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
    const cutoff     = Date.now() - days * 86400000;

    // Run three queries in parallel to find recently active company IDs
    const [notesRes, jobsRes, placementsRes] = await Promise.all([
      bhQuery('Note', {
        where: `dateAdded>${cutoff} AND clientCorporation.id IS NOT NULL`,
        fields: 'clientCorporation(id)', count: 500
      }),
      bhQuery('JobOrder', {
        where: `dateAdded>${cutoff} AND isDeleted=false`,
        fields: 'clientCorporation(id)', count: 500
      }),
      bhQuery('Placement', {
        where: `dateBegin>${cutoff}`,
        fields: 'jobOrder(clientCorporation(id))', count: 500
      }).catch(() => ({ data: [] })) // placements may not be accessible — degrade gracefully
    ]);

    const activeIds = new Set([
      ...(notesRes.data   || []).filter(n => n.clientCorporation?.id).map(n => n.clientCorporation.id),
      ...(jobsRes.data    || []).filter(j => j.clientCorporation?.id).map(j => j.clientCorporation.id),
      ...(placementsRes.data || []).filter(p => p.jobOrder?.clientCorporation?.id).map(p => p.jobOrder.clientCorporation.id)
    ]);

    // Fetch all active companies (up to 200)
    const allRes = await bhQuery('ClientCorporation', {
      where: "isDeleted=false AND status='Active'",
      fields: `id,name,industryList,companyURL,${scoreField},dateLastModified,owner(id,firstName,lastName)`,
      count: 200,
      orderBy: 'name'
    });

    const staleCompanies = (allRes.data || []).filter(c => !activeIds.has(c.id));

    // Batch-fetch last note date per stale company (for accurate "days stale")
    let lastNoteMap = {};
    if (staleCompanies.length > 0) {
      const ids = staleCompanies.slice(0, 100).map(c => c.id).join(',');
      const noteRes = await bhQuery('Note', {
        where: `clientCorporation.id IN (${ids})`,
        fields: 'clientCorporation(id),dateAdded',
        orderBy: '-dateAdded',
        count: 500
      }).catch(() => ({ data: [] }));

      (noteRes.data || []).forEach(n => {
        const cid = n.clientCorporation?.id;
        if (cid && !lastNoteMap[cid]) lastNoteMap[cid] = n.dateAdded;
      });
    }

    const result = staleCompanies.map(c => {
      const lastActivity = lastNoteMap[c.id] || c.dateLastModified;
      const score = c[scoreField];
      return {
        id:           c.id,
        name:         c.name,
        industry:     (c.industryList || '').split(';').filter(Boolean).join(', ') || 'N/A',
        score:        score != null ? score : null,
        daysStale:    lastActivity ? Math.floor((Date.now() - lastActivity) / 86400000) : null,
        bdOwner:         c.owner ? `${c.owner.firstName || ''} ${c.owner.lastName || ''}`.trim() || 'Unassigned' : 'Unassigned',
        bdOwnerInitials: c.owner ? `${(c.owner.firstName||'?')[0]}${(c.owner.lastName||'?')[0]}`.toUpperCase() : '?',
        website:         c.companyURL || null
      };
    }).sort((a, b) => {
      const sa = a.score ?? 99, sb = b.score ?? 99;
      if (sa !== sb) return sa - sb;
      return (b.daysStale || 0) - (a.daysStale || 0);
    });

    res.json({ data: result, total: result.length, scannedActive: activeIds.size });
  } catch (e) {
    console.error('stale-companies error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Contacts for a company, sorted into 4 role buckets
app.get('/api/company/:id/contacts', async (req, res) => {
  try {
    const r = await bhQuery('ClientContact', {
      where: `clientCorporation.id=${req.params.id} AND isDeleted=false AND status='Active'`,
      fields: 'id,firstName,lastName,title,occupation,email,phone',
      count: 50
    });

    const cats = { Recruiting: [], Sales: [], HR: [], Ops: [], Other: [] };
    const rules = [
      ['Recruiting', /talent|recruit|acquisition|sourcing/i],
      ['Sales',      /sales|business dev|\bbd\b|account exec/i],
      ['HR',         /human res|\bhr\b|people ops|personnel/i],
      ['Ops',        /operat|\bcoo\b|chief operat|logistics/i]
    ];

    (r.data || []).forEach(c => {
      const text  = `${c.title || ''} ${c.occupation || ''}`;
      const match = rules.find(([, rx]) => rx.test(text));
      const bucket = match ? match[0] : 'Other';
      cats[bucket].push({
        id:    c.id,
        name:  `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown',
        title: c.title || c.occupation || 'Contact',
        email: c.email || '',
        phone: c.phone || '',
        initials: `${(c.firstName||'?')[0]}${(c.lastName||'?')[0]}`.toUpperCase()
      });
    });

    res.json(cats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open job orders for a company
app.get('/api/company/:id/jobs', async (req, res) => {
  try {
    const r = await bhQuery('JobOrder', {
      where: `clientCorporation.id=${req.params.id} AND isDeleted=false AND status='Accepting Candidates'`,
      fields: 'id,title,dateAdded,employmentType,numOpenings',
      count: 20,
      orderBy: '-dateAdded'
    });
    res.json({
      data: (r.data || []).map(j => ({
        id:         j.id,
        title:      j.title,
        type:       j.employmentType || 'Full-time',
        openings:   j.numOpenings || 1,
        daysPosted: j.dateAdded ? Math.floor((Date.now() - j.dateAdded) / 86400000) : null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI-generated email draft (Claude if key present, else template)
app.post('/api/draft-email', async (req, res) => {
  const { companyName, contactName, contactRole, jobTitle } = req.body;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `You are a recruiter at a staffing agency. Write exactly ONE direct, warm re-engagement sentence to ${contactName} (${contactRole} at ${companyName}).${jobTitle ? ` They have an open "${jobTitle}" role.` : ''} Under 30 words. No greeting, no subject, just the sentence body. Do not start with "I".`
        }]
      });
      return res.json({ draft: msg.content[0].text.trim(), ai: true });
    } catch (e) {
      console.error('Claude API error:', e.message);
    }
  }

  // Template fallback
  const templates = {
    Recruiting: `Given your ${jobTitle ? `open ${jobTitle} role` : 'current openings'} at ${companyName}, I wanted to reconnect — we have strong, pre-vetted candidates ready for consideration.`,
    Sales:      `I noticed ${companyName} has active hiring needs and wanted to reconnect to explore how our staffing solutions can support your growth this quarter.`,
    HR:         `With ${companyName}'s current talent demands, I'd love to reconnect and share how our pipeline can accelerate your hiring process.`,
    Ops:        `Given your operational openings at ${companyName}, I wanted to reach out and discuss how our team can help fill these roles quickly and efficiently.`
  };
  res.json({ draft: templates[contactRole] || templates.Sales, ai: false });
});

// External job postings for a company (via Adzuna — searches Indeed, LinkedIn, etc.)
app.get('/api/company/:id/external-jobs', async (req, res) => {
  const cacheKey = `ext-${req.params.id}`;
  const cached   = externalJobCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return res.json(cached.data);
  }

  // Get company name + website from Bullhorn
  let companyName = req.query.name || '';
  if (!companyName) {
    try {
      const { token, url } = await getBH();
      const r = await axios.get(`${url}entity/ClientCorporation/${req.params.id}`, {
        params: { fields: 'id,name,companyURL', BhRestToken: token }
      });
      companyName = r.data?.data?.name || '';
    } catch (e) {
      return res.status(500).json({ error: e.message, data: [] });
    }
  }

  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    return res.json({ data: [], companyName, message: 'Add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env to enable job board search.' });
  }

  try {
    const country = process.env.ADZUNA_COUNTRY || 'us';
    const r = await axios.get(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`, {
      params: {
        app_id:          process.env.ADZUNA_APP_ID,
        app_key:         process.env.ADZUNA_APP_KEY,
        company:         companyName,
        results_per_page: 10,
        sort_by:         'date'
      }
    });

    const jobs = (r.data.results || []).map(j => ({
      id:         j.id,
      title:      j.title,
      location:   j.location?.display_name || '',
      type:       j.contract_time === 'part_time' ? 'Part-time' : 'Full-time',
      daysPosted: j.created ? Math.floor((Date.now() - new Date(j.created).getTime()) / 86400000) : null,
      url:        j.redirect_url,
      source:     'Job Boards'
    }));

    const payload = { data: jobs, companyName, total: r.data.count || jobs.length };
    externalJobCache.set(cacheKey, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (e) {
    console.error('Adzuna error:', e.response?.data || e.message);
    res.json({ data: [], companyName, error: 'Job board search unavailable' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   CGR Re-Engagement Tool                   ║
║   http://localhost:${PORT}                    ║
╚════════════════════════════════════════════╝
  `);
});
