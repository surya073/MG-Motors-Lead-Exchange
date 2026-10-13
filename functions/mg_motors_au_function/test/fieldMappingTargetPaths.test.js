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

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const pathPolicy = require('../services/integrations/pathPolicyService');

// Saved mapping targets become property paths: Fusion SD expands
// "contact.email" into { contact: { email } }. A target that would write
// through Object.prototype is refused for every CRM type, and for Fusion two
// targets that cannot both exist in one nested body are refused as well.

const STATUS_MAPPINGS = [{ source_status: 'Not Contacted', target_status: 'Open' }];

function fieldsWith(targets) {
  return pathPolicy.REQUIRED_DELIVERY_MAPPING_FIELDS.map((source_field) => ({
    source_field,
    target_field: targets[source_field] || `t_${source_field}`,
    data_type: 'string',
    required: true,
  }));
}

async function setup(t, crmType) {
  const db = createInMemoryZcql({
    dealer_integrations: [{ ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: crmType }],
    integration_status_mappings: [],
    integration_field_mappings: [],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);

  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: ADMIN_ROLE_ID } };
    next();
  });
  server.use(routes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());

  const save = async (fieldMappings) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/AU999/integration/mappings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldMappings, statusMappings: STATUS_MAPPINGS }),
    });
    return { status: response.status, body: await response.json() };
  };
  const useCrmType = (type) => { db.tables.dealer_integrations[0].crm_type = type; };
  return { db, save, useCrmType };
}

test('a target that walks into __proto__, prototype or constructor is refused for every CRM type', async (t) => {
  const { db, save, useCrmType } = await setup(t, 'FUSION_SD');

  for (const crmType of ['FUSION_SD', 'GENERIC_REST', 'ZOHO_CRM']) {
    useCrmType(crmType);
    for (const target of ['__proto__.polluted', 'contact.constructor', 'prototype']) {
      const result = await save(fieldsWith({ customer_name: target }));
      assert.equal(result.status, 400, `${crmType} ${target}`);
      assert.deepEqual(result.body, { error: 'FIELD_MAPPING_INVALID', targetField: target, reason: 'RESERVED_SEGMENT' });
    }
  }
  assert.equal(db.tables.integration_field_mappings.length, 0, 'nothing is written');
});

test('Fusion SD: a target that is the parent of another is refused; flat-key CRMs keep both', async (t) => {
  const { db, save, useCrmType } = await setup(t, 'FUSION_SD');
  const fields = fieldsWith({ customer_name: 'contact', mobile_number: 'contact.phone' });

  const refused = await save(fields);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, {
    error: 'FIELD_MAPPING_INVALID',
    targetField: 'contact',
    conflictsWith: 'contact.phone',
    reason: 'PARENT_AND_CHILD',
  });
  assert.equal(db.tables.integration_field_mappings.length, 0);

  // GENERIC_REST sends targets as flat keys, so "contact" and "contact.phone"
  // are simply two different fields there.
  useCrmType('GENERIC_REST');
  const saved = await save(fields);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
});

test('Fusion SD: a target with an empty segment is refused', async (t) => {
  const { save, useCrmType } = await setup(t, 'FUSION_SD');

  for (const target of ['contact..email', '.contact', 'contact.']) {
    const result = await save(fieldsWith({ email_address: target }));
    assert.equal(result.status, 400, target);
    assert.deepEqual(result.body, { error: 'FIELD_MAPPING_INVALID', targetField: target, reason: 'EMPTY_SEGMENT' });
  }

  useCrmType('GENERIC_REST');
  assert.equal((await save(fieldsWith({ email_address: 'contact..email' }))).status, 200);
});

test('the Fusion preset and the AU008 Zoho mapping still save', async (t) => {
  const { save, useCrmType } = await setup(t, 'FUSION_SD');

  // FUSION_DEFAULT_FIELD_MAPPINGS in mg-motor-web/src/pages/Dealers/DealerCRMConfig.jsx.
  const fusionPreset = [
    ['enquiry_id', 'refID'], ['customer_name', 'contact.firstName'], ['mobile_number', 'contact.phone'],
    ['email_address', 'contact.email'], ['postcode', 'contact.areaCode'], ['vehicle_model', 'requirement.model'],
    ['nature_of_enquiry', 'enquiryType'], ['lead_source', 'leadSource'], ['dealer_code', 'campaign'],
    ['accept_privacy_policy', 'privacy'], ['lead_status', 'enquiryStatus'],
    ['receive_marketing_updates', 'contact.optinEmail'], ['dealer_rejected_reason', 'lostReason'],
  ].map(([source_field, target_field]) => ({ source_field, target_field, data_type: 'string', required: false }));
  const fusion = await save(fusionPreset);
  assert.equal(fusion.status, 200, JSON.stringify(fusion.body));

  // AU008's live mapping (ZOHO_CRM), read from the datastore on 13 Oct 2026.
  useCrmType('ZOHO_CRM');
  const au008 = [
    ['enquiry_id', 'Enq_ID'], ['customer_name', 'Last_Name'], ['mobile_number', 'Phone'],
    ['email_address', 'Email'], ['postcode', 'Zip_Code'], ['vehicle_model', 'Enquiry_Model'],
    ['nature_of_enquiry', 'Enquiry_Name'], ['lead_source', 'Lead_Source'], ['dealer_code', 'Company'],
    ['accept_privacy_policy', 'Accept_Privacy_Policy'], ['lead_status', 'Lead_Status'],
    ['dealer_rejected_reason', 'Lead_Rejected_Reason'],
  ].map(([source_field, target_field]) => ({ source_field, target_field, data_type: 'string', required: false }));
  const zoho = await save(au008);
  assert.equal(zoho.status, 200, JSON.stringify(zoho.body));
});
