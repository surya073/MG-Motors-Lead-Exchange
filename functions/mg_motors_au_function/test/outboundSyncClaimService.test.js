'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withOutboundSyncClaim, _test } = require('../services/integrations/outboundSyncClaimService');

// Covers the cross-instance duplicate-lead-creation fix: acquiring a claim
// is backed by Table.insertRow() against a column with a Catalyst
// Console-configured UNIQUE constraint (claim_key) — the one atomic
// primitive this platform actually exposes (confirmed from the installed
// zcatalyst-sdk-node type definitions: ZCQL is SELECT-only and
// Table.updateRow() has no WHERE/version condition).
//
// This fake catalystApp simulates that unique constraint faithfully: two
// concurrent insertRow() calls with the same claim_key, the second one
// throws, exactly as the real Data Store would. Node's single-threaded
// execution means this fake's synchronous check-and-set body cannot
// actually interleave mid-call, so it is a trustworthy stand-in for
// testing OUR race-handling logic (it does not, and cannot, prove
// Catalyst's own server-side guarantee — that still needs to be verified
// against the real Catalyst Console table once created, per the
// deployment report).

function buildFakeCatalystAppForClaims() {
  const rowsById = new Map();
  const rowIdByClaimKey = new Map();
  let nextId = 1;

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        const match = /claim_key = '([^']*)'/.exec(sql);
        if (!match) throw new Error(`Unexpected ZCQL query in test: ${sql}`);
        const rowId = rowIdByClaimKey.get(match[1]);
        if (!rowId) return [];
        return [{ outbound_sync_claims: rowsById.get(rowId) }];
      },
    }),
    datastore: () => ({
      table: () => ({
        insertRow: async (fields) => {
          if (rowIdByClaimKey.has(fields.claim_key)) {
            const err = new Error(`Duplicate value for unique column 'claim_key'`);
            err.code = 'datastore/DuplicateData';
            throw err;
          }
          const ROWID = String(nextId++);
          const row = { ROWID, ...fields };
          rowsById.set(ROWID, row);
          rowIdByClaimKey.set(fields.claim_key, ROWID);
          return row;
        },
        deleteRow: async (rowId) => {
          const row = rowsById.get(String(rowId));
          if (row) {
            rowIdByClaimKey.delete(row.claim_key);
            rowsById.delete(String(rowId));
          }
          return true;
        },
      }),
    }),
    _rowIdByClaimKey: rowIdByClaimKey,
  };
}

test('withOutboundSyncClaim: fn runs when no competing claim exists', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();
  let fnCalled = false;

  const result = await withOutboundSyncClaim(catalystApp, '1', 'LEAD-1', 'req-1', async () => {
    fnCalled = true;
    return { ok: true };
  });

  assert.equal(fnCalled, true);
  assert.deepEqual(result, { ok: true });
});

test('withOutboundSyncClaim: the claim is released after fn completes, freeing the next attempt (retry scenario)', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();

  await withOutboundSyncClaim(catalystApp, '1', 'LEAD-1', 'req-1', async () => 'first');
  assert.equal(catalystApp._rowIdByClaimKey.size, 0, 'claim must be released once the attempt finishes');

  let secondRan = false;
  const result = await withOutboundSyncClaim(catalystApp, '1', 'LEAD-1', 'req-2', async () => {
    secondRan = true;
    return 'second';
  });

  assert.equal(secondRan, true, 'a later, independent attempt for the same lead must be allowed to run');
  assert.equal(result, 'second');
});

test('withOutboundSyncClaim: the claim is released even when fn throws (a real delivery failure, not a timeout)', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();

  await assert.rejects(
    () => withOutboundSyncClaim(catalystApp, '1', 'LEAD-1', 'req-1', async () => {
      throw new Error('dealer CRM rejected the lead');
    }),
    /dealer CRM rejected the lead/
  );

  assert.equal(catalystApp._rowIdByClaimKey.size, 0, 'a failed attempt must still release its claim so a retry can proceed');
});

test('withOutboundSyncClaim: N simultaneous attempts for the SAME lead — exactly one runs fn, the rest are skipped', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();
  let executions = 0;

  const attempts = Array.from({ length: 10 }, (_, i) =>
    withOutboundSyncClaim(catalystApp, '42', 'LEAD-RACE', `req-${i}`, async () => {
      executions += 1;
      // Simulates a slow remote CRM call (the exact window the original
      // race exploited) — every other concurrent attempt must stay
      // blocked for its whole duration, not just at the instant of
      // acquisition.
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { ok: true, externalLeadId: 'EXT-WINNER' };
    })
  );

  const results = await Promise.all(attempts);

  assert.equal(executions, 1, 'only one of ten simultaneous requests for the same lead may reach the dealer CRM call');
  const winners = results.filter((r) => r.ok);
  const skipped = results.filter((r) => r.skipped);
  assert.equal(winners.length, 1);
  assert.equal(skipped.length, 9);
  skipped.forEach((r) => assert.equal(r.reason, 'CONCURRENT_SYNC_IN_PROGRESS'));
});

test('withOutboundSyncClaim: different leads never block each other', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();

  const [a, b] = await Promise.all([
    withOutboundSyncClaim(catalystApp, '1', 'LEAD-A', 'req-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'a-done';
    }),
    withOutboundSyncClaim(catalystApp, '1', 'LEAD-B', 'req-b', async () => 'b-done'),
  ]);

  assert.equal(a, 'a-done');
  assert.equal(b, 'b-done');
});

test('withOutboundSyncClaim: a crashed/abandoned claim past the TTL is reclaimed, not a permanent block', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();
  const claimKey = _test.buildClaimKey('1', 'LEAD-STALE');

  // Simulate a previous attempt that acquired the claim and then crashed
  // before its `finally` could release it — insert directly, bypassing
  // withOutboundSyncClaim, with a claimed_at far in the past.
  const staleClaimedAt = new Date(Date.now() - (_test.CLAIM_TTL_MINUTES + 1) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const staleTimestamp = `${staleClaimedAt.getUTCFullYear()}-${pad(staleClaimedAt.getUTCMonth() + 1)}-${pad(staleClaimedAt.getUTCDate())} ${pad(staleClaimedAt.getUTCHours())}:${pad(staleClaimedAt.getUTCMinutes())}:${pad(staleClaimedAt.getUTCSeconds())}`;
  await catalystApp.datastore().table(_test.CLAIMS_TABLE).insertRow({
    claim_key: claimKey,
    claimed_at: staleTimestamp,
    request_reference: 'crashed-attempt',
  });

  let ran = false;
  const result = await withOutboundSyncClaim(catalystApp, '1', 'LEAD-STALE', 'req-new', async () => {
    ran = true;
    return 'reclaimed';
  });

  assert.equal(ran, true, 'a stale claim from a crashed instance must not permanently block future attempts');
  assert.equal(result, 'reclaimed');
});

test('withOutboundSyncClaim: fails OPEN (runs fn, does not throw) when the claims table itself is missing/broken', async () => {
  // Simulates the exact state of a fresh deployment before the
  // outbound_sync_claims table has been created in Catalyst Console:
  // insertRow AND the SELECT fallback both fail, since the table does
  // not exist. Breaking outbound sync entirely over this would be worse
  // than the race the claim exists to close.
  const brokenCatalystApp = {
    zcql: () => ({
      executeZCQLQuery: async () => {
        throw new Error('Table outbound_sync_claims does not exist');
      },
    }),
    datastore: () => ({
      table: () => ({
        insertRow: async () => {
          throw new Error('Table outbound_sync_claims does not exist');
        },
      }),
    }),
  };

  let ran = false;
  const result = await withOutboundSyncClaim(brokenCatalystApp, '1', 'LEAD-1', 'req-1', async () => {
    ran = true;
    return { ok: true };
  });

  assert.equal(ran, true, 'fn must still run — a missing claims table must never block real outbound sync');
  assert.deepEqual(result, { ok: true });
});

test('withOutboundSyncClaim: a FRESH competing claim (not stale) is respected, never reclaimed early', async () => {
  const catalystApp = buildFakeCatalystAppForClaims();
  const claimKey = _test.buildClaimKey('1', 'LEAD-FRESH');

  await catalystApp.datastore().table(_test.CLAIMS_TABLE).insertRow({
    claim_key: claimKey,
    claimed_at: require('../utils/dateFormat').toCatalystDateTime(),
    request_reference: 'genuinely-in-progress',
  });

  const result = await withOutboundSyncClaim(catalystApp, '1', 'LEAD-FRESH', 'req-new', async () => 'should-not-run');

  assert.deepEqual(result, { skipped: true, reason: 'CONCURRENT_SYNC_IN_PROGRESS' });
});
