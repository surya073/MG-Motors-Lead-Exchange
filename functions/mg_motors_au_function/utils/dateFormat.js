'use strict';

/**
 * dateFormat.js
 * -----------------------------------------------------------------------
 * Catalyst Datastore's `datetime` column type expects
 * "YYYY-MM-DD HH:mm:ss" (space-separated, no milliseconds, no timezone
 * suffix) — not a standard ISOString(). This builds that format manually
 * from local/UTC date parts rather than string-slicing ISOString(),
 * since ISOString() always uses 'T' and 'Z', neither of which Catalyst
 * accepts here.
 */
function pad(n) {
  return String(n).padStart(2, '0');
}

function toCatalystDateTime(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

module.exports = { toCatalystDateTime };