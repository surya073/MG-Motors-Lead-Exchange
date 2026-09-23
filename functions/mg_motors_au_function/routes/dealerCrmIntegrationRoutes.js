'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const logger = require('../utils/logger');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const { requireAdminRole } = require('../middleware/requireAdminRole');
const oemPicklistService = require('../services/oemPicklistService');

const crypto = require('crypto');

const router = express.Router();
const LEADS_TABLE = 'leads';

function safeConfig(integration) {
  if (!integration) return null;
  const { ROWID, dealer_code, integration_type, crm_type, crm_name, base_url, auth_type,
    create_lead_endpoint, update_lead_endpoint, http_method, update_http_method,
     oauth_accounts_domain, webhook_enabled, webhook_id_field, outbound_enabled, inbound_enabled,
    status, last_tested_at, last_sync_at } = integration;
  return { ROWID, dealer_code, integration_type, crm_type, crm_name, base_url, auth_type,
    create_lead_endpoint, update_lead_endpoint, http_method, update_http_method,
    oauth_accounts_domain, webhook_enabled, webhook_id_field, outbound_enabled, inbound_enabled,
    status, last_tested_at, last_sync_at };
}

const { registerDealerWatchChannel } = require('../services/zohoWebhookService');

router.post('/admin/dealers/:dealerCode/register-webhook', async (req, res) => {
  try {
    const catalystApp = catalyst.initialize(req);
    const { dealerCode } = req.params;

    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration) {
      return res.status(404).json({ error: 'INTEGRATION_NOT_FOUND' });
    }

    const result = await registerDealerWatchChannel(catalystApp, integration);
    res.status(200).json({ ok: true, result });
  } catch (err) {
    logger.error('webhookRoutes', 'Manual watch registration failed', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:dealerCode/integration', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  try {
    const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
    if (!dealer) return res.status(404).json({ error: 'DEALER_NOT_FOUND' });
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration) return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    let hasCredential;
    if (integration.crm_type === 'ZOHO_CRM') {
      const [hasClientId, hasClientSecret, hasRefreshToken] = await Promise.all([
        integrationAuthService.hasCredential(catalystApp, integration.ROWID, 'OAUTH2_CLIENT_ID'),
        integrationAuthService.hasCredential(catalystApp, integration.ROWID, 'OAUTH2_CLIENT_SECRET'),
        integrationAuthService.hasCredential(catalystApp, integration.ROWID, 'OAUTH2_REFRESH_TOKEN'),
      ]);
      hasCredential = hasClientId && hasClientSecret && hasRefreshToken;
    } else {
      const credType = integrationAuthService.AUTH_TYPE_TO_CREDENTIAL_TYPE[integration.auth_type];
      hasCredential = credType ? await integrationAuthService.hasCredential(catalystApp, integration.ROWID, credType) : false;
    }
    res.json({ integration: safeConfig(integration), hasCredential });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `GET integration failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.put('/:dealerCode/integration', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  const body = req.body || {};
  try {
    const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
    if (!dealer) return res.status(404).json({ error: 'DEALER_NOT_FOUND' });
    if (!['PORTAL', 'EXTERNAL_CRM'].includes(body.integration_type)) {
      return res.status(400).json({ error: 'INVALID_CRM_CONFIGURATION' });
    }
    const isZohoCrm = body.crm_type === 'ZOHO_CRM';
    if (isZohoCrm && body.integration_type === 'EXTERNAL_CRM' && !body.oauth_accounts_domain) {
      return res.status(400).json({ error: 'INVALID_CRM_CONFIGURATION' });
    }
    const table = catalystApp.datastore().table('dealer_integrations');
    let integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    const fields = {
      dealer_code: dealerCode,
      integration_type: body.integration_type,
      crm_type: body.crm_type || 'GENERIC_REST',
      crm_name: body.crm_name || null,
      base_url: body.base_url || null,
      auth_type: isZohoCrm ? null : (body.auth_type || null),
      create_lead_endpoint: body.create_lead_endpoint || null,
      update_lead_endpoint: body.update_lead_endpoint || null,
      http_method: body.http_method || 'POST',
      update_http_method: body.update_http_method || 'PUT',
      oauth_accounts_domain: isZohoCrm ? (body.oauth_accounts_domain || null) : null,
      webhook_enabled: Boolean(body.webhook_enabled),
      webhook_id_field: body.webhook_id_field || 'id',
      outbound_enabled: true,
      inbound_enabled: true,
      status: (integration?.status === 'ACTIVE' || integration?.status === 'CONNECTED') ? 'CONFIGURING' : 'NOT_CONFIGURED',
    };
    if (integration) {
      await table.updateRow({ ROWID: integration.ROWID, ...fields });
    } else {
      integration = await table.insertRow(fields);
    }
    if (isZohoCrm) {
      const credentialWrites = [
        ['oauth_client_id', 'OAUTH2_CLIENT_ID'],
        ['oauth_client_secret', 'OAUTH2_CLIENT_SECRET'],
        ['oauth_refresh_token', 'OAUTH2_REFRESH_TOKEN'],
      ];
      await Promise.all(
        credentialWrites
          .filter(([bodyKey]) => body[bodyKey])
          .map(([bodyKey, credType]) =>
            integrationAuthService.saveCredential(catalystApp, integration.ROWID, credType, body[bodyKey])
          )
      );
    } else if (body.credential && body.auth_type) {
      const credType = integrationAuthService.AUTH_TYPE_TO_CREDENTIAL_TYPE[body.auth_type];
      if (credType) {
        await integrationAuthService.saveCredential(catalystApp, integration.ROWID, credType, body.credential);
      }
    }
    res.json({ integration: safeConfig({ ...integration, ...fields }) });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `PUT integration failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/:dealerCode/integration/test', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  try {
    const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
    if (!dealer) return res.status(404).json({ error: 'DEALER_NOT_FOUND' });
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration || integration.integration_type !== 'EXTERNAL_CRM') {
      return res.status(400).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    }
    const result = await crmIntegrationService.testConnection(catalystApp, integration);
    if (!result.ok) {
      return res.status(502).json({ error: 'EXTERNAL_CRM_ERROR', httpStatus: result.httpStatus });
    }
    res.json(result);
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `Test connection failed for ${dealerCode}`, err);
    const status = err.code === 'INVALID_CRM_CONFIGURATION' ? 400 : 500;
    res.status(status).json({ error: err.code || 'INTERNAL_ERROR' });
  }
});

router.get('/:dealerCode/integration/mappings', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  try {
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration) return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    const [fieldMappings, statusMappingsRaw] = await Promise.all([
      crmIntegrationService.getFieldMappings(catalystApp, integration.ROWID),
      crmIntegrationService.getStatusMappings(catalystApp, integration.ROWID),
    ]);
    const statusMappings = statusMappingsRaw.filter((m) => m.direction === 'ZOHO_TO_EXTERNAL');
    res.json({ fieldMappings, statusMappings });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `GET mappings failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.put('/:dealerCode/integration/mappings', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  const { fieldMappings = [], statusMappings = [] } = req.body || {};
  try {
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration) return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    const validFieldMappings = fieldMappings.filter((m) => m.source_field && m.target_field);
    if (validFieldMappings.length === 0) {
      return res.status(400).json({ error: 'FIELD_MAPPING_INVALID' });
    }
    const fieldTable = catalystApp.datastore().table('integration_field_mappings');
    const existingFieldRowsRaw = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM integration_field_mappings WHERE integration_id = ${integration.ROWID}`
    );
    const existingFieldRows = existingFieldRowsRaw.map((r) => r.integration_field_mappings);
    const incomingRowIds = new Set(validFieldMappings.filter((m) => m.ROWID).map((m) => String(m.ROWID)));
    const rowsToDelete = existingFieldRows.filter((r) => !incomingRowIds.has(String(r.ROWID)));
    const rowsToInsert = validFieldMappings.filter((m) => !m.ROWID);
    const existingById = new Map(existingFieldRows.map((r) => [String(r.ROWID), r]));
    const rowsToUpdate = validFieldMappings.filter((m) => {
      if (!m.ROWID) return false;
      const existing = existingById.get(String(m.ROWID));
      if (!existing) return false;
      return (
        existing.source_field !== m.source_field ||
        existing.target_field !== m.target_field ||
        existing.data_type !== (m.data_type || 'string') ||
        Boolean(existing.required) !== Boolean(m.required)
      );
    });
    for (const r of rowsToDelete) {
      await fieldTable.deleteRow(r.ROWID);
    }
    for (const m of rowsToInsert) {
      try {
        await fieldTable.insertRow({
          integration_id: integration.ROWID,
          source_field: m.source_field,
          target_field: m.target_field,
          data_type: m.data_type || 'string',
          required: Boolean(m.required),
        });
      } catch (rowErr) {
        logger.error('dealerCrmIntegrationRoutes', `Field mapping insert failed for ${dealerCode}: ${JSON.stringify(m)}`, rowErr);
        throw rowErr;
      }
    }
    for (const m of rowsToUpdate) {
      await fieldTable.updateRow({
        ROWID: m.ROWID,
        source_field: m.source_field,
        target_field: m.target_field,
        data_type: m.data_type || 'string',
        required: Boolean(m.required),
      });
    }
    const statusTable = catalystApp.datastore().table('integration_status_mappings');
    const existingStatusRowsRaw = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM integration_status_mappings WHERE integration_id = ${integration.ROWID}`
    );
    const existingStatusRows = existingStatusRowsRaw.map((r) => r.integration_status_mappings);
    const validStatusMappings = statusMappings.filter((m) => m.source_status && m.target_status);
    const existingPairsByRowId = new Map(
      existingStatusRows
        .filter((r) => r.direction === 'ZOHO_TO_EXTERNAL')
        .map((r) => [String(r.ROWID), r])
    );
    const incomingPairRowIds = new Set(validStatusMappings.filter((m) => m.ROWID).map((m) => String(m.ROWID)));
    for (const [rowId, forwardRow] of existingPairsByRowId) {
      if (!incomingPairRowIds.has(rowId)) {
        const reverseRow = existingStatusRows.find(
          (r) => r.direction === 'EXTERNAL_TO_ZOHO' && r.source_status === forwardRow.target_status && r.target_status === forwardRow.source_status
        );
        await statusTable.deleteRow(forwardRow.ROWID);
        if (reverseRow) await statusTable.deleteRow(reverseRow.ROWID);
      }
    }
    const newPairs = validStatusMappings.filter((m) => !m.ROWID);
    for (const m of newPairs) {
      try {
        await statusTable.insertRow({
          integration_id: integration.ROWID,
          source_status: m.source_status,
          target_status: m.target_status,
          direction: 'ZOHO_TO_EXTERNAL',
        });
        await statusTable.insertRow({
          integration_id: integration.ROWID,
          source_status: m.target_status,
          target_status: m.source_status,
          direction: 'EXTERNAL_TO_ZOHO',
        });
      } catch (rowErr) {
        logger.error('dealerCrmIntegrationRoutes', `Status mapping insert failed for ${dealerCode}: ${JSON.stringify(m)}`, rowErr);
        throw rowErr;
      }
    }
    const editedPairs = validStatusMappings.filter((m) => {
      if (!m.ROWID) return false;
      const existing = existingPairsByRowId.get(String(m.ROWID));
      if (!existing) return false;
      return existing.source_status !== m.source_status || existing.target_status !== m.target_status;
    });
    for (const m of editedPairs) {
      const forwardRow = existingPairsByRowId.get(String(m.ROWID));
      const reverseRow = existingStatusRows.find(
        (r) => r.direction === 'EXTERNAL_TO_ZOHO' && r.source_status === forwardRow.target_status && r.target_status === forwardRow.source_status
      );
      await statusTable.updateRow({ ROWID: forwardRow.ROWID, source_status: m.source_status, target_status: m.target_status });
      if (reverseRow) {
        await statusTable.updateRow({ ROWID: reverseRow.ROWID, source_status: m.target_status, target_status: m.source_status });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `PUT mappings failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/:dealerCode/integration/logs', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM integration_logs WHERE dealer_code = '${dealerCode}' ORDER BY CREATEDTIME DESC LIMIT 0, ${limit}`
    );
    res.json({
      logs: rows.map((r) => {
        const log = r.integration_logs;
        return { ...log, created_at: log.CREATEDTIME }; 
      }),
    });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `GET logs failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/:dealerCode/integration/sync', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  const { crmRecordId } = req.body || {};
  try {
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration) return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    if (integration.status === 'DISABLED') return res.status(400).json({ error: 'INTEGRATION_DISABLED' });
    if (!crmRecordId) return res.status(400).json({ error: 'INVALID_CRM_CONFIGURATION' });
    const leadRows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${crmRecordId}' AND dealer_code = '${dealerCode}' LIMIT 1`
    );
    if (leadRows.length === 0) {
      return res.status(404).json({ error: 'LEAD_MAPPING_NOT_FOUND' });
    }
    const leadRow = leadRows[0][LEADS_TABLE];
    const result = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
    res.json({ ok: true, result });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `Retry sync failed for ${dealerCode}`, err);
    res.status(500).json({ error: err.code || 'INTERNAL_ERROR' });
  }
});

router.post('/:dealerCode/integration/webhook-secret', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  try {
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration) return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    const secret = crypto.randomBytes(32).toString('hex');
    await integrationAuthService.saveCredential(catalystApp, integration.ROWID, 'WEBHOOK_SECRET', secret);
    res.json({ webhookSecret: secret });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', `Webhook secret generation failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/oem-crm/status-picklist/refresh', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  try {
    const result = await oemPicklistService.refreshStatusPicklist(catalystApp, 'Lead_Status');
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', 'Status picklist refresh failed', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/oem-crm/status-picklist', requireAdminRole, async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  try {
    const values = await oemPicklistService.getCachedStatusPicklist(catalystApp, 'Lead_Status');
    res.json({ values });
  } catch (err) {
    logger.error('dealerCrmIntegrationRoutes', 'Status picklist read failed', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/leads/:crmRecordId/timeline', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { crmRecordId } = req.params;
  try {
    const timeline = await crmIntegrationService.getLeadActivityTimeline(catalystApp, crmRecordId);
    res.json({ timeline });
  } catch (err) {
    logger.error('leadRoutes', `GET timeline failed for ${crmRecordId}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;