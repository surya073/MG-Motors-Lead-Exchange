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

const REJECTION_STATUS_VALUES = new Set([
  'rejected',
  'not qualified',
  'lost',
  'lost lead',
  'junk lead',
  'junk',
  'spam',
  'Junk Lead / Spam',
]);
   

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

function extractAffectedFieldNames(externalPayload, externalLeadId) {
  const raw = externalPayload.affected_fields;
  if (!Array.isArray(raw)) return null;
  const flattened = [];
  raw.forEach((entry) => {
    if (typeof entry === 'string') {
      flattened.push(entry);
    } else if (entry && typeof entry === 'object') {
      Object.entries(entry).forEach(([id, fields]) => {
        if (Array.isArray(fields) && (!externalLeadId || id === externalLeadId)) {
          flattened.push(...fields);
        }
      });
    }
  });
  return flattened;
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
          try {
            payload.status = leadMappingService.mapStatus(leadRow.lead_status, statusMappings, 'ZOHO_TO_EXTERNAL');
          } catch (err) {
            // Unmapped OEM status — don't let this kill the entire lead push.
            // Every other field (name, mobile, vehicle, etc.) is still worth
            // sending to the dealer's CRM even if status has no known mapping
            // yet. Log it so an admin can see the gap and add the mapping.
            logger.error(
              'crmIntegrationService',
              `Unmapped OEM status "${leadRow.lead_status}" for dealer ${integration.dealer_code} — status not pushed, other fields still synced`,
              err
            );
          }
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
  customer_name: 'Customer_Name', // see note below
  mobile_number: 'Mobile',
  email_address: 'Email',
  vehicle_model: 'Enquiry_Model',
  lead_source: 'Enquiry_Source',
  lead_status: 'Lead_Status',
  dealer_remarks: 'Dealer_Remarks',
  enquiry_status: 'Enquiry_Status',
  nature_of_enquiry: 'Nature_of_Enquiry',
  purchase_classification: 'Purchase_Classification',
  enquiry_outcome: 'Enquiry_Outcome',
  lead_department: 'Lead_Department',
  franchise: 'Franchise',
  enquiry_id: 'Enquiry_ID',
  customer_message: 'Customer_Message',
  accept_privacy_policy: 'Accept_Privacy_Policy',
  receive_marketing_updates: 'Receive_Marketing_Updates',
  postcode: 'Postcode',
  unit_suite: 'Unit_Suite',
  enquiry_variant: 'Enquiry_Variant',
  enquiry_powertrain: 'Enquiry_Powertrain',
  chat_transcript: 'Chat_Transcript',
};

function toZohoApiFields(internalFieldsObject) {
  const zohoFields = {};
  Object.entries(internalFieldsObject).forEach(([key, value]) => {
    const zohoKey = INTERNAL_FIELD_TO_ZOHO_API_FIELD[key];
    if (zohoKey) zohoFields[zohoKey] = value;
  });
  return zohoFields;
}

const INVALID_DATA_ERROR_CODES = new Set(['FIELD_MAPPING_INVALID', 'STATUS_MAPPING_NOT_FOUND']);

/**
 * Classifies a log entry into the happy/unhappy path taxonomy, so it's
 * persisted at write time instead of re-derived on every read.
 *
 * classificationHint.isStatusSync distinguishes Happy 2 (dealer status
 * change) from Happy 5 (other dealer-side field change) on inbound
 * success — both used to log identically as UPDATE_LEAD with no way to
 * tell them apart afterward.
 *
 * NOTE: this now checks error_message codes even on the
 * EXTERNAL_CRM_TO_ZOHO direction. Previously that direction only ever
 * reached writeLog via the OEM-write-back catch block, so "any failure
 * here = Unhappy 4" was a safe shortcut. Now that the early
 * LEAD_MAPPING_NOT_FOUND / FIELD_MAPPING_INVALID / STATUS_MAPPING_NOT_FOUND
 * throws in processInboundWebhook are also logged (see that function),
 * that shortcut would misclassify them, so those exact codes are
 * checked first.
 */
function classifyLogScenario({ direction, operation, status, error_message }, { isStatusSync, leadStatusValue } = {}) {
  if (operation === 'TEST_CONNECTION') {
    return status === 'SUCCESS'
      ? { name: 'Connection Test', message: 'Connection test succeeded.' }
      : { name: 'Connection Test Failed', message: 'Connection test failed.' };
  }

  if (status === 'SUCCESS') {
    if (direction === 'EXTERNAL_CRM_TO_ZOHO') {
      // A status sync that resolves to a rejection-type status (Junk
      // Lead, Spam, Rejected, etc.) is genuinely an Unhappy 9 outcome
      // even though the sync itself succeeded without error — the
      // dealer is closing the enquiry out as invalid, not progressing it.
      if (isStatusSync && REJECTION_STATUS_VALUES.has((leadStatusValue || '').trim().toLowerCase())) {
        return { name: 'Unhappy 9', message: 'Dealer rejects enquiry' };
      }
      return isStatusSync
        ? { name: 'Happy 2', message: 'Dealer progresses enquiry (status sync)' }
        : { name: 'Happy 5', message: 'Data synchronisation (dealer → OEM)' };
    }
    return { name: 'Happy 1', message: 'New enquiry routed successfully' };
  }

  // status === 'FAILED' from here down.
  const code = (error_message || '').trim();

  if (code === 'LEAD_MAPPING_NOT_FOUND') {
    return { name: 'Unhappy 7', message: 'Out-of-order events' };
  }

  if (INVALID_DATA_ERROR_CODES.has(code)) {
    return { name: 'Unhappy 2', message: 'Invalid / missing data' };
  }

  if (direction === 'EXTERNAL_CRM_TO_ZOHO') {
    // Everything else on this direction is the OEM write-back call
    // itself failing (ZOHO_UPDATE_FAILED) — genuinely Unhappy 4.
    return { name: 'Unhappy 4', message: 'Status update failure (dealer → OEM)' };
  }

  // ZOHO_TO_EXTERNAL_CRM, anything else — connectivity/API failure.
  return { name: 'Unhappy 1', message: 'API / integration failure' };
}

async function writeLog(catalystApp, entry, classificationHint) {
  const scenario = classifyLogScenario(entry, classificationHint);

  try {
    await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).insertRow({
      ...entry,
      happy_unhappy_path_name: scenario.name,
      happy_unhappy_path_message: scenario.message,
    });
  } catch (err) {
    logger.error('crmIntegrationService', 'Failed to write integration log', err);
  }

  // Mirror the same classification onto the lead row itself, so
  // LeadDetailView's hero badge can read a stored value instead of
  // re-guessing the scenario from lead_status/sync_status. Only
  // attempted when this log entry is actually tied to a known Zoho
  // lead (zoho_lead_id) — TEST_CONNECTION and early validation
  // failures (bad webhook payload, no lead mapping yet) have no
  // zoho_lead_id and are skipped here; they're still fully visible in
  // the dealer's raw Activity Log via integration_logs, just not
  // mirrored onto any specific lead.
  if (entry.zoho_lead_id) {
    try {
      const leadRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT ROWID FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(entry.zoho_lead_id)}' LIMIT 1`
      );
      if (leadRows.length > 0) {
        await catalystApp.datastore().table(LEADS_TABLE).updateRow({
          ROWID: leadRows[0][LEADS_TABLE].ROWID,
          happy_unhappy_path_name: scenario.name,
          happy_unhappy_path_message: scenario.message,
        });
      }
    } catch (err) {
      logger.error('crmIntegrationService', `Failed to mirror scenario onto lead ${entry.zoho_lead_id}`, err);
    }
  }
}

/**
 * ============================================================
 * INBOUND: External CRM webhook -> Zoho (via zohoCrmService.updateOemLead)
 * ============================================================
 */
/**
 * ============================================================
 * INBOUND: External CRM webhook -> Zoho (via zohoCrmService.updateOemLead)
 * ============================================================
 * Dispatches to a Zoho-notification-shaped handler when the dealer's
 * own CRM is itself Zoho CRM — that payload shape (`ids` + `affected_fields`,
 * no actual values) is fundamentally different from a generic REST CRM's
 * webhook (flat object with real field values), so it can't share the
 * single-record resolution logic below. Everything AFTER a record is
 * resolved (mapping, status sync, write-back, logging) is identical
 * for both, and lives in processResolvedInboundLead().
 */
async function processInboundWebhook(catalystApp, integration, externalPayload, zohoCrmService) {
  if (integration.crm_type === 'ZOHO_CRM') {
    return processInboundWebhookForZohoCrm(catalystApp, integration, externalPayload, zohoCrmService);
  }

  const requestReference = crypto.randomUUID();
  const fieldMappings = await getFieldMappings(catalystApp, integration.ROWID);
  const statusMappings = await getStatusMappings(catalystApp, integration.ROWID);

  const externalLeadId = externalPayload.id || externalPayload.leadId;
  if (!externalLeadId) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      status: 'FAILED',
      error_message: 'FIELD_MAPPING_INVALID',
      request_reference: requestReference,
    });
    const err = new Error('Webhook payload missing external lead id');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  return processResolvedInboundLead(
    catalystApp, integration, externalLeadId, externalPayload,
    fieldMappings, statusMappings, requestReference, zohoCrmService
  );
}

/**
 * Zoho-as-dealer-CRM path. A single Zoho notification can carry
 * multiple changed record ids (Zoho batches these), and — unlike a
 * generic REST webhook — carries no field values at all, only which
 * ids/fields changed. Each id must be fetched individually from the
 * dealer's Zoho org via getLead() before it can be mapped.
 *
 * Each id is processed independently: one id's failure (bad mapping,
 * transient Zoho error, etc.) must not prevent the others in the same
 * notification from syncing. Per-id outcomes are still written to
 * integration_logs exactly as before — this only changes how
 * externalLeadId/externalRecord get resolved, and how multiple ids in
 * one call are handled. The whole call is only reported as FAILED
 * (bubbled up to mark the webhook_events row) if every id in the batch
 * failed; markWebhookEventStatus/the HTTP response otherwise reflects
 * success even if some ids in the batch failed, since those failures
 * are already visible per-row in the Activity Log.
 */
async function processInboundWebhookForZohoCrm(catalystApp, integration, externalPayload, zohoCrmService) {
  const fieldMappings = await getFieldMappings(catalystApp, integration.ROWID);
  const statusMappings = await getStatusMappings(catalystApp, integration.ROWID);
  const adapter = crmAdapterFactory.getAdapter(integration.crm_type);

  const ids = Array.isArray(externalPayload.ids) ? externalPayload.ids : [];
  if (ids.length === 0) {
    const requestReference = crypto.randomUUID();
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      status: 'FAILED',
      error_message: 'FIELD_MAPPING_INVALID',
      request_reference: requestReference,
    });
    const err = new Error('Zoho notification payload missing ids');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  const results = [];
  let lastError = null;

  for (const externalLeadId of ids) {
    const requestReference = crypto.randomUUID();
    try {
      const fetched = await adapter.getLead(catalystApp, integration, externalLeadId);
      const zohoRecord = fetched.raw?.data?.[0];

      if (!zohoRecord) {
        await writeLog(catalystApp, {
          integration_id: integration.ROWID,
          dealer_code: integration.dealer_code,
          direction: 'EXTERNAL_CRM_TO_ZOHO',
          operation: 'UPDATE_LEAD',
          external_lead_id: externalLeadId,
          status: 'FAILED',
          error_message: 'FIELD_MAPPING_INVALID',
          request_reference: requestReference,
        });
        throw Object.assign(new Error(`Could not fetch external lead ${externalLeadId} from dealer's Zoho org`), { code: 'FIELD_MAPPING_INVALID' });
      }

      const affectedFields = extractAffectedFieldNames(externalPayload, externalLeadId); 

      const result = await processResolvedInboundLead(
        catalystApp, integration, externalLeadId, zohoRecord,
        fieldMappings, statusMappings, requestReference, zohoCrmService,affectedFields 
      );
      results.push({ externalLeadId, ...result });
    } catch (err) {
      lastError = err;
      results.push({ externalLeadId, ok: false, error: err.code || err.message });
    }
  }

  const anySucceeded = results.some((r) => r.ok);
  if (!anySucceeded && lastError) throw lastError;

  return { ok: true, results };
}

/**
 * Shared tail end of the inbound flow, once a single external lead id
 * and its flat field-value record are in hand — identical for a
 * generic REST dealer CRM (externalRecord = the raw webhook payload)
 * and a Zoho-dealer-CRM lead (externalRecord = the record fetched via
 * getLead()). This is the unchanged body that used to live directly
 * inside processInboundWebhook, from the lead-mapping lookup onward.
 */
async function processResolvedInboundLead(
  catalystApp, integration, externalLeadId, externalRecord,
  fieldMappings, statusMappings, requestReference, zohoCrmService,
  affectedFields = null
) {
  const mappingRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE dealer_code = '${safeQuoteForZcql(integration.dealer_code)}' AND external_crm_lead_id = '${safeQuoteForZcql(externalLeadId)}' LIMIT 1`
  );

  if (mappingRows.length === 0) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: 'LEAD_MAPPING_NOT_FOUND',
      request_reference: requestReference,
    });
    const err = new Error(`No lead mapping found for external lead ${externalLeadId}`);
    err.code = 'LEAD_MAPPING_NOT_FOUND';
    throw err;
  }

  const mapping = mappingRows[0][LEAD_INTEGRATIONS_TABLE];

  const incomingHash = crypto.createHash('sha256').update(JSON.stringify(externalRecord)).digest('hex');
  if (mapping.last_sync_direction === 'ZOHO_TO_EXTERNAL_CRM' && mapping.last_sync_source_hash === incomingHash) {
    return { skipped: true, reason: 'LOOP_PREVENTED' };
  }

  // Snapshot BEFORE update — the only chance to capture "from" values.
  const existingLeadRowsBefore = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
  );
  const existingLeadRow = existingLeadRowsBefore.length > 0 ? existingLeadRowsBefore[0][LEADS_TABLE] : null;

  const internalUpdate = leadMappingService.mapExternalLeadToZoho(externalRecord, fieldMappings);

  const statusFieldMapping = fieldMappings.find((m) => m.source_field === 'lead_status');
  const statusTargetField = statusFieldMapping ? statusFieldMapping.target_field : 'status';
  const incomingStatusValue = externalRecord[statusTargetField];

  const isStatusSync = affectedFields
    ? affectedFields.includes(statusTargetField)
    : Boolean(incomingStatusValue);

  if (isStatusSync) {
    try {
      internalUpdate.lead_status = leadMappingService.mapStatus(incomingStatusValue, statusMappings, 'EXTERNAL_TO_ZOHO');
    } catch (err) {
      logger.error(
        'crmIntegrationService',
        `Unmapped dealer status "${incomingStatusValue}" for dealer ${integration.dealer_code} — add a Status Mapping entry for this value`,
        err
      );
      await writeLog(catalystApp, {
        integration_id: integration.ROWID,
        dealer_code: integration.dealer_code,
        direction: 'EXTERNAL_CRM_TO_ZOHO',
        operation: 'UPDATE_LEAD',
        zoho_lead_id: mapping.zoho_lead_id,
        external_lead_id: externalLeadId,
        status: 'FAILED',
        error_message: err.code || 'STATUS_MAPPING_NOT_FOUND',
        request_reference: requestReference,
      });

      if (Object.keys(internalUpdate).length === 0) {
        return { skipped: true, reason: 'STATUS_MAPPING_NOT_FOUND' };
      }
    }
  } else {
    delete internalUpdate.lead_status;
  }

  if (Object.keys(internalUpdate).length === 0) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      zoho_lead_id: mapping.zoho_lead_id,
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: 'FIELD_MAPPING_INVALID',
      request_reference: requestReference,
    });
    const err = new Error('Webhook payload produced no mapped fields to update');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  // Diff old vs. new for the timeline's detail line.
  const fieldChanges = Object.keys(internalUpdate)
    .map((key) => ({
      field: key,
      from: existingLeadRow ? (existingLeadRow[key] ?? '') : '',
      to: internalUpdate[key] ?? '',
    }))
    .filter((change) => String(change.from) !== String(change.to));

  const zohoApiFields = toZohoApiFields(internalUpdate);

  try {
    await zohoCrmService.updateOemLead(mapping.zoho_lead_id, zohoApiFields);

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
      field_changes: fieldChanges.length > 0 ? JSON.stringify(fieldChanges) : null,
    }, { isStatusSync, leadStatusValue: internalUpdate.lead_status  });

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

  // Single combined key so a plain "Is Unique" column-level constraint
  // (rather than a composite index, which the Catalyst console may not
  // expose) is enough to make the database reject a second concurrent
  // insert for the same event. Falls back to payload_hash when the
  // dealer CRM's webhook doesn't send an event_id.
  const dedupeKey = `${integration.ROWID}:${eventId || payloadHash}`;

  try {
    const inserted = await catalystApp.datastore().table(WEBHOOK_EVENTS_TABLE).insertRow({
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      event_id: eventId || null,
      payload_hash: payloadHash,
      dedupe_key: dedupeKey, // NEW — the column with the unique constraint
      processing_status: 'RECEIVED',
      received_at: toCatalystDateTime(),
    });
    return { isDuplicate: false, eventRowId: inserted.ROWID };
  } catch (err) {
    const message = (err.message || '').toLowerCase();
    const isDuplicateConstraintError =
      message.includes('unique') || message.includes('duplicate') || err.code === 'DUPLICATE_DATA';

    if (isDuplicateConstraintError) {
      logger.info('crmIntegrationService', `Duplicate webhook event detected (dedupe_key=${dedupeKey})`);
      return { isDuplicate: true };
    }

    throw err;
  }
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

async function getLeadActivityTimeline(catalystApp, crmRecordId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE zoho_lead_id = '${safeQuoteForZcql(crmRecordId)}' ORDER BY CREATEDTIME ASC`
  );
  return rows.map((r) => {
    const log = r[INTEGRATION_LOGS_TABLE];
    return { ...log, created_at: log.CREATEDTIME };
  });
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
  getLeadActivityTimeline
};