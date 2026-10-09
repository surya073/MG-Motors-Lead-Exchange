'use strict';

/**
 * sweepWindow.js
 * -----------------------------------------------------------------------
 * Fair candidate windows for the scheduled sweeps.
 *
 * The sweeps read "the oldest N rows that still need work" and process what
 * they can. That is only safe while every row in the window eventually LEAVES
 * the set (is delivered, closed, breached, rotated). A row that is examined but
 * cannot be acted on — it throws, is waiting on a human, has data the sweep
 * cannot use — stays the oldest row forever. Enough of those and the window is
 * full of rows that never move, and newer rows behind them are never looked at
 * (starvation). Writing to such rows to push them back is not always allowed
 * (it would rewrite evidence such as the dealer acknowledgement time).
 *
 * So each sweep reads TWO slices of the ordered candidate set instead of one:
 *   - the HEAD: the oldest `headSize` rows, always (priority is unchanged);
 *   - a TAIL: `tailSize` rows further down, at an offset that advances with
 *     time. Over successive sweeps the tail walks the whole set, so every row
 *     is examined at least once every ceil((total - head) / tail) rotations
 *     however many rows ahead of it are stuck.
 *
 * Nothing is written to rows to make this work, so idempotency, evidence and
 * the existing rotation/back-off columns are untouched.
 */

// The tail advances once per bucket. The sweeps run every couple of minutes
// (cron), so each run normally sees a different slice.
const ROTATION_BUCKET_MS = 2 * 60 * 1000;

/**
 * Where the tail slice starts for this sweep, or null when the whole set fits
 * in the head and no tail is needed.
 *
 * @param {object} p
 * @param {number} p.total     rows in the candidate set
 * @param {number} p.headSize  rows always read from the front
 * @param {number} p.tailSize  rows read in the rotating slice
 * @param {number} [p.now]     epoch ms
 * @returns {{offset: number, rotations: number, index: number} | null}
 *   offset is a true 0-based row offset into the ordered set.
 */
function tailWindow({ total, headSize, tailSize, now = Date.now() }) {
  const remaining = Number(total) - headSize;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const rotations = Math.max(1, Math.ceil(remaining / tailSize));
  const index = Math.floor(now / ROTATION_BUCKET_MS) % rotations;
  return { offset: headSize + index * tailSize, rotations, index };
}

/** Reads a COUNT(ROWID) result row, or 0 when the shape is not a count. */
function countFrom(rows, table) {
  const value = Number(rows?.[0]?.[table]?.['COUNT(ROWID)']);
  return Number.isFinite(value) ? value : 0;
}

module.exports = { tailWindow, countFrom, ROTATION_BUCKET_MS };
