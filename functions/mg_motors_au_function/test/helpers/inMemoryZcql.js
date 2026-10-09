'use strict';

/**
 * A small in-memory ZCQL engine for tests. It implements only the query shapes
 * the dashboards and lead list generate, and reproduces the Catalyst Data Store
 * behaviours that matter (each one verified against the live Data Store):
 *   - LIMIT offset is effectively 1-based: `LIMIT 0,n` and `LIMIT 1,n` return
 *     the same rows, `LIMIT k,n` starts at the k-th row.
 *   - A LIMIT above 300 rows is rejected; a SELECT with no LIMIT silently
 *     returns only the first 300 (measured on the live project: a bare
 *     `SELECT * FROM leads` returned 300 of 465 rows).
 *   - More than 10 AND-joined conditions in a WHERE is rejected.
 *   - SQL NULL semantics: any comparison with NULL is not true, including !=,
 *     NOT IN and NOT LIKE.
 *   - LIKE uses `*` as its wildcard and is case-insensitive.
 *   - COUNT(ROWID) / MAX(col) come back as strings under those exact keys.
 *
 * Every executed statement is recorded in `queries` so tests can assert that a
 * dashboard never read rows it only needed to count.
 */

const MAX_AND_CONDITIONS = 10;

function tokenize(text) {
  const tokens = [];
  const re = /\s*(?:('(?:[^']|'')*')|(>=|<=|!=|=|<|>|\(|\)|,|[A-Za-z_][A-Za-z0-9_]*|\d+))/gy;
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push(match[1] !== undefined ? { type: 'str', value: match[1].slice(1, -1).replace(/''/g, "'") } : { type: 'word', value: match[2] });
  }
  return tokens;
}

function likeToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function parseWhere(text) {
  const tokens = tokenize(text);
  let i = 0;
  let ands = 0;
  const peek = () => tokens[i];
  const upper = () => (peek() && peek().type === 'word' ? peek().value.toUpperCase() : null);
  const take = () => tokens[i++];
  const expect = (word) => {
    if (upper() !== word) throw new Error(`ZCQL parse error: expected ${word} near token ${i}`);
    i += 1;
  };

  function predicate() {
    const column = take().value;
    let negate = false;
    if (upper() === 'IS') {
      i += 1;
      if (upper() === 'NOT') { negate = true; i += 1; }
      expect('NULL');
      const isNull = (row) => row[column] === null || row[column] === undefined;
      return negate ? (row) => !isNull(row) : isNull;
    }
    if (upper() === 'NOT') { negate = true; i += 1; }
    if (upper() === 'IN') {
      i += 1;
      expect('(');
      const values = [];
      while (peek().type === 'str') { values.push(take().value); if (peek().value === ',') i += 1; }
      expect(')');
      return (row) => (row[column] == null ? false : values.includes(String(row[column])) !== negate);
    }
    if (upper() === 'LIKE') {
      i += 1;
      const re = likeToRegExp(take().value);
      return (row) => (row[column] == null ? false : re.test(String(row[column])) !== negate);
    }
    if (upper() === 'BETWEEN') {
      i += 1;
      const lo = take().value;
      expect('AND');
      const hi = take().value;
      return (row) => (row[column] == null ? false : String(row[column]) >= lo && String(row[column]) <= hi);
    }
    const op = take().value;
    const literal = take().value;
    return (row) => {
      const value = row[column];
      if (value === null || value === undefined) return false;
      const v = String(value);
      switch (op) {
        case '=': return v === literal;
        case '!=': return v !== literal;
        case '>=': return v >= literal;
        case '<=': return v <= literal;
        case '<': return v < literal;
        case '>': return v > literal;
        default: throw new Error(`ZCQL parse error: operator ${op}`);
      }
    };
  }

  // Measured on the live Data Store: one flat chain of operands (comparisons, or
  // parenthesised groups counted as one) may hold 10; the 11th is rejected.
  // Each parenthesised group starts its own chain.
  let operands = 0;
  function term() {
    operands += 1;
    if (peek().value === '(') {
      i += 1;
      const outer = operands;
      operands = 0;
      const inner = orExpr();
      if (operands > MAX_AND_CONDITIONS) throw new Error('More than 10 conditions are not allowed in where clause');
      operands = outer;
      expect(')');
      return inner;
    }
    return predicate();
  }
  function andExpr() {
    let left = term();
    while (upper() === 'AND') {
      i += 1;
      ands += 1;
      const l = left;
      const r = term();
      left = (row) => l(row) && r(row);
    }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (upper() === 'OR') {
      i += 1;
      const l = left;
      const r = andExpr();
      left = (row) => l(row) || r(row);
    }
    return left;
  }

  const fn = orExpr();
  if (operands > MAX_AND_CONDITIONS) throw new Error('More than 10 conditions are not allowed in where clause');
  if (i < tokens.length) throw new Error(`ZCQL parse error: unexpected token ${tokens[i].value}`);
  if (ands + 1 > MAX_AND_CONDITIONS) throw new Error('More than 10 conditions are not allowed in where clause');
  return fn;
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (/^\d+$/.test(String(a)) && /^\d+$/.test(String(b))) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Unique constraints the live project has (verified from the column metadata):
// the datastore rejects the second of two inserts with the same value, server-side.
const LIVE_UNIQUE_COLUMNS = {
  outbound_sync_claims: ['claim_key'],
  leads: ['crm_record_id'],
  webhook_events: ['dedupe_key'],
  webhook_channels: ['channel_id'],
  dealers: ['dealer_code'],
  dealer_user_mapping: ['catalyst_user_id'],
};

function createInMemoryZcql(tables, { enforceUnique = false } = {}) {
  const queries = [];

  function execute(sqlRaw) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();
    queries.push(sql);
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: GROUP BY (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+)(?:, ?(\d+))?)?$/i.exec(sql);
    if (!m) throw new Error(`ZCQL parse error: ${sql}`);
    const [, selectList, table, where, groupBy, orderBy, limitA, limitB] = m;
    if (!tables[table]) throw new Error(`INVALID_TABLE ${table}`);

    let rows = tables[table].map((r, idx) => ({ ROWID: String(1000 + idx), ...r })).filter((r) => !r.__deleted);
    if (where) rows = rows.filter(parseWhere(where));

    const items = splitTopLevel(selectList);
    const aggregates = items.filter((it) => /^(COUNT|MAX)\(/i.test(it));
    const groupCols = groupBy ? groupBy.split(',').map((c) => c.trim()) : [];
    let out;

    if (aggregates.length || groupCols.length) {
      const groups = new Map();
      rows.forEach((row) => {
        const key = JSON.stringify(groupCols.map((c) => row[c] ?? null));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });
      if (!groupCols.length && groups.size === 0) groups.set('[]', []);
      out = [...groups.values()].map((members) => {
        const row = {};
        groupCols.forEach((c) => { row[c] = members[0]?.[c] ?? null; });
        aggregates.forEach((agg) => {
          const col = /\((.+)\)/.exec(agg)[1];
          if (/^COUNT/i.test(agg)) row[agg] = String(members.length);
          else row[agg] = members.reduce((best, r) => (r[col] != null && (best == null || String(r[col]) > String(best)) ? r[col] : best), null);
        });
        return row;
      });
    } else {
      out = rows.map((row) => (items[0] === '*' ? row : Object.fromEntries(items.map((c) => [c, row[c] ?? null]))));
    }

    if (orderBy) {
      const keys = orderBy.split(',').map((k) => {
        const [col, dir] = k.trim().split(/\s+/);
        return { col, desc: /^DESC$/i.test(dir || '') };
      });
      out.sort((a, b) => {
        for (const { col, desc } of keys) {
          const c = compareValues(a[col], b[col]);
          if (c !== 0) return desc ? -c : c;
        }
        return 0;
      });
    }

    if (limitA !== undefined) {
      const offset = Number(limitA);
      const count = limitB !== undefined ? Number(limitB) : offset;
      const start = limitB !== undefined ? Math.max(offset - 1, 0) : 0;
      if (count > 300) throw new Error('ZCQL CANNOT HAVE MORE THAN 300 ROWS in LIMIT');
      out = out.slice(start, start + count);
    } else if (!aggregates.length) {
      out = out.slice(0, 300); // a bare SELECT silently caps at 300 rows (live-measured)
    }

    return out.map((row) => ({ [table]: row }));
  }

  return {
    queries,
    tables,
    app: {
      zcql: () => ({ executeZCQLQuery: async (sql) => execute(sql) }),
      datastore: () => ({
        table: (name) => ({
          getIterableRows: async function* iterate() { for (const r of tables[name] || []) yield r; },
          // Row writes, keyed by the same positional ROWID (1000 + index).
          updateRow: async (fields) => {
            const idx = Number(fields.ROWID) - 1000;
            const row = (tables[name] || [])[idx];
            if (!row) throw new Error(`updateRow: no ${name} row ${fields.ROWID}`);
            const { ROWID, ...rest } = fields;
            Object.assign(row, rest);
            return { ROWID, ...row };
          },
          // Deleting leaves a tombstone so the positional ROWIDs of later rows stay stable.
          deleteRow: async (rowId) => {
            const idx = Number(rowId) - 1000;
            if (tables[name] && tables[name][idx]) tables[name][idx] = { __deleted: true };
            return { ROWID: String(rowId) };
          },
          insertRow: async (fields) => {
            if (enforceUnique) {
              for (const column of LIVE_UNIQUE_COLUMNS[name] || []) {
                const clash = (tables[name] || []).some((r) => !r.__deleted && r[column] != null && r[column] === fields[column]);
                if (clash) throw new Error(`Duplicate value for ${column}. Please give a different value`);
              }
            }
            (tables[name] = tables[name] || []).push({ ...fields });
            return { ROWID: String(1000 + tables[name].length - 1), ...fields };
          },
          // ROWIDs are assigned by position (1000 + index), matching execute().
          getRow: async (rowId) => {
            const idx = Number(rowId) - 1000;
            const row = (tables[name] || [])[idx];
            return row ? { ROWID: String(rowId), ...row } : null;
          },
        }),
      }),
    },
  };
}

module.exports = { createInMemoryZcql };
