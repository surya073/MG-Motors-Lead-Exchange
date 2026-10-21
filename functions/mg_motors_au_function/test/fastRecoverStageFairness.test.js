'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = `test-${key}`;
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = 'https://accounts.zoho.in';
process.env.CRON_SECRET = 'test-fairness-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalyst = require('zcatalyst-sdk-node');
const routes = require('../routes/cronRoutes');
const outbound = require('../services/integrations/outboundRetryScheduler');
const inbound = require('../services/integrations/inboundReplayScheduler');
const sla = require('../services/integrations/slaMonitorService');
const alerts = require('../services/integrations/integrationAlertBatchService');
const reconciliation = require('../services/integrations/dealerReconciliationService');
const retention = require('../services/integrations/webhookEventRetention');

test('successive two-minute slots give every stage first budget use without extending a spent request', async (t) => {
  const base = Date.parse('2026-10-14T12:02:00Z');
  let now = base;
  const completed = [];
  const deadlines = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(catalyst, 'initialize', () => ({}));
  t.mock.method(retention, 'isRetentionDue', () => false);
  t.mock.method(reconciliation, 'runDealerReconciliation', async () => ({}));
  const stage = (name, options) => {
    deadlines.push(options.deadline);
    if (now >= options.deadline) return { skipped: true, reason: 'WORK_BUDGET_EXHAUSTED' };
    completed.push(name);
    now += 30000; // one slow stage consumes even the whole global allowance
    return { recovered: 0 };
  };
  t.mock.method(outbound, 'runOutboundRetrySweep', async (_app, options) => stage('outbound', options));
  t.mock.method(inbound, 'runInboundReplaySweep', async (_app, options) => stage('inbound', options));
  t.mock.method(sla, 'runSlaSweep', async (_app, _date, options) => stage('sla', options));
  t.mock.method(alerts, 'flushIfWindowElapsed', async (_app, options) => stage('alerts', options));
  const layer = routes.stack.find((item) => item.route?.path === '/cron/fast-recover');
  const handler = layer.route.stack.at(-1).handle;
  for (let run = 0; run < 4; run += 1) {
    now = base + run * 120000;
    const startedAt = now;
    const result = { status: null, body: null };
    const response = {
      status(value) { result.status = value; return this; },
      json(value) { result.body = value; return this; },
    };
    await handler({ headers: { 'x-cron-secret': process.env.CRON_SECRET } }, response);
    assert.equal(result.status, 200);
    assert.ok(deadlines.splice(0).every((deadline) => deadline === startedAt + 25000), 'all stages keep the original deadline');
  }
  assert.deepEqual([...completed].sort(), ['alerts', 'inbound', 'outbound', 'sla']);
});
