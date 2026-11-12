'use strict';

const { getLeadFacetsCacheSeconds } = require('../config/env');

// The Lead Exchange filter-dropdown data (statuses, dealers, Happy/Unhappy counts,
// scenarios) is global and only changes as leads arrive. It is kept in this function
// instance's memory for a short time so reopening the page does not re-count the whole
// leads table each time. The lead rows of a page are never cached. An explicit refresh
// (freshFacets) skips and replaces it.
let entry = null;

function clear() {
  entry = null;
}

function peek(now = Date.now()) {
  const ttlMs = getLeadFacetsCacheSeconds() * 1000;
  if (ttlMs <= 0 || !entry || now - entry.at >= ttlMs) return null;
  return entry.value;
}

function store(value, now = Date.now()) {
  if (getLeadFacetsCacheSeconds() > 0) entry = { value, at: now };
  return value;
}

module.exports = { peek, store, clear };
