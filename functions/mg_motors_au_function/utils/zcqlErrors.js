'use strict';

/**
 * zcqlErrors.js
 * -----------------------------------------------------------------------
 * Catalyst rejects a WHERE clause that is too complex with
 * "More than 10 conditions are not allowed in where clause". Measured against
 * the live Data Store, the rule is NOT simply "10 ANDs":
 *   - a flat chain (all ANDs, all ORs or a mix at one level) may hold 10
 *     comparisons; 11 is rejected;
 *   - parenthesised groups each get their own chain, but the whole expression
 *     is still bounded — e.g. 7 groups of 3 ORs pass, 8 groups of 3 fail, and 4
 *     groups of 6 pass while 4 groups of 7 fail;
 *   - an IN (...) list counts as ONE comparison however long it is.
 * (The documentation's "five conditions" is not what is enforced.) The exact
 * rule is not published, so queries are built conservatively, and a rejection
 * that still happens is reported as a clear client error instead of a 502.
 */

class FilterTooComplexError extends Error {
  constructor(message = 'Too many filters combined for one query. Remove a filter and try again.') {
    super(message);
    this.code = 'FILTER_TOO_COMPLEX';
  }
}

const TOO_MANY_CONDITIONS = /More than \d+ conditions are not allowed/i;

/** The error to throw for a failed ZCQL call: a clean one when it was a complexity rejection. */
function translateZcqlError(err) {
  const message = String(err?.message || err?.err_msg || '');
  return TOO_MANY_CONDITIONS.test(message) ? new FilterTooComplexError() : err;
}

module.exports = { FilterTooComplexError, translateZcqlError, TOO_MANY_CONDITIONS };
