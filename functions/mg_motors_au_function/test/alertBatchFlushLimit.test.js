'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');
const integrationAlertService = require('../services/integrations/integrationAlertService');

// The timed digest asked for LIMIT 0, 500. Catalyst refuses any LIMIT above
// 300 ("ZCQL CANNOT HAVE MORE THAN 300 ROWS in LIMIT", confirmed against the
// live project on 13 Oct 2026), so the digest never went out on its timer.
test('the timed alert digest reads within the 300-row ZCQL limit and leaves the rest queued', async (t) => {
  const old = '2000-01-01 00:00:00:000';
  const db = createInMemoryZcql({
    outbound_sync_claims: [],
    integration_alert_queue: Array.from({ length: 350 }, (_, i) => ({
      CREATEDTIME: old, scenario_code: 'Unhappy 1', dealer_code: 'D1', lead_id: `l${i}`, reason: 'x', priority_for: 'P2',
    })),
  });
  const send = t.mock.method(integrationAlertService, 'sendConfiguredEmail', async () => ({ sent: true }));

  const result = await integrationAlertBatchService.flushIfWindowElapsed(db.app);

  assert.equal(result.sent, true);
  assert.equal(result.count, 300);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(
    db.tables.integration_alert_queue.filter((row) => !row.__deleted).length,
    50,
    'the rest waits for the next flush'
  );
});
