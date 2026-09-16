'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const crmAdapterFactory = require('./crmAdapterFactory');
const leadMappingService = require('./leadMappingService');
const integrationAuthService = require('./integrationAuthService');

const DEALERS_TABLE = 'dealers';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const FIELD_MAPPINGS_TABLE = 'integration_field_mappings';
const STATUS_MAPPINGS_TABLE = 'integration_status_mappings';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const INTEGRATION_LOGS_TABLE = 'integration_logs';
const WEBHOOK_EVENTS_TABLE = 'webhook_events';
const LEADS_TABLE = 'leads';

   

/**
 * crmIntegrationService.js
 * -----------------------------------------------------------------------
 * Orchestration layer. Does not know HTTP specifics of any CRM (adapter's
 * job) or Zoho API specifics (zohoCrmService's job).
 *
 * IMPORTANT: everywhere below, "zohoLead" / "leadRow" refers to a row
 * shaped exactly like leadSyncService.js's `leads` table — i.e. fields
 * are dealer_code, customer_name, mobile_number, email_address,
 * vehicle_model, lead_source, lead_status, dealer_remarks,
 * assigned_date, last_status_update, crm_record_id, ROWID. This is our
 * OWN internal naming (matches the Catalyst table), NOT Zoho's CRM API
 * field names (Dealer_Code, Customer_Name, etc — those only exist at
 * the zohoCrmService boundary). Admin-configured field mappings map
 * FROM these internal names TO the external CRM's field names.
 */

function safeQuoteForZcql(value) {
  // Defensive escaping for values interpolated into ZCQL string literals
  // below (dealer codes / lead ids are expected to be simple codes, but
  // this guards against a stray apostrophe breaking the query or,
  // worse, enabling injection).
  return String(value).replace(/'/g, "''");
}

async function findDealerByCode(catalystApp, dealerCode) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${DEALERS_TABLE} WHERE dealer_code = '${safeQuoteForZcql(dealerCode)}' LIMIT 1`
  );
  return rows.length > 0 ? rows[0][DEALERS_TABLE] : null;
}

async function getIntegrationByDealerCode(catalystApp, dealerCode) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE dealer_code = '${safeQuoteForZcql(dealerCode)}' LIMIT 1`
  );
  logger.info('crmIntegrationService', `getIntegrationByDealerCode(${dealerCode}) rows=${rows.length} raw=${JSON.stringify(rows)}`); // TEMP DEBUG
  return rows.length > 0 ? rows[0][DEALER_INTEGRATIONS_TABLE] : null;
}

async function getFieldMappings(catalystApp, integrationId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${FIELD_MAPPINGS_TABLE} WHERE integration_id = ${integrationId}`
  );
  return rows.map((r) => r[FIELD_MAPPINGS_TABLE]);
}

async function getStatusMappings(catalystApp, integrationId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${STATUS_MAPPINGS_TABLE} WHERE integration_id = ${integrationId}`
  );
  return rows.map((r) => r[STATUS_MAPPINGS_TABLE]);
}

async function writeLog(catalystApp, entry) {
  try {
    await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).insertRow(entry);
  } catch (err) {
    logger.error('crmIntegrationService', 'Failed to write integration log', err);
  }
}

/**
 * ============================================================
 * OUTBOUND: our `leads` row -> External CRM
 * ============================================================
 * Called from leadSyncService.js's syncLeads() loop — see the exact
 * patch to that file below. `leadRow` is the mappedRow (+ crm_record_id
 * and ROWID) already produced by mapCrmRecordToLeadRow there — we do
 * NOT re-fetch or re-shape anything here.
 */




async function syncLeadToExternalCrm(catalystApp, integration, leadRow) {
  if (!integration.outbound_enabled) {
    return { skipped: true, reason: 'OUTBOUND_DISABLED' };
  }

  const requestReference = crypto.randomUUID();
  const zohoLeadId = leadRow.crm_record_id;

  try {
    const fieldMappings = await getFieldMappings(catalystApp, integration.ROWID);
    const statusMappings = await getStatusMappings(catalystApp, integration.ROWID);

    const payload = leadMappingService.mapZohoLeadToExternal(leadRow, fieldMappings);
    if (leadRow.lead_status) {
      payload.status = leadMappingService.mapStatus(leadRow.lead_status, statusMappings, 'ZOHO_TO_EXTERNAL');
    }

    const adapter = crmAdapterFactory.getAdapter(integration.crm_type);

    const existingMappingRows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE zoho_lead_id = '${safeQuoteForZcql(zohoLeadId)}' LIMIT 1`
    );
    const existingMapping = existingMappingRows.length > 0 ? existingMappingRows[0][LEAD_INTEGRATIONS_TABLE] : null;

    let result;
    let operation;
    if (existingMapping?.external_crm_lead_id) {
      result = await adapter.updateLead(catalystApp, integration, existingMapping.external_crm_lead_id, payload);
      operation = 'UPDATE_LEAD';
    } else {
      result = await adapter.createLead(catalystApp, integration, payload);
      operation = 'CREATE_LEAD';
      
      
    }

   

    logger.info('crmIntegrationService', `${operation} raw Zoho response: ${JSON.stringify(result.raw)}`);

    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const mappingTable = catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE);

    if (existingMapping) {
      await mappingTable.updateRow({
        ROWID: existingMapping.ROWID,
        external_crm_lead_id: result.externalLeadId || existingMapping.external_crm_lead_id,
        sync_status: 'SYNCED',
        last_synced_at: toCatalystDateTime(),
        last_sync_direction: 'ZOHO_TO_EXTERNAL_CRM',
        last_sync_source_hash: sourceHash,
      });
    } else {
      await mappingTable.insertRow({
        dealer_code: integration.dealer_code,
        zoho_lead_id: zohoLeadId,
        external_crm_lead_id: result.externalLeadId,
        integration_id: integration.ROWID,
        sync_status: 'SYNCED',
        last_synced_at: toCatalystDateTime(),
        last_sync_direction: 'ZOHO_TO_EXTERNAL_CRM',
        last_sync_source_hash: sourceHash,
      });
    }

    await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).updateRow({
      ROWID: integration.ROWID,
      last_sync_at: toCatalystDateTime(),
      status: 'ACTIVE',
    });

    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation,
      zoho_lead_id: zohoLeadId,
      external_lead_id: result.externalLeadId || existingMapping?.external_crm_lead_id,
      status: 'SUCCESS',
      http_status: result.httpStatus,
      request_reference: requestReference,
    });

    return { ok: true, externalLeadId: result.externalLeadId };
  } catch (err) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation: 'CREATE_LEAD',
      zoho_lead_id: zohoLeadId,
      status: 'FAILED',
      http_status: err.response?.status,
      error_message: (err.code || err.message || 'EXTERNAL_CRM_ERROR').slice(0, 500),
      request_reference: requestReference,
    });

    if (err.response?.status === 401 || err.response?.status === 403) {
      await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).updateRow({
        ROWID: integration.ROWID,
        status: 'ERROR',
      });
    }

    logger.error('crmIntegrationService', `syncLeadToExternalCrm failed for dealer ${integration.dealer_code}`, err);
    throw err;
  }
}

/**
 * Internal field name -> Zoho CRM API field name, for the ONE direction
 * that actually touches zohoCrmService.updateOemLead(). This is
 * separate from admin-configurable integration_field_mappings (which
 * maps internal <-> external dealer CRM) — this map is fixed, since our
 * own `leads` table shape and Zoho's OEM_Leads API field names are both
 * fixed by leadSyncService.js / zohoCrmService.js, not admin-configurable.
 */
const INTERNAL_FIELD_TO_ZOHO_API_FIELD = {
  dealer_code: 'Dealer_Code',
  customer_name: 'Customer_Name',
  mobile_number: 'Mobile_Number',
  email_address: 'Email_Address',
  vehicle_model: 'Vehicle_Model',
  lead_source: 'Lead_Source',
  lead_status: 'Lead_Status',
  dealer_remarks: 'Dealer_Remarks',
};

function toZohoApiFields(internalFieldsObject) {
  const zohoFields = {};
  Object.entries(internalFieldsObject).forEach(([key, value]) => {
    const zohoKey = INTERNAL_FIELD_TO_ZOHO_API_FIELD[key];
    if (zohoKey) zohoFields[zohoKey] = value;
  });
  return zohoFields;
}

/**
 * ============================================================
 * INBOUND: External CRM webhook -> Zoho (via zohoCrmService.updateOemLead)
 * ============================================================
 */
async function processInboundWebhook(catalystApp, integration, externalPayload, zohoCrmService) {
  const fieldMappings = await getFieldMappings(catalystApp, integration.ROWID);
  const statusMappings = await getStatusMappings(catalystApp, integration.ROWID);

  const externalLeadId = externalPayload.id || externalPayload.leadId;
  if (!externalLeadId) {
    const err = new Error('Webhook payload missing external lead id');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  // Dealer isolation: scoped by BOTH dealer_code and external_crm_lead_id.
  const mappingRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE dealer_code = '${safeQuoteForZcql(integration.dealer_code)}' AND external_crm_lead_id = '${safeQuoteForZcql(externalLeadId)}' LIMIT 1`
  );

  if (mappingRows.length === 0) {
    const err = new Error(`No lead mapping found for external lead ${externalLeadId}`);
    err.code = 'LEAD_MAPPING_NOT_FOUND';
    throw err;
  }

  const mapping = mappingRows[0][LEAD_INTEGRATIONS_TABLE];

  // Loop prevention.
  const incomingHash = crypto.createHash('sha256').update(JSON.stringify(externalPayload)).digest('hex');
  if (mapping.last_sync_direction === 'ZOHO_TO_EXTERNAL_CRM' && mapping.last_sync_source_hash === incomingHash) {
    return { skipped: true, reason: 'LOOP_PREVENTED' };
  }

  // Step 1: external payload -> our internal field names.
  const internalUpdate = leadMappingService.mapExternalLeadToZoho(externalPayload, fieldMappings);
  if (externalPayload.status) {
    internalUpdate.lead_status = leadMappingService.mapStatus(externalPayload.status, statusMappings, 'EXTERNAL_TO_ZOHO');
  }

  if (Object.keys(internalUpdate).length === 0) {
    const err = new Error('Webhook payload produced no mapped fields to update');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  // Step 2: our internal field names -> Zoho CRM API field names.
  const zohoApiFields = toZohoApiFields(internalUpdate);

  const requestReference = crypto.randomUUID();

  try {
    // mapping.zoho_lead_id IS the Zoho CRM record id (crm_record_id),
    // matching zohoCrmService.updateOemLead(crmRecordId, fields)'s signature.
    await zohoCrmService.updateOemLead(mapping.zoho_lead_id, zohoApiFields);

    // Keep our local `leads` table in step with what we just pushed to
    // Zoho, so the UI doesn't show stale data until the next full sync.
    const localLeadRows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
    );
    if (localLeadRows.length > 0) {
      await catalystApp.datastore().table(LEADS_TABLE).updateRow({
        ROWID: localLeadRows[0][LEADS_TABLE].ROWID,
        ...internalUpdate,
        last_synced_at: toCatalystDateTime(),
      });
    }

    await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
      ROWID: mapping.ROWID,
      sync_status: 'SYNCED',
      last_synced_at: toCatalystDateTime(),
      last_sync_direction: 'EXTERNAL_CRM_TO_ZOHO',
      last_sync_source_hash: incomingHash,
    });

    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      zoho_lead_id: mapping.zoho_lead_id,
      external_lead_id: externalLeadId,
      status: 'SUCCESS',
      request_reference: requestReference,
    });

    return { ok: true, zohoLeadId: mapping.zoho_lead_id };
  } catch (err) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      zoho_lead_id: mapping.zoho_lead_id,
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: (err.message || 'ZOHO_UPDATE_FAILED').slice(0, 500),
      request_reference: requestReference,
    });
    const wrapped = new Error(err.message);
    wrapped.code = 'ZOHO_UPDATE_FAILED';
    throw wrapped;
  }
}

async function checkAndRecordWebhookEvent(catalystApp, integration, rawBody, eventId) {
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  const dupeQuery = eventId
    ? `SELECT ROWID FROM ${WEBHOOK_EVENTS_TABLE} WHERE integration_id = ${integration.ROWID} AND event_id = '${safeQuoteForZcql(eventId)}'`
    : `SELECT ROWID FROM ${WEBHOOK_EVENTS_TABLE} WHERE integration_id = ${integration.ROWID} AND payload_hash = '${payloadHash}'`;

  const existing = await catalystApp.zcql().executeZCQLQuery(dupeQuery);
  if (existing.length > 0) {
    return { isDuplicate: true };
  }

  const inserted = await catalystApp.datastore().table(WEBHOOK_EVENTS_TABLE).insertRow({
    integration_id: integration.ROWID,
    dealer_code: integration.dealer_code,
    event_id: eventId || null,
    payload_hash: payloadHash,
    processing_status: 'RECEIVED',
    received_at: toCatalystDateTime(),
  });

  return { isDuplicate: false, eventRowId: inserted.ROWID };
}

async function markWebhookEventStatus(catalystApp, eventRowId, status, errorMessage) {
  await catalystApp.datastore().table(WEBHOOK_EVENTS_TABLE).updateRow({
    ROWID: eventRowId,
    processing_status: status,
    processed_at: toCatalystDateTime(),
    error_message: errorMessage ? String(errorMessage).slice(0, 500) : undefined,
  });
}

async function testConnection(catalystApp, integration) {
  const adapter = crmAdapterFactory.getAdapter(integration.crm_type);
  const result = await adapter.testConnection(catalystApp, integration);

  await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).updateRow({
    ROWID: integration.ROWID,
    last_tested_at: toCatalystDateTime(),
    status: result.ok ? 'CONNECTED' : 'ERROR',
  });

  await writeLog(catalystApp, {
    integration_id: integration.ROWID,
    dealer_code: integration.dealer_code,
    direction: 'ZOHO_TO_EXTERNAL_CRM',
    operation: 'TEST_CONNECTION',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    http_status: result.httpStatus,
  });

  return result;
}

module.exports = {
  findDealerByCode,
  getIntegrationByDealerCode,
  getFieldMappings,
  getStatusMappings,
  syncLeadToExternalCrm,
  processInboundWebhook,
  checkAndRecordWebhookEvent,
  markWebhookEventStatus,
  testConnection,
};