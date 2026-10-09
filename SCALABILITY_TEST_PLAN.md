# Scalability test plan — MG Motor AU Lead Exchange

**Status: a plan only. None of the load tests below has been run.** What *has* been verified is
listed in "Already verified" so it is not repeated or over-claimed.

Target: 100–200 new leads/day today, growing to 100,000–200,000 stored leads, with integration logs,
notifications and multiple dealers (AU008 plus ~200 more).

## 0. Ground rules

- Run everything in a **scratch Catalyst project** (or the dev datastore), never production.
- Seed data with a script that inserts through the Data Store SDK (bulk insert, 200 rows/call) — not
  through the sync path, so seeding does not call the OEM CRM or dealer CRMs.
- Stub the OEM CRM and dealer CRMs with a local HTTP stub that adds a configurable delay
  (200 ms / 2 s / 8 s) and failure rate. Never point load tests at the real Zoho orgs (API quota).
- Record every number with the date, project, function memory size and row counts. A result is only valid
  for the volume it was measured at.

## 1. Already verified (dev datastore, read-only probes)

| Fact | Consequence |
|---|---|
| `LIMIT offset, n` is effectively 1-based; bare SELECT silently returns 300 rows; LIMIT > 300 rejected | All paged reads send `offset + 1`; full reads use `selectEveryRow` |
| WHERE limit is 10 conditions per chain (docs say 5); groups get their own chain, total also bounded | Lead-list builder tracks chain length, returns 400 `FILTER_TOO_COMPLEX` |
| 429 "Concurrency limit" at ~14 parallel queries | Fan-outs capped (`utils/concurrency.js`, stats cap 3 with retry) |
| Only system columns have a search index; UNIQUE on a few columns; no EXPLAIN | **No index was added** (see §6) |

Still unverified: the real function time limit (docs 30 s Advanced I/O / 15 min Cron; dev showed 65 s and 88 s runs finishing).

## 2. Data volumes

| Table | Today | Stage A | Stage B |
|---|---|---|---|
| leads | ~ thousands | 25,000 | 200,000 |
| lead_integrations | = leads | 25,000 | 200,000 |
| integration_logs | ~ thousands | 150,000 | 1,000,000 |
| notifications | 28,572 | 100,000 | 500,000 |
| dealers / dealer_integrations | ~dozens | 100 | 250 |
| sync_logs | small | 20,000 | 100,000 |
| outbound_sync_claims / webhook_events | tiny | steady state | 500,000 events |

Shape the data like production: 5–10% FAILED/Unhappy rows, a block of 1,266+ held Unhappy 4 rows,
skewed dealers (top 5 dealers hold 50% of leads), 3% duplicates, 1% dangling mappings (§5.2).

## 3. Scenarios and pass criteria

Pass criteria are proposals — agree them with the business first.

### 3.1 Query latency (per table at each stage)
Measure p50/p95/p99 over 200 runs each, from inside a function (not from a laptop), cold and warm:
- `/admin/leads` page 1, page 500, last page; with each filter alone and the heaviest combination
  (search + status + dealer + scenario + path + date range).
- `/admin/leads` facets (`includeFacets`), dashboard stats (COUNT/GROUP BY), `/admin/integration-logs`.
- Dealer `/my-leads` for the largest and a small dealer (dealer isolation must hold: assert no foreign rows).
- Sweep candidate queries: SLA overdue head+tail, replay head+tail, retry head+tail, routing holds.
- Criterion: p95 < 3 s per request, and latency growth from Stage A→B is sub-linear for indexed/paged paths.
  Any query that grows linearly with table size is a finding.

### 3.2 Webhook throughput
- Lead webhook (OEM→MG): 1, 5, 20 concurrent deliveries; bursts of 200 in 60 s; duplicate deliveries of the same
  id; deliveries with the modified-since fallback path.
- Dealer webhooks: 50 dealers × 4 events/min for 10 min, plus replayed duplicates (same event id).
- Measure accepted/2xx rate, 429/5xx rate, time to ack, lag until the lead appears in the portal, duplicate rows (must be 0),
  double deliveries to the dealer (must be 0).

### 3.3 Memory and function execution time
- Function memory at 512 MB / 1 GB, peak RSS per route (`process.memoryUsage()` logged per request).
- Wall time of each cron route at Stage B: `fast-recover`, `retry-outbound-syncs`, `replay-inbound-events`,
  `check-lead-sla`, `reconcile-dealer-leads`, `sync-modified-leads`, `daily-error-report`, full `syncLeads`.
- Run each with the stubbed dealer delay at 200 ms, 2 s and 8–10 s (the real adapter timeout).
- Criterion: every route finishes well inside the *verified* limit. First task: find the real limit — raise a test route's
  sleep to 25, 35, 60, 120 s and record where the platform kills it (per function type and per cron target type).
  The sweeps' budgets (fast-recover 25 s, retry 50 leads, replay 20) assume 30 s until this is known.

### 3.4 Concurrency and idempotency (multi-instance)
- Fire the same cron route from 2–5 clients simultaneously, repeatedly, for 30 min; assert: no lead breached twice,
  no lead delivered twice, no duplicate `leads`/`lead_integrations` rows, claims table returns to empty,
  no `sync_logs` rows stuck "Running".
- Webhook storm for one lead (50 concurrent identical + 50 different-status events).
- Kill a function mid-sweep (timeout) and confirm the next sweep recovers (claim TTL 5 min).
- Daily report: run twice concurrently — known risk, confirm duplicate email behaviour.

### 3.5 API pagination
- Walk every page of `/admin/leads`, `/my-leads`, `/admin/integration-logs` at Stage B while a writer inserts leads;
  assert no duplicate and no missing row (the old 0-based offset bug), and stable total.
- Page-size limits and invalid page numbers return 400, not 500.

### 3.6 UI responsiveness (where supported)
- Lighthouse/Playwright against the deployed web client on Stage A/B: Lead Exchange, My Leads, Integrations,
  Dashboard — time-to-first-content, time-to-interactive, filter-change latency, search-as-you-type debounce,
  heap growth after 30 page changes. Throttle to "Fast 3G" and 4× CPU.
- Criterion: filter change < 2 s at p95; no request fan-out (>6 parallel calls) on any page load.

### 3.7 Rate-limit behaviour
- 20–30 parallel dashboard loads: confirm 429s are retried and surface as a warning, never a blank page.

## 4. Growth model check

100–200 leads/day → ~73k/year at 200/day. 200k leads ≈ 2.7 years. Integration logs grow ~5–8 rows per lead
(sync, ack, status updates), so ~1M logs at Stage B. Notifications grow fastest (28,572 already, mostly alert noise
from the trial) — retention (§5.1) matters more than lead count.

## 5. Specific items to test

1. **Notification retention** — see report: no TTL exists. Test list/unread-count/clear-all latency at 100k/500k rows.
2. **Dangling retry mappings** — seed 1% mappings with no lead / no integration; confirm valid retries are still
   attempted within one rotation cycle (`retryStarvation.test.js` proves this in memory only).
3. **Held Unhappy 4 backlog** — seed 5,000 FAILED Unhappy 4 rows; confirm every row is examined within
   `ceil((N-100)/100)` sweeps and cost per sweep stays bounded.
4. **Lead-list WHERE complexity** — run every filter combination from the UI at Stage B; none may 502.

## 6. Index decision procedure (do not add indexes without this)

Catalyst exposes `search_index_enabled` only through column metadata, and ZCQL has no EXPLAIN. To justify an index:
1. In the scratch project, load Stage B data.
2. Record p95 of the hot query (e.g. `leads WHERE dealer_code = ... ORDER BY CREATEDTIME`, `integration_logs WHERE
   happy_unhappy_path_name IN (...) AND status = 'FAILED'`) 200× with the column un-indexed.
3. Enable the search index on that column (console), wait for indexing, repeat.
4. Keep the index only if p95 improves materially (suggest ≥ 30%) **and** insert latency does not regress.
5. Only then repeat in production with approval.

## 7. Deliverables of a test run

A table per scenario: volume, p50/p95/p99, error rate, peak memory, wall time, verdict, plus the raw logs.
Anything not measured is marked "not tested" — never extrapolated.

## 8. Scheduling `/cron/sync-modified-leads` (do not apply without approval)

| Setting | Recommendation | Basis |
|---|---|---|
| Auth | `X-Cron-Secret` header = `CRON_SECRET` env var | route code (`routes/cronRoutes.js`); same as all cron routes |
| Frequency | every **5 minutes** | quiet runs cost one OEM call (HTTP 304) and write no `sync_logs` row; watermark overlaps the previous run by 2 min, so a missed run loses nothing |
| Target type | prefer a Catalyst **Function**-type cron (15 min limit) over HTTP/URL (30 s) | runs stay safe if a busy period is slow; incremental runs are normally seconds |
| Timeout | expect seconds in normal operation | first-ever run with no logged run falls back to a 24 h lookback (never before `LEAD_SYNC_SINCE`), which is the slowest case to measure |
| Overlap | safe: same-instance runs are serialised; across instances, claims + UNIQUE `crm_record_id` + the re-check inside the insert claim prevent duplicate rows/deliveries | `crossInstanceConcurrency.test.js` (in-memory engine) — **not** proven against real concurrent Catalyst instances |
| Failure | returns 502; the watermark is the start of the last Incremental run with zero failed records, so a run with failures is re-read next time | `getIncrementalWatermark` |

Verify before enabling: the real function limit (§3.3) and one manual run in the target environment.
