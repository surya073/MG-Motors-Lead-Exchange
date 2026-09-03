'use strict';

/**
 * logger.js
 * -----------------------------------------------------------------------
 * Minimal, dependency-free logging with a consistent prefix. Swap this
 * for a real logging library later without touching any calling code.
 */

function info(context, message, meta) {
  console.log(`[INFO] [${context}] ${message}`, meta ? JSON.stringify(meta) : '');
}

function error(context, message, err) {
  console.error(`[ERROR] [${context}] ${message}`, err?.message || err || '');
}

module.exports = { info, error };