'use strict';

// The Catalyst role IDs are copied by hand into the backend (this project)
// and the portal (mg-motor-web/src/constants/auth.constants.js), plus a few
// backend files that hold their own constant. They are separate deployables
// with no shared code, so a role re-created in the Catalyst console and
// updated in only one place silently breaks access or notifications. These
// tests make that drift fail here instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CATALYST_ROLE_ID_MAP, CATALYST_ROLE_NAME_MAP, APP_ROLES } = require('../constants/roles.constants');
const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const { VIEW_USER_ROLE_ID } = require('../middleware/requireAdminOrViewRole');

const ROOT = path.join(__dirname, '..');
const PORTAL_CONSTANTS = path.join(ROOT, '..', '..', 'mg-motor-web', 'src', 'constants', 'auth.constants.js');

// Reads `export const NAME = { "key": APP_ROLES.X, ... };` from the portal's ES module source.
function portalMap(source, name) {
  const block = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(source);
  assert.ok(block, `${name} not found in auth.constants.js`);
  const map = {};
  for (const [, key, role] of block[1].matchAll(/^\s*"([^"]+)":\s*APP_ROLES\.(\w+)/gm)) map[key] = role;
  return map;
}

function idFor(role) {
  return Object.keys(CATALYST_ROLE_ID_MAP).find((id) => CATALYST_ROLE_ID_MAP[id] === role);
}

function constantIn(file, name) {
  const match = new RegExp(`const ${name} = '(\\d+)'`).exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  assert.ok(match, `${name} not found in ${file}`);
  return match[1];
}

test('portal and backend map the same Catalyst role IDs and names to the same app roles', (t) => {
  if (!fs.existsSync(PORTAL_CONSTANTS)) return t.skip('mg-motor-web is not checked out next to this function');
  const source = fs.readFileSync(PORTAL_CONSTANTS, 'utf8');
  assert.deepEqual(portalMap(source, 'CATALYST_ROLE_ID_MAP'), CATALYST_ROLE_ID_MAP);
  assert.deepEqual(portalMap(source, 'CATALYST_ROLE_NAME_MAP'), CATALYST_ROLE_NAME_MAP);
});

test('role guards and services use the role IDs from roles.constants.js', () => {
  assert.equal(SUPER_ADMIN_ROLE_ID, idFor(APP_ROLES.SUPER_ADMIN));
  assert.equal(ADMIN_ROLE_ID, idFor(APP_ROLES.ADMIN));
  assert.equal(VIEW_USER_ROLE_ID, idFor(APP_ROLES.VIEW_USER));
  assert.equal(constantIn('services/adminUserService.js', 'DEALER_ROLE_ID'), idFor(APP_ROLES.DEALER));
  assert.equal(constantIn('services/dealerInviteService.js', 'DEALER_ROLE_ID'), idFor(APP_ROLES.DEALER));
});
