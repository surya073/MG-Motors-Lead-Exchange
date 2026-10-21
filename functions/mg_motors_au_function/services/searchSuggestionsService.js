'use strict';

// Navbar matching mirrors globalSearch.js: every whitespace-delimited token
// may match any searchable field. Return only the five/four suggestions the
// navbar displays, rather than transferring the entire customer lead table.
const MAX_TOKENS = 9; // dealer scope + nine token groups stays inside ZCQL's AND budget
const MAX_QUERY_LENGTH = 256;
const PAGE_SIZE = 300;
const LEAD_COLUMNS = 'ROWID, customer_name, email_address, mobile_number, vehicle_model, dealer_code, lead_status';
const SEARCHABLE_LEAD_COLUMNS = ['customer_name', 'email_address', 'mobile_number', 'vehicle_model', 'dealer_code'];

const quote = (value) => String(value ?? '').replace(/'/g, "''");
const containsEvery = (values, tokens) => {
  const haystack = values.map((value) => String(value ?? '')).join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
};

function searchTokens(raw = '') {
  if (typeof raw !== 'string' || raw.length > MAX_QUERY_LENGTH) {
    throw Object.assign(new Error('Search must be text of at most 256 characters.'), { statusCode: 400 });
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 2) return [];
  const tokens = [...new Set(trimmed.split(/\s+/))];
  if (tokens.length > MAX_TOKENS || trimmed.includes('*')) {
    throw Object.assign(new Error('Use up to nine search words without wildcard characters.'), { statusCode: 400 });
  }
  return tokens;
}

async function dealerDirectory(catalystApp) {
  const dealers = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // Only the small dealer directory is read in full. No lead count or CRM
    // configuration is needed for suggestions. Stable order preserves the
    // original navbar's first matching dealers, including across pages.
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, dealer_code, dealer_name, city, state, region FROM dealers ORDER BY ROWID ASC LIMIT ${offset + 1}, ${PAGE_SIZE}`
    );
    dealers.push(...rows.map((row) => row.dealers));
    if (rows.length < PAGE_SIZE) return dealers;
  }
}

function leadTokenCondition(token, names) {
  const conditions = SEARCHABLE_LEAD_COLUMNS.map((column) => `${column} LIKE '*${quote(token)}*'`);
  if (names) {
    const matching = [...names].filter(([, name]) => String(name || 'Unknown').toLowerCase().includes(token));
    if (matching.length) conditions.push(`dealer_code IN (${matching.map(([code]) => `'${quote(code)}'`).join(', ')})`);
    // The legacy admin response calls an unmapped/unnamed dealer "Unknown".
    // Preserve searches for that text without ever loading all lead rows.
    if ('unknown'.includes(token)) {
      const known = [...names].filter(([, name]) => Boolean(name)).map(([code]) => code);
      if (!known.length) return null; // every lead has the matching fallback name
      conditions.push(`(dealer_code IS NULL OR dealer_code NOT IN (${known.map((code) => `'${quote(code)}'`).join(', ')}))`);
    }
  }
  return `(${conditions.join(' OR ')})`;
}

async function matchingLeads(catalystApp, tokens, { dealerCode, names } = {}) {
  const conditions = tokens.map((token) => leadTokenCondition(token, names)).filter(Boolean);
  if (dealerCode !== undefined) {
    const code = String(dealerCode ?? '').trim();
    if (!code) throw Object.assign(new Error('A dealer code is required.'), { statusCode: 403 });
    conditions.unshift(`dealer_code = '${quote(code)}'`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ${LEAD_COLUMNS} FROM leads ${where} ORDER BY ROWID ASC LIMIT 1, 5`
  );
  return rows.map(({ leads }) => names ? { ...leads, dealer_name: names.get(leads.dealer_code) || 'Unknown' } : leads);
}

async function adminSuggestions(catalystApp, query) {
  const tokens = searchTokens(query);
  if (!tokens.length) return { leads: [], dealers: [] };
  const directory = await dealerDirectory(catalystApp);
  const names = new Map(directory.map((dealer) => [dealer.dealer_code, dealer.dealer_name]));
  const dealers = directory.filter((dealer) => containsEvery(
    [dealer.dealer_name, dealer.dealer_code, dealer.city, dealer.state, dealer.region], tokens
  )).slice(0, 4);
  return { leads: await matchingLeads(catalystApp, tokens, { names }), dealers };
}

async function dealerSuggestions(catalystApp, dealerCode, query) {
  // Validate scope even for empty queries; never allow a missing mapping to
  // turn a dealer request into unrestricted suggestions.
  if (!String(dealerCode ?? '').trim()) throw Object.assign(new Error('A dealer code is required.'), { statusCode: 403 });
  const tokens = searchTokens(query);
  return { leads: tokens.length ? await matchingLeads(catalystApp, tokens, { dealerCode }) : [], dealers: [] };
}

module.exports = { adminSuggestions, dealerSuggestions, _test: { searchTokens, MAX_TOKENS, MAX_QUERY_LENGTH } };
