'use strict';

/**
 * logger.js
 * -----------------------------------------------------------------------
 * Minimal, dependency-free logging with a consistent prefix. Swap this
 * for a real logging library later without touching any calling code.
 * Inside a request, each line also carries the request's id, so every log
 * line of one request can be grouped with its `[usage]` line.
 */

const usageContext = require('../services/usageContext');

function prefix(level) {
  const cid = usageContext.currentCid();
  return cid ? `[${level}] [cid=${cid}]` : `[${level}]`;
}

function info(context, message, meta) {
  console.log(`${prefix('INFO')} [${context}] ${message}`, meta ? JSON.stringify(meta) : '');
}

function error(context, message, err) {
  console.error(`${prefix('ERROR')} [${context}] ${message}`, err?.message || err || '');
}

module.exports = { info, error };
