const axios = require('axios');

const CDATA_URL = 'https://cloud.cdata.com/api/query';
const CONNECTION = process.env.CDATA_CONNECTION || 'BullhornCRM1';
const TABLE = `${CONNECTION}.BullhornCRM`;

function authHeader() {
  const token = Buffer.from(`${process.env.CDATA_USER}:${process.env.CDATA_PAT}`).toString('base64');
  return `Basic ${token}`;
}

// This connector does NOT support standard SQL '' apostrophe-escaping (it's translated
// to Bullhorn's own query language underneath and errors on it). Values containing an
// apostrophe are matched with LIKE, substituting '_' (matches exactly one char) for the
// apostrophe, which gives an exact-length match without ever emitting a raw quote.
function literal(value) {
  const str = String(value);
  if (str.includes("'")) {
    return { op: 'LIKE', value: str.replace(/'/g, '_') };
  }
  return { op: '=', value: str };
}

function esc(value) {
  return String(value).replace(/'/g, '');
}

function matchAny(column, values) {
  const clauses = values.map((v) => {
    const { op, value } = literal(v);
    return `${column} ${op} '${value}'`;
  });
  return `(${clauses.join(' OR ')})`;
}

// Global concurrency gate — caps parallel CData requests to avoid 429s.
const MAX_CONCURRENT = 6;
let activeCount = 0;
const waiters = [];

function acquireSlot() {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next();
  else activeCount--;
}

async function runQuery(query, { retries = 3 } = {}) {
  await acquireSlot();
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await axios.post(
          CDATA_URL,
          { query, connection: CONNECTION },
          {
            headers: {
              Authorization: authHeader(),
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            timeout: 60000,
          }
        );

        if (res.data.error) {
          throw new Error(res.data.error.message || 'CData query failed');
        }

        const result = res.data.results?.[0];
        if (!result) return [];

        const columns = result.schema.map((c) => c.columnLabel);
        return result.rows.map((row) => {
          const obj = {};
          columns.forEach((col, i) => { obj[col] = row[i]; });
          return obj;
        });
      } catch (err) {
        const status = err.response?.status;
        if (status === 429 && attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  } finally {
    releaseSlot();
  }
}

module.exports = { runQuery, esc, matchAny, TABLE };
