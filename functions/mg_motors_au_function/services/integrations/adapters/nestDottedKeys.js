'use strict';

const logger = require('../../../utils/logger');
const { RESERVED_TARGET_SEGMENTS } = require('../leadMappingService');

/**
 * nestDottedKeys.js
 * -----------------------------------------------------------------------
 * Field mappings produce flat keys, but some CRMs (Fusion SD, Dealer Studio)
 * expect a nested body ({ address_attributes: { postcode } }). A mapping whose
 * target_field is a dotted path ("address_attributes.postcode") is expanded
 * here, so the mapping table stays the single place field names are
 * configured. Keys without a dot pass through untouched.
 *
 * The mapping save route refuses unsafe targets; this is the second line of
 * defence. A key with a __proto__/prototype/constructor segment is skipped,
 * only own properties are walked, and a value never replaces a nested group
 * or the reverse: the first one written is kept and the other is logged.
 */

function isNestedGroup(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestDottedKeys(flat, label = 'nestDottedKeys') {
  const out = {};
  const skip = (key, reason) => {
    logger.error(label, `Skipped mapping target "${key}": ${reason}`);
  };
  Object.entries(flat || {}).forEach(([key, value]) => {
    const parts = key.split('.').filter(Boolean);
    if (parts.some((part) => RESERVED_TARGET_SEGMENTS.has(part))) {
      skip(key, 'reserved path segment');
      return;
    }
    if (parts.length <= 1) {
      if (Object.hasOwn(out, key) && isNestedGroup(out[key])) {
        skip(key, 'it would replace a nested group of fields');
        return;
      }
      out[key] = value;
      return;
    }
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(node, part)) {
        node[part] = {};
      } else if (!isNestedGroup(node[part])) {
        skip(key, `"${part}" already holds a value`);
        return;
      }
      node = node[part];
    }
    const leaf = parts[parts.length - 1];
    if (Object.hasOwn(node, leaf) && isNestedGroup(node[leaf])) {
      skip(key, 'it would replace a nested group of fields');
      return;
    }
    node[leaf] = value;
  });
  return out;
}

module.exports = { nestDottedKeys, isNestedGroup };
