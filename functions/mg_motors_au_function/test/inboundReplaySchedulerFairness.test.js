'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');

// Covers the per-dealer fairness fix added for the 200+ dealer concurrency
// audit: MAX_REPLAYS_PER_SWEEP was previously a single GLOBAL budget, so a
// dealer with a large backlog of old failed inbound events (oldest-first
// ordering) could consume the entire sweep's budget and starve every other
// dealer that sweep. This builds a fake catalystApp with dealer 1 holding
// far more queued events than the per-dealer cap, interleaved before
// dealer 2's much smaller backlog, and asserts dealer 2 still gets
// processed in the same sweep.

function makeTimestamp(offsetSeconds) {
  const base = new Date('2026-01-01T00:00:00+05:30').getTime();
  const d = new Date(base + offsetSeconds * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildFakeCatalystApp({ dealer1Count, dealer2Count }) {
  const logRows = [];
  let seq = 0;

  for (let i = 0; i < dealer1Count; i += 1) {
    logRows.push({
      ROWID: String(1000 + seq),
      integration_id: '1',
      external_lead_id: `D1-LEAD-${i}`,
      happy_unhappy_path_name: 'Unhappy 4',
      status: 'FAILED',
      error_message: 'EXTERNAL_CRM_UNREACHABLE',
      CREATEDTIME: makeTimestamp(seq),
      MODIFIEDTIME: '',
    });
    seq += 1;
  }
  for (let i = 0; i < dealer2Count; i += 1) {
    logRows.push({
      ROWID: String(1000 + seq),
      integration_id: '2',
      external_lead_id: `D2-LEAD-${i}`,
      happy_unhappy_path_name: 'Unhappy 4',
      status: 'FAILED',
      error_message: 'EXTERNAL_CRM_UNREACHABLE',
      CREATEDTIME: makeTimestamp(seq),
      MODIFIEDTIME: '',
    });
    seq += 1;
  }

  const integrations = {
    '1': { ROWID: '1', dealer_code: 'AU001' },
    '2': { ROWID: '2', dealer_code: 'AU002' },
  };
  const mappingsByKey = new Map();
  for (const row of logRows) {
    mappingsByKey.set(`${row.integration_id}:${row.external_lead_id}`, {
      ROWID: `map-${row.integration_id}-${row.external_lead_id}`,
      last_error: '',
      MODIFIEDTIME: '',
    });
  }

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM integration_logs')) {
          return logRows.map((row) => ({ integration_logs: row }));
        }
        if (sql.includes('FROM dealer_integrations')) {
          const match = /ROWID = (\d+)/.exec(sql);
          const integration = match ? integrations[match[1]] : null;
          return integration ? [{ dealer_integrations: integration }] : [];
        }
        if (sql.includes('FROM lead_integrations')) {
          const match = /integration_id = (\d+) AND external_crm_lead_id = '([^']+)'/.exec(sql);
          if (!match) return [];
          const mapping = mappingsByKey.get(`${match[1]}:${match[2]}`);
          return mapping ? [{ lead_integrations: mapping }] : [];
        }
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: () => ({
        updateRow: async () => ({}),
      }),
    }),
  };
}

test('inboundReplayScheduler: a dealer with a huge backlog cannot starve another dealer in the same sweep', async (t) => {
  _resetForTests();
  delete require.cache[require.resolve('../services/integrations/inboundReplayScheduler')];
  const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');

  const attemptedByDealer = new Map();
  t.mock.method(crmIntegrationService, 'replayInboundLead', async (_app, integration) => {
    attemptedByDealer.set(integration.ROWID, (attemptedByDealer.get(integration.ROWID) || 0) + 1);
    return { ok: true };
  });

  const catalystApp = buildFakeCatalystApp({ dealer1Count: 25, dealer2Count: 3 });
  const results = await inboundReplayScheduler.runInboundReplaySweep(catalystApp);

  assert.equal(attemptedByDealer.get('1'), 5, 'dealer 1 should be capped at the per-dealer budget despite its huge backlog');
  assert.equal(attemptedByDealer.get('2'), 3, 'dealer 2 must still be fully processed in the same sweep, not starved');
  assert.equal(results.attempted, 8);
  assert.equal(results.recovered, 8);
  assert.equal(results.dealerBudgetExhausted, 20, 'the remaining 20 of dealer 1\'s 25 events are deferred, not lost');
});
