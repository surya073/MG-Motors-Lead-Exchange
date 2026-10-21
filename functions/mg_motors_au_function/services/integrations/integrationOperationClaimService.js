'use strict';

const crypto = require('node:crypto');
const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const pathPolicy = require('./pathPolicyService');

// Reuses the existing UNIQUE claim_key table. Operational claims always fail
// closed; the outbound sync's legacy fail-open switch does not apply here.
const TABLE = 'outbound_sync_claims';
const LEASE_MS = 5 * 60 * 1000;
const MAX_RECEIPT_ROWS = 300;
const MAX_REFERENCE_LENGTH = 10000;

const quote = (value) => String(value).replace(/'/g, "''");
const keyFor = (operation) => `operation:${operation}`;

function parseReference(value) {
  try {
    const reference = JSON.parse(String(value || ''));
    if (reference && reference.version === 1 && typeof reference.owner === 'string') return reference;
  } catch (_) { /* A stale legacy/unfinished claim has no durable receipt. */ }
  return null;
}

function validReceipt(receipt) {
  return receipt && Array.isArray(receipt.rowIds) && receipt.rowIds.length > 0
    && receipt.rowIds.length <= MAX_RECEIPT_ROWS
    && receipt.rowIds.every((id) => /^\d{1,30}$/.test(String(id)));
}

function stale(row) {
  const at = pathPolicy.parseTimestamp(row.claimed_at);
  return !at || Date.now() - at.getTime() >= LEASE_MS;
}

async function find(catalystApp, key) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${TABLE} WHERE claim_key = '${quote(key)}' LIMIT 1`
  );
  return rows[0]?.[TABLE] || null;
}

async function acquire(catalystApp, operation) {
  const key = keyFor(operation);
  const owner = crypto.randomUUID();
  const table = catalystApp.datastore().table(TABLE);
  const reference = { version: 1, owner, phase: 'RUNNING' };
  const fields = () => ({
    claim_key: key,
    claimed_at: toCatalystDateTime(),
    request_reference: JSON.stringify(reference),
  });
  try {
    return { row: await table.insertRow(fields()), reference };
  } catch (insertError) {
    const existing = await find(catalystApp, key);
    if (!existing) throw insertError;
    if (!stale(existing)) return null;

    // Delete the specific old ROWID, never a newly acquired owner's row.
    // The unique insert chooses one winner if multiple workers recover it.
    await table.deleteRow(existing.ROWID);
    try {
      return { row: await table.insertRow(fields()), reference };
    } catch (reclaimError) {
      if (await find(catalystApp, key)) return null;
      throw reclaimError;
    }
  }
}

async function withOperationClaim(catalystApp, operation, fn) {
  let acquired;
  try {
    acquired = await acquire(catalystApp, operation);
  } catch (error) {
    logger.error('integrationOperationClaimService', `Cannot acquire ${operation}; operation deferred`, error);
    return { skipped: true, reason: 'OPERATION_CLAIM_UNAVAILABLE' };
  }
  if (!acquired) return { skipped: true, reason: 'OPERATION_ALREADY_RUNNING' };

  const { row, reference } = acquired;
  let retain = false;
  const table = catalystApp.datastore().table(TABLE);
  const receiptPrefix = `${keyFor(operation)}:receipt:`;
  const decodeReceipt = (receiptRow) => {
    const saved = parseReference(receiptRow.request_reference);
    if (saved?.phase !== 'SENT' || !validReceipt(saved.receipt)) {
      throw new Error('Operational claim has an invalid sent-batch receipt; manual review required');
    }
    return { ROWID: receiptRow.ROWID, reference: saved, ...saved.receipt };
  };
  const lease = {
    retain: () => { retain = true; },
    isCurrent: async () => {
      const current = await find(catalystApp, keyFor(operation));
      return Boolean(current && String(current.ROWID) === String(row.ROWID)
        && parseReference(current.request_reference)?.owner === reference.owner && !stale(current));
    },
    listSentReceipts: async ({ deadline } = {}) => {
      const receipts = [];
      // The dispatch lease protects this snapshot from another sender. Never
      // send from a partial receipt inventory: omitted evidence could resend
      // accepted mail. Paging is bounded by the caller's work deadline.
      for (let offset = 0; ; offset += 300) {
        if (deadline !== undefined && Date.now() >= deadline) return null;
        const rows = await catalystApp.zcql().executeZCQLQuery(
          `SELECT * FROM ${TABLE} WHERE claim_key LIKE '${quote(receiptPrefix)}*' ORDER BY claimed_at ASC, ROWID ASC LIMIT ${offset + 1}, 300`
        );
        receipts.push(...rows.map((wrapped) => decodeReceipt(wrapped[TABLE])));
        if (rows.length < 300) return receipts;
      }
    },
    recordSent: async ({ rowIds, messageId }) => {
      const receipt = { rowIds: rowIds.map(String), ...(messageId ? { messageId: String(messageId).slice(0, 255) } : {}) };
      if (!validReceipt(receipt)) throw new Error('Invalid sent-batch receipt');
      const next = { ...reference, phase: 'SENT', receipt };
      const serialized = JSON.stringify(next);
      if (serialized.length > MAX_REFERENCE_LENGTH) throw new Error('Sent-batch receipt exceeds the claim reference limit');
      // The receipt is independent of the expiring dispatch lease: replacing
      // a crashed worker's lease cannot erase accepted-mail evidence.
      // Keep the namespaced key below 100 characters for older claim tables.
      const hash = crypto.createHash('sha256').update([...receipt.rowIds].sort().join(',')).digest('hex').slice(0, 32);
      const key = `${receiptPrefix}${hash}`;
      try {
        return decodeReceipt(await table.insertRow({
          claim_key: key, claimed_at: toCatalystDateTime(), request_reference: serialized,
        }));
      } catch (error) {
        const existing = await find(catalystApp, key);
        if (existing) return decodeReceipt(existing);
        throw error;
      }
    },
    keepUndeleted: async (receipt, rowIds) => {
      const attempts = (Number(receipt.reference.cleanupAttempts) || 0) + 1;
      const next = { ...receipt.reference, cleanupAttempts: attempts,
        cleanupRetryAt: Date.now() + Math.min(60, 2 ** Math.min(attempts, 6)) * 60000,
        receipt: { ...receipt.reference.receipt, rowIds: rowIds.map(String) } };
      logger.error('integrationOperationClaimService', `Sent alert cleanup deferred; receipt ${receipt.ROWID}, attempt ${attempts}, remaining ${rowIds.length}`);
      if (!validReceipt(next.receipt)) throw new Error('Invalid sent-batch receipt');
      await table.updateRow({ ROWID: receipt.ROWID, request_reference: JSON.stringify(next) });
    },
    removeReceipt: (receipt) => table.deleteRow(receipt.ROWID),
  };

  try {
    return await fn(lease);
  } finally {
    if (!retain) {
      try {
        await table.deleteRow(row.ROWID);
      } catch (error) {
        logger.error('integrationOperationClaimService', `Cannot release ${operation}; lease will expire`, error);
      }
    }
  }
}

module.exports = { withOperationClaim, _test: { TABLE, LEASE_MS, keyFor } };
