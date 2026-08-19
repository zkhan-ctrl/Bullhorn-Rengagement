const { runQuery, matchAny, esc, TABLE } = require('./bd-cdata');

const ALLOWED_BDMS = [
  'Neal Duncan',
  "Dan O'Connor",
  'Matt May',
  'Matt Fuhrman',
  'Charles Ishee',
  'Ashlea Landrum',
];

const SENT_STAGES = ['Contract Sent', 'Contract Signed-Intake Call Needed', 'Converted', 'Closed-Won'];
const OPEN_SENT_STAGE = 'Contract Sent';

const ID_CHUNK_SIZE = 400;
const CACHE_TTL_MS = 15 * 60 * 1000;
const SYSTEM_USER_TTL_MS = 60 * 60 * 1000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runForIds(ids, buildSql) {
  if (!ids.length) return [];
  const results = await Promise.all(
    chunk(ids, ID_CHUNK_SIZE).map((batch) => runQuery(buildSql(batch.join(','))))
  );
  return results.flat();
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const diffMs = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function bucketFor(days) {
  if (days === null) return 'no-activity';
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '91+';
}

function latestOf(pairs) {
  let best = null;
  for (const [date, label] of pairs) {
    if (!date) continue;
    const t = new Date(date).getTime();
    if (!best || t > best.t) best = { t, date, label };
  }
  return best ? { date: new Date(best.t).toISOString(), source: best.label } : { date: null, source: null };
}

let systemUserCache = { ids: null, expiresAt: 0 };

async function getSystemUserIds() {
  if (systemUserCache.ids && Date.now() < systemUserCache.expiresAt) {
    return systemUserCache.ids;
  }
  const patterns = ['%Admin%', '%API%', '%System%', '%Integration%', '%Bot%', '%Sync%'];
  const rows = await runQuery(
    `SELECT ID FROM ${TABLE}.CorporateUser WHERE ${patterns.map((p) => `Name LIKE '${p}'`).join(' OR ')}`
  );
  const ids = new Set(rows.map((r) => String(r.ID)));
  systemUserCache = { ids, expiresAt: Date.now() + SYSTEM_USER_TTL_MS };
  return ids;
}

async function buildDataset(bdmFilter, isOther) {
  const companies = await runQuery(
    `SELECT ID, CompanyName, Status, BusinessDevelopmentManager, BDSource, LeadSource
     FROM ${TABLE}.ClientCorporation
     WHERE ${bdmFilter}`
  );
  const ids = companies.map((c) => c.ID);

  const systemUserIds = await getSystemUserIds();

  const [
    oppActivity, placementAgg, proposalRows, contactAgg,
    jobOrderActivity, statusHistory,
  ] = await Promise.all([
    runForIds(ids, (batch) => `
      SELECT Companyid AS Companyid, MAX(DateLastModified) AS LastOppActivity
      FROM ${TABLE}.Opportunity
      WHERE Companyid IN (${batch})
      GROUP BY Companyid
    `),
    runForIds(ids, (batch) => `
      SELECT Companyid AS Companyid, COUNT(*) AS PlacementCount, MAX(DateAdded) AS LastPlacementDate
      FROM ${TABLE}.Placement
      WHERE Companyid IN (${batch})
      GROUP BY Companyid
    `),
    runQuery(`
      SELECT o.ID AS ID, o.Title AS Title, o.DealStage AS DealStage, o.DealValue AS DealValue,
             o.ExpectedCloseDate AS ExpectedCloseDate, o.DateLastModified AS DateLastModified,
             o.Companyid AS Companyid, cc.CompanyName AS CompanyName, cc.BusinessDevelopmentManager AS Bdm
      FROM ${TABLE}.Opportunity o
      JOIN ${TABLE}.ClientCorporation cc ON cc.ID = o.Companyid
      WHERE ${bdmFilter.replace(/BusinessDevelopmentManager/g, 'cc.BusinessDevelopmentManager')}
        AND o.DealStage IN (${SENT_STAGES.map((s) => `'${esc(s)}'`).join(',')})
    `),
    runForIds(ids, (batch) => `
      SELECT Companyid AS Companyid, MAX(LastNote) AS LastNote
      FROM ${TABLE}.ClientContact
      WHERE Companyid IN (${batch})
      GROUP BY Companyid
    `),
    runForIds(ids, (batch) => `
      SELECT ClientCompanyid AS Companyid, MAX(LastUpdated) AS LastJobActivity
      FROM ${TABLE}.JobOrder
      WHERE ClientCompanyid IN (${batch})
      GROUP BY ClientCompanyid
    `),
    runForIds(ids, (batch) => `
      SELECT ClientCorporationid AS Companyid, MAX(DateAdded) AS LastStatusChange
      FROM ${TABLE}.ClientCorporationHistory
      WHERE ClientCorporationid IN (${batch})
      GROUP BY ClientCorporationid
    `),
  ]);

  const oppByCompany = new Map(oppActivity.map((r) => [String(r.Companyid), r.LastOppActivity]));
  const placementCountByCompany = new Map(placementAgg.map((r) => [String(r.Companyid), Number(r.PlacementCount) || 0]));
  const placementDateByCompany = new Map(placementAgg.map((r) => [String(r.Companyid), r.LastPlacementDate]));
  const noteByCompany = new Map(contactAgg.map((r) => [String(r.Companyid), r.LastNote]));
  const jobOrderByCompany = new Map(jobOrderActivity.map((r) => [String(r.Companyid), r.LastJobActivity]));
  const statusByCompany = new Map();
  statusHistory.forEach((r) => {
    if (systemUserIds.has(String(r.ModifyingUserid))) return;
    const existing = statusByCompany.get(String(r.Companyid));
    if (!existing || new Date(r.LastStatusChange) > new Date(existing)) statusByCompany.set(String(r.Companyid), r.LastStatusChange);
  });

  const activityByCompany = new Map();
  const accounts = companies.map((c) => {
    const id = String(c.ID);
    const { date: lastActivity, source } = latestOf([
      [oppByCompany.get(id), 'Opportunity movement'],
      [noteByCompany.get(id), 'Note/Email'],
      [jobOrderByCompany.get(id), 'Job activity'],
      [placementDateByCompany.get(id), 'Placement'],
      [statusByCompany.get(id), 'Status change'],
    ]);
    const days = daysSince(lastActivity);
    const bucket = bucketFor(days);
    activityByCompany.set(id, { lastActivity, days, bucket });
    return {
      id: c.ID,
      companyName: c.CompanyName,
      bdm: c.BusinessDevelopmentManager,
      isOther,
      status: c.Status,
      leadSource: c.LeadSource || c.BDSource || null,
      lastActivity,
      activitySource: source,
      daysSinceActivity: days,
      bucket,
      placementsTotal: placementCountByCompany.get(id) || 0,
    };
  });
  accounts.sort((a, b) => (a.companyName || '').localeCompare(b.companyName || ''));

  const proposals = proposalRows
    .map((r) => {
      const activity = activityByCompany.get(String(r.Companyid)) || {};
      return {
        id: r.ID,
        title: r.Title,
        companyId: r.Companyid,
        companyName: r.CompanyName,
        bdm: r.Bdm,
        isOther,
        dealStage: r.DealStage,
        dealValue: r.DealValue,
        contractSentDate: r.DateLastModified,
        expectedCloseDate: r.ExpectedCloseDate,
        needsFollowUp: (r.DealStage || '').toLowerCase() === OPEN_SENT_STAGE.toLowerCase(),
        lastActivity: activity.lastActivity || null,
        daysSinceActivity: activity.days ?? null,
        bucket: activity.bucket || 'no-activity',
      };
    })
    .sort((a, b) => new Date(b.contractSentDate) - new Date(a.contractSentDate));

  return { accounts, proposals };
}

let cache = { data: null, expiresAt: 0 };

async function getDashboardData({ force = false } = {}) {
  if (!force && cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }
  const bdmFilter = matchAny('BusinessDevelopmentManager', ALLOWED_BDMS);
  const { accounts, proposals } = await buildDataset(bdmFilter, false);
  const data = { bdms: ALLOWED_BDMS, accounts, proposals, generatedAt: new Date().toISOString() };
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

let otherCache = { data: null, expiresAt: 0 };

async function getOtherBdsData({ force = false } = {}) {
  if (!force && otherCache.data && Date.now() < otherCache.expiresAt) {
    return otherCache.data;
  }
  const bdmFilter = `NOT (${matchAny('BusinessDevelopmentManager', ALLOWED_BDMS)})`;
  const { accounts, proposals } = await buildDataset(bdmFilter, true);
  const otherBdms = [...new Set(accounts.map((a) => a.bdm))]
    .filter((name) => name && /[a-zA-Z]{2,}\s+[a-zA-Z]{2,}/.test(name))
    .sort();
  const data = { bdms: otherBdms, accounts, proposals, generatedAt: new Date().toISOString() };
  otherCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

async function getAccountDetail(companyId) {
  const systemUserIds = await getSystemUserIds();

  const [companyRows, contacts, opportunities, placementRows, jobOrderRows, statusRows] = await Promise.all([
    runQuery(`
      SELECT ID, CompanyName, Status, LeadSource, BDSource, CompanyWebsite, MainPhone
      FROM ${TABLE}.ClientCorporation
      WHERE ID = ${Number(companyId)}
    `),
    runQuery(`
      SELECT ID, FirstName, LastName, Name, Email1, DirectPhone, Title, LastNote
      FROM ${TABLE}.ClientContact
      WHERE Companyid = ${Number(companyId)}
    `),
    runQuery(`
      SELECT ID, Title, DealStage, DealValue, DateLastModified
      FROM ${TABLE}.Opportunity
      WHERE Companyid = ${Number(companyId)}
    `),
    runQuery(`
      SELECT COUNT(*) AS PlacementCount, MAX(DateAdded) AS LastPlacementDate
      FROM ${TABLE}.Placement
      WHERE Companyid = ${Number(companyId)}
    `),
    runQuery(`
      SELECT MAX(LastUpdated) AS LastJobActivity
      FROM ${TABLE}.JobOrder
      WHERE ClientCompanyid = ${Number(companyId)}
    `),
    runQuery(`
      SELECT DateAdded, ModifyingUserid
      FROM ${TABLE}.ClientCorporationHistory
      WHERE ClientCorporationid = ${Number(companyId)}
    `),
  ]);

  const company = companyRows[0];
  if (!company) return null;

  const contactIds = contacts.map((c) => c.ID);
  const taskRows = contactIds.length
    ? await runQuery(`
        SELECT MAX(DateLastModified) AS LastTaskDate
        FROM ${TABLE}.Task
        WHERE Contactid IN (${contactIds.join(',')})
      `)
    : [];

  const lastStatusChange = statusRows
    .filter((r) => !systemUserIds.has(String(r.ModifyingUserid)))
    .reduce((max, r) => (!max || new Date(r.DateAdded) > new Date(max) ? r.DateAdded : max), null);

  const { date: lastActivity, source } = latestOf([
    [opportunities.length ? latestOf(opportunities.map((o) => [o.DateLastModified, ''])).date : null, 'Opportunity movement'],
    [contacts.length ? latestOf(contacts.map((c) => [c.LastNote, ''])).date : null, 'Note/Email'],
    [taskRows[0]?.LastTaskDate || null, 'Task'],
    [jobOrderRows[0]?.LastJobActivity || null, 'Job activity'],
    [placementRows[0]?.LastPlacementDate || null, 'Placement'],
    [lastStatusChange, 'Status change'],
  ]);
  const days = daysSince(lastActivity);

  return {
    id: company.ID,
    companyName: company.CompanyName,
    status: company.Status,
    leadSource: company.LeadSource || company.BDSource || null,
    website: company.CompanyWebsite || null,
    phone: company.MainPhone || null,
    lastActivity,
    activitySource: source,
    daysSinceActivity: days,
    bucket: bucketFor(days),
    placementsTotal: Number(placementRows[0]?.PlacementCount) || 0,
    contacts: contacts
      .map((c) => ({
        id: c.ID,
        name: [c.FirstName, c.LastName].filter(Boolean).join(' ') || c.Name || 'Unnamed contact',
        title: c.Title || null,
        email: c.Email1 || null,
        phone: c.DirectPhone || null,
        lastNote: c.LastNote || null,
      }))
      .sort((a, b) => new Date(b.lastNote || 0) - new Date(a.lastNote || 0)),
    opportunities: opportunities
      .map((o) => ({
        id: o.ID,
        title: o.Title,
        dealStage: o.DealStage,
        dealValue: o.DealValue,
        dateLastModified: o.DateLastModified,
      }))
      .sort((a, b) => new Date(b.dateLastModified || 0) - new Date(a.dateLastModified || 0)),
  };
}

module.exports = { ALLOWED_BDMS, getDashboardData, getOtherBdsData, getAccountDetail };
