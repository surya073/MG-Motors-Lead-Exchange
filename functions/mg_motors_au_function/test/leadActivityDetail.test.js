'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

const test = require('node:test');
const assert = require('node:assert/strict');
const zoho = require('../services/zohoCrmService');
const crm = require('../services/integrations/crmIntegrationService');
const { getLeadActivityDetails } = require('../services/leadActivityDetailService');

const LEAD = { crm_record_id: 'ZL1', dealer_code: 'AU100' };

test('Connected CRM, Test Drive Date and Closed Date come from MG Zoho', async (t) => {
  t.mock.method(zoho, 'fetchOemLeadsByIds', async () => [{ Connected_CRM: 'Dealer Studio', Test_Drive_Date: '2026-11-20', Sold_Date: '2026-11-25' }]);
  const out = await getLeadActivityDetails({}, LEAD);
  assert.deepEqual(out, { connected_crm: 'Dealer Studio', test_drive_date: '2026-11-20', closed_date: '2026-11-25', dealer_crm_status: '', dealer_crm_status_at: '' });
});

test('an empty Connected CRM falls back to the dealer integration', async (t) => {
  t.mock.method(zoho, 'fetchOemLeadsByIds', async () => [{ Test_Drive_Date: '2026-11-20' }]);
  t.mock.method(crm, 'getIntegrationByDealerCode', async () => ({ crm_type: 'FUSION_SD' }));
  const out = await getLeadActivityDetails({}, LEAD);
  assert.equal(out.connected_crm, 'Fusion SD');
  assert.equal(out.test_drive_date, '2026-11-20');
  assert.equal(out.closed_date, '');
});

test('if MG Zoho cannot be read the page still gets Connected CRM from the integration and blank dates', async (t) => {
  t.mock.method(zoho, 'fetchOemLeadsByIds', async () => { throw new Error('Zoho down'); });
  t.mock.method(crm, 'getIntegrationByDealerCode', async () => ({ crm_type: 'DEALER_STUDIO' }));
  const out = await getLeadActivityDetails({}, LEAD);
  assert.deepEqual(out, { connected_crm: 'Dealer Studio', test_drive_date: '', closed_date: '', dealer_crm_status: '', dealer_crm_status_at: '' });
});

test('nothing is read for a lead without a record id; a failed integration read is tolerated', async (t) => {
  const read = t.mock.method(zoho, 'fetchOemLeadsByIds', async () => []);
  assert.deepEqual(await getLeadActivityDetails({}, {}), { connected_crm: '', test_drive_date: '', closed_date: '', dealer_crm_status: '', dealer_crm_status_at: '' });
  assert.equal(read.mock.callCount(), 0);
  t.mock.method(crm, 'getIntegrationByDealerCode', async () => { throw new Error('read failed'); });
  const out = await getLeadActivityDetails({}, LEAD);
  assert.equal(out.connected_crm, '');
});

test('a Fusion lead also gets the dealer status Fusion last reported; other CRMs are not read', async (t) => {
  const status = require('../services/integrations/dealerStatusService');
  t.mock.method(zoho, 'fetchOemLeadsByIds', async () => [{ Connected_CRM: 'Fusion SD' }]);
  const read = t.mock.method(status, 'readLatestDealerStatus', async () => ({ status: 'Delivered', at: '2026-11-12T07:00:00.000Z' }));
  const fusion = await getLeadActivityDetails({}, LEAD);
  assert.equal(fusion.dealer_crm_status, 'Delivered');
  assert.equal(fusion.dealer_crm_status_at, '2026-11-12T07:00:00.000Z');
  t.mock.method(zoho, 'fetchOemLeadsByIds', async () => [{ Connected_CRM: 'Dealer Studio' }]);
  const other = await getLeadActivityDetails({}, LEAD);
  assert.equal(other.dealer_crm_status, '');
  assert.equal(read.mock.callCount(), 1, 'only the Fusion lead was read');
});
