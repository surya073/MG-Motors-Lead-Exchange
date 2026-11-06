'use strict';

/**
 * dealerPushQueueService.js
 * -----------------------------------------------------------------------
 * The per-dealer "push leads" switch (dealer_integrations.push_enabled and
 * push_from_at; see crmIntegrationService.newLeadSkipReason).
 *
 * While the switch is off, new leads for the dealer are skipped quietly: they
 * stay in MG as PENDING with no lead_integrations row. Those are the "queued"
 * leads: created at or after the dealer's push floor (its connect time, or the
 * last resume that skipped the queue), still PENDING, and never given a mapping
 * row (a lead that was held, failed or linked as a duplicate has one or a
 * different state, and is left to its own flow).
 *
 * Turning the switch on takes one decision about the queue:
 *   push  - the queued leads are sent now, then new leads continue;
 *   skip  - push_from_at is set to now, so only leads created from now go out.
 */

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const dashboardStats = require('../dashboardStatsService');
const crmIntegrationService = require('./crmIntegrationService');

const LEADS_TABLE = 'leads';
const MAPPING_TABLE = 'lead_integrations';
const QUEUE_BOUND = 1000;
const PUSH_BATCH_LIMIT = 200;

function quote(value) {
  return String(value).replace(/'/g, "''");
}

/** @returns {Promise<Array>} the queued lead rows, oldest first. */
async function listQueuedLeads(catalystApp, integration) {
  const where = [`dealer_code = '${quote(integration.dealer_code)}'`, `sync_status = 'PENDING'`];
  const floor = crmIntegrationService.dealerPushFloor(integration);
  if (floor) where.push(`assigned_date >= '${toCatalystDateTime(floor)}'`);
  const leads = await dashboardStats.selectEveryRow(
    catalystApp, LEADS_TABLE, `WHERE ${where.join(' AND ')}`, 'ORDER BY assigned_date ASC', QUEUE_BOUND
  );
  if (leads.length === 0) return [];
  const mappings = await dashboardStats.selectEveryRow(
    catalystApp, MAPPING_TABLE, `WHERE integration_id = ${integration.ROWID}`, 'ORDER BY ROWID ASC', QUEUE_BOUND * 5
  );
  const mapped = new Set(mappings.map((row) => String(row.zoho_lead_id)));
  return leads.filter((lead) => lead.crm_record_id && !mapped.has(String(lead.crm_record_id)));
}

function queuedSummary(leads) {
  return {
    count: leads.length,
    oldest_created_at: leads[0]?.assigned_date || null,
    sample: leads.slice(0, 5).map((lead) => ({
      crm_record_id: lead.crm_record_id,
      customer_name: lead.customer_name || '',
      created_at: lead.assigned_date || null,
    })),
  };
}

async function writeIntegration(catalystApp, integration, fields) {
  await catalystApp.datastore().table('dealer_integrations').updateRow({ ROWID: integration.ROWID, ...fields });
  Object.assign(integration, fields);
}

/** Switch off: new leads for this dealer stop going out. Nothing else changes. */
async function pausePush(catalystApp, integration) {
  await writeIntegration(catalystApp, integration, { push_enabled: false });
  return { push_enabled: false };
}

/**
 * Switch on. `queued` says what to do with the leads that built up while it was off
 * ('push' or 'skip'); it is required when there are any.
 */
async function resumePush(catalystApp, integration, { queued } = {}) {
  const waiting = await listQueuedLeads(catalystApp, integration);
  if (waiting.length > 0 && queued !== 'push' && queued !== 'skip') {
    const err = new Error(`${waiting.length} leads are queued; choose to push them or skip them`);
    err.code = 'QUEUE_DECISION_REQUIRED';
    err.queued = queuedSummary(waiting);
    throw err;
  }

  if (queued === 'skip' && waiting.length > 0) {
    await writeIntegration(catalystApp, integration, { push_enabled: true, push_from_at: toCatalystDateTime() });
    return { push_enabled: true, queued: waiting.length, skipped: waiting.length, pushed: 0, failed: 0, remaining: 0 };
  }

  await writeIntegration(catalystApp, integration, { push_enabled: true });
  if (waiting.length === 0) return { push_enabled: true, queued: 0, skipped: 0, pushed: 0, failed: 0, remaining: 0 };

  const batch = waiting.slice(0, PUSH_BATCH_LIMIT);
  let pushed = 0;
  let failed = 0;
  for (const lead of batch) {
    try {
      const result = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, lead);
      if (result?.skipped) failed += 1; else pushed += 1;
    } catch (err) {
      failed += 1;
      logger.error('dealerPushQueueService', `Queued lead ${lead.crm_record_id} could not be pushed for dealer ${integration.dealer_code}`, err);
    }
  }
  return { push_enabled: true, queued: waiting.length, skipped: 0, pushed, failed, remaining: waiting.length - batch.length };
}

module.exports = { listQueuedLeads, queuedSummary, pausePush, resumePush, PUSH_BATCH_LIMIT };
