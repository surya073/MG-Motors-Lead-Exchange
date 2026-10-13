'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const { VIEW_USER_ROLE_ID } = require('../middleware/requireAdminOrViewRole');
const { APP_ROLES, CATALYST_ROLE_ID_MAP } = require('../constants/roles.constants');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

const DEALER_ROLE_ID = Object.keys(CATALYST_ROLE_ID_MAP).find((id) => CATALYST_ROLE_ID_MAP[id] === APP_ROLES.DEALER);

// The router is mounted at /admin/dealers, so this is
// GET /admin/dealers/leads/:crmRecordId/timeline. It returns any lead's
// integration history, so like the other read-only routes here it is limited
// to admins and view users. (The UI reads /admin/leads/:id/timeline instead.)
async function getTimeline(t, roleId) {
  const server = express();
  server.use((req, res, next) => {
    res.locals.currentUser = { email_id: 'u@example.com', role_details: { role_id: roleId } };
    next();
  });
  server.use(routes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/leads/ZL1/timeline`);
  return { status: response.status, body: await response.json() };
}

test('the lead timeline route refuses dealers and serves admins and view users', async (t) => {
  t.mock.method(catalyst, 'initialize', () => ({}));
  const timeline = t.mock.method(crmIntegrationService, 'getLeadActivityTimeline', async () => [{ event: 'x' }]);

  const dealer = await getTimeline(t, DEALER_ROLE_ID);
  assert.equal(dealer.status, 403);
  assert.equal(timeline.mock.callCount(), 0, 'no timeline is read for a dealer');

  for (const roleId of [SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID, VIEW_USER_ROLE_ID]) {
    const allowed = await getTimeline(t, roleId);
    assert.equal(allowed.status, 200, roleId);
    assert.deepEqual(allowed.body, { timeline: [{ event: 'x' }] });
  }
});
