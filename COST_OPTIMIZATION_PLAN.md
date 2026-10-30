# Catalyst Cost Optimization Plan (batched)

| | |
|---|---|
| Created | 22 October 2026 |
| Live revision | `aa0045f` (deployed 12 Oct). Local `main` is `79f43ae` (Batches 0–11 + E2E fixes, **not deployed**) |
| Source of findings | Read-only investigation of 22 Oct 2026: live access/app logs (21 Oct), live datastore counts, two Catalyst billing snapshots, code review |
| How to use | One batch per session. Start with: **"Implement Batch N from COST_OPTIMIZATION_PLAN.md"**. Update the status table at the end of each batch. |

## Goal

Cut Catalyst datastore operations (99.85% of the bill) without changing what the
Lead Exchange does for MG or any dealer. Every saving must be **measured** from the
Catalyst billing counters, not estimated.

## Ground rules (every batch)

1. **Don't break current behaviour.**
   - Every scenario in `LEAD_EXCHANGE_DEMO_RUNBOOK.md` must behave the same.
   - Optimizations remove *repeated reads/writes that produce no outcome*. They never skip a lead that needs work.
   - Anything that could change an outcome goes behind an env flag in `config/env.js`, default **off**.
2. **Tests first.** For each optimization, first write a test that **counts datastore operations** with `test/helpers/inMemoryZcql.js` and fails on today's numbers. Assert the count after the fix. Existing behavioural tests must still pass unchanged.
3. **Gate before each commit** (use Node 20: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH`):
   ```bash
   cd functions/mg_motors_au_function && npm test      # >= previous count, 0 fail
   cd ../../mg-motor-web && npm run build
   ```
4. **One branch per batch:** `cost/batch-N-<slug>`, with focused commits.
5. **No new datastore table/column** unless the batch says so (that adds cost of its own). Logging goes to Catalyst logs, not the datastore.
6. **Live changes** (env vars, crons, deploys) are done only when the user explicitly says so in that session.
7. **Measure every deploy** with the billing snapshot method below.

## Measured baseline (22 Oct 2026)

### Billing (cumulative for the current cycle; same cycle because "Bulk Read: 6 datasets" is unchanged)

| Counter | ~14 Oct snapshot | 22 Oct snapshot | Used between | Unit ₹ |
|---|---:|---:|---:|---:|
| Datastore Fetch | 1,316,750 | 2,355,759 | 1,039,009 | 0.0036 |
| Datastore Update | 199,408 | 271,501 | 72,093 | 0.0048 |
| Datastore Insert | 70,793 | 147,892 | 77,099 | 0.006 |
| Datastore Delete | 54,557 | 110,429 | 55,872 | 0.0048 |
| **₹ (ops)** | 6,384 | 11,201 | **4,817** (≈ ₹535–600/day) | |

Function time is ₹17.18 (0.15%). **Fetches are 75.7% of the bill.**

### Live traffic (21 Oct 15:23–23:48 IST, access + application logs)

| Component | Calls | Function time | Useful outcome |
|---|---:|---:|---|
| `/webhooks/crm-notify` | 240 | 63% | 51 changes (34 inserted, 17 updated). **189 (79%) changed nothing.** Each call makes 1 MG Zoho CRM read (`fetchOemLeadsByIds`, `leadSyncService.js:1057`). It arrives in bursts of ~6 within seconds for one lead. |
| `/cron/fast-recover` | 58 | 29% | 2 leads delivered. Ran every 1–2 min (80 gaps of 1 min means **two triggers**). **Disabled since 21 Oct 17:19 IST.** |

Per fast-recover run (application log summaries):
- **SLA sweep:** 16 AU008 candidates, **16 `skippedUnhealthy`, 0 checked** (59 of 59 sweeps).
- **Inbound replay:** `queued: 200`, 47–54 leads, **0 attempted** in most sweeps.
- **Outbound retry:** 0–1 candidates.

### Why the SLA sweep dominates

For each candidate, even one it skips, the SLA sweep does:
- 1 claim insert + 1 claim delete
- 3 fetches
- 1 rotate update

At 16 candidates × ~720 runs/day that predicts ≈ 86k inserts/deletes/updates over the period. Billed: 77k / 56k / 72k. The SLA sweep alone very likely caused nearly all inserts, updates and deletes and ≥ 25% of fetches.

### Other findings

| # | Finding | Where |
|---|---|---|
| F1 | 80% of outbound attempts can never succeed: 224 `INTEGRATION_NOT_CONFIGURED` + 145 `DEALER_ROUTING_INVALID` of 460 (21–22 Oct). They still run the full read path + 1 log insert. | `crmIntegrationService.js` outbound path |
| F2 | SLA candidate query does not exclude unhealthy integrations. The health check runs *after* the claim and the 3 reads. | `slaMonitorService.js:236` passes `[]` exclusions; check at `:339` |
| F3 | SLA keeps revisiting dealer-actioned leads forever (`skippedActioned` → rotate). | `slaMonitorService.js:344` |
| F4 | Inbound replay reads up to 200 held rows per run and filters "due" in JS. | `inboundReplayScheduler.js:22`, `:172`, `:292` |
| F5 | Zoho access tokens are cached per instance only: 21 refreshes across 20 instances in 8.5 h. | `zohoAuthService.js`, `zohoCrmOAuthHelper.js:17` |
| F6 | Unlimited outbound retries by default (`OUTBOUND_RETRY_POLICY` unset). | `config/env.js:112` |
| F7 | No usage visibility: no per-request count of datastore ops / Zoho calls / credits / token refreshes. Access-log and app-log request IDs differ. crm-notify logs nothing about what it did. | `utils/logger.js`, `routes/webhookRoutes.js:44` |
| F8 | Live env still has testing timings: SLA 2 min, Unhappy 3 escalation 2 min, Unhappy 7 retention 5 min, reconcile grace 2 min. **Fixed locally** in `catalyst-config.json` on 22 Oct (1440 / 1440 / 1440 / 10). Live not yet updated. | `catalyst-config.json` |
| F9 | Only 4 crons are registered live, all disabled. **No `renew-webhook` / `renew-dealer-webhooks` / `daily-error-report` / retry / replay / reconcile cron is registered**, yet crm-notify still arrives. | Catalyst Job Scheduling |
| F10 | Plaintext secrets in `catalyst-config.json` and live env, including the Gemini, Sarvam and Fusion keys, Fusion webhook secret, SMTP, Zoho, cron secret and `INTEGRATION_CREDENTIALS_KEY`. The cron secret is also visible in the cron job headers. | — |

## Measurement method (use after every deploy)

The billing console has **no per-day usage view** for this project (confirmed by the user on 22 Oct). It shows cycle-to-date totals. No usage API was found: none in the Catalyst docs I checked, and none in the Catalyst MCP tools. That is "not found", not "proven absent". So we measure in two ways and check them against each other (decision of 22 Oct):

1. **Primary, daily: self-metering.** Starting with Batch 1, every request and sweep logs a `usage` line with its datastore op counts. Each day:
   - Add up the lines from the Catalyst logs.
   - Price them at the unit rates: Fetch ₹0.0036, Update ₹0.0048, Insert ₹0.006, Delete ₹0.0048.
   - This gives daily cost **per route**.
2. **Cross-check: cumulative counters.** A few times per billing cycle, and always just before a deploy, screenshot the cycle-to-date totals (Fetch / Update / Insert / Delete) and note the date and time.
   - Billed ops between two snapshots should match the summed usage lines for that period.
   - If the gap is more than 10%, some ops aren't being counted. Find them before trusting the self-metered numbers. **The 10% threshold is an unverified assumption.** We don't yet know how quickly the Console counters update. Set the real threshold after the first cross-check.
   - Snapshots taken in different billing cycles can't be subtracted.
3. Compare each batch's daily cost with the previous batch's and record it in the status table below.

Do not deploy two batches inside one measurement window, or the savings can't be attributed.

## Batch overview

| Batch | Title | Code? | Expected effect (to be measured) |
|---|---|---|---|
| 0 | Baseline + live hygiene | No | Reference billing snapshot; answer F9; env diff |
| 1 | Usage logging (instrumentation) | Yes | Per-route op counts and self-metered daily cost (primary measurement), so every later saving is attributable |
| 2 | SLA sweep: do nothing for unhealthy/actioned leads | Yes | Removes most inserts/updates/deletes when fast-recover runs |
| 3 | Inbound replay + outbound retry: read only due rows | Yes | Removes the 200-row re-read per run |
| 4 | crm-notify: stop the expensive path early | Yes | Fewer reads for the 79% no-change notifications |
| 5 | Scheduler re-enable at production cadence | Config | Recovery back on at a fraction of the old cost |
| 6 | Shared Zoho token cache (only if Batch 1 data justifies it) | Yes | Fewer token refreshes |
| 7 | Cost KPI dashboard | Yes | Ongoing visibility |
| S | Secret rotation (parallel track) | Ops | Security, not cost |

---

## Batch 0: Baseline and live hygiene (no code)

1. Take a cumulative billing snapshot (method above), which is the cross-check reference point. Daily cost with fast-recover off is measured by Batch 1's self-metering.
2. **F9:** find out how Zoho watch channels are currently renewed and how the paced sweeps are triggered.
   - Check Zoho CRM → Notifications (channel expiry) and Catalyst Event Listeners / Job Pools.
   - If nothing renews the channels, `crm-notify` will stop when they expire. That is a functional risk; report it to the user immediately.
3. Inventory the live env vars against local `catalyst-config.json`. The live function config was modified on 22 Oct 08:22 IST: find out who changed what.
4. Ask the user whether to update the four timing env vars live now (F8) or with the next deploy.
5. Ask the user whether to delete the three dead one-off crons (`test_alert_send`, `daily_report_send2`, `daily_report_once`).

**Done when:** a reference billing snapshot exists, F9 is answered, and the live env diff is recorded. (Changed on 22 Oct: daily deltas moved to Batch 1, because the console has no per-day view.)

### Batch 0 results (22 Oct 2026, read-only checks)

Each point below is labelled **Verified** (with its source) or **Assumption (unverified)**.

**F9: what triggers the crons**
- **Verified** (Job Scheduling API): there are 4 crons, all disabled, in one job pool, `happy4_webhook_pool`.
- **Verified** (access logs, 15–22 Oct): scheduled cron calls still arrive, all from `10.20.60.17`, a private, non-internet address.

  | Route | Times seen (IST) |
  |---|---|
  | `/cron/renew-webhook` (MG OEM channel) | daily 23:59, 15–20 Oct. **Absent on 21 Oct.** |
  | `/cron/renew-dealer-webhooks`, `/cron/daily-error-report`, `/cron/retry-outbound-syncs` | daily 11:59. Each route seen every day 16–22 Oct (7-day log search). |
  | `/cron/sync-modified-leads` | hourly, at :06–:27. The 22 Oct 08:26 run returned **408** after 32 s. |

- **Verified:** `replay-inbound-events`, `check-lead-sla` and `reconcile-dealer-leads` don't appear in the logs I searched (17:00 on 21 Oct to 14:00 on 22 Oct).
- **Assumption (unverified):** what sends these calls is a Catalyst feature the Job Scheduling API doesn't list, for example the Console's function Cron trigger. **To verify:** look in the Catalyst Console.

**fast-recover trigger**
- **Verified** (access logs, 15:23–17:19 on 21 Oct only): every call came from the public IP `103.89.74.25`, every 2 min at :50 s, and stopped after 17:19:50. None came from `10.20.60.17` in that window.
- **Verified:** the Catalyst cron `happy4_fast_recover` is disabled. It was last modified on 23 Sep.
- **Not checked:** the plan's "two triggers" claim (80 gaps of 1 min) for any other period. I neither confirmed nor disproved it.
- **Assumption (unverified):** the caller at `103.89.74.25` knows `CRON_SECRET`. This is inferred from the HTTP 200 responses. **To verify:** find out who owns that IP.

**Overnight gap, 21–22 Oct**
- **Verified** (access logs):
  - No cron call at all from 21:06 on 21 Oct to 08:26 on 22 Oct.
  - No `crm-notify` from 23:48 on 21 Oct to 09:20 on 22 Oct.
  - A manual `renew-webhook` came from `59.92.89.49` at 09:19:30, and `crm-notify` resumed 30 s later.
- **Verified** (`webhook_channels`): the channel created at 23:59 IST on 20 Oct has `expires_at` = 23 h later. The current channel was created at 09:19 IST on 22 Oct.
- **Unexplained:** if `expires_at` is UTC, the old channel expired at 22:59 IST. But a `crm-notify` arrived at 23:48 IST. So either the stored time isn't UTC, or Zoho kept the channel open longer. I haven't resolved this.
- **Assumption (unverified):** the 9.5 h without `crm-notify` was caused by the channel lapsing, not by a lack of MG CRM activity. The 30 s recovery after the manual renewal supports this, but doesn't prove it. **To verify:** count Leads modified in MG CRM between 23:48 and 09:19.
- **Verified** (Get Function): the function config was saved at 08:22 IST on 22 Oct by the Surya I account. The Get Function API doesn't say which fields changed. **Not checked:** whether the Catalyst Console has an audit log that would show it.
- **Assumption (unverified):** that save is linked to the scheduler resuming at 08:26.
- **Action:** check `webhook_channels` on the morning of 23 Oct. The current channel expires around 08:19 IST, and it needs the 23:59 run on 22 Oct to happen.

**Outside cost scope**
- **Verified** (access logs): between 04:44 and 05:51 IST on 22 Oct, about 40 webhooks to `/webhooks/dealers/` (dealer code empty) and `/webhooks/dealers/411802` returned **401**. They came from `34.34.245.x` and `1.145.87.2`.
- **Verified:** live `FUSION_WEBHOOK_DEALER_CODES=568026`.
- **Assumption (unverified):** the sender is Fusion, and the 401s are related to that env value.

**Live env vs. local `catalyst-config.json`**
- **Verified:** both have the same 33 keys, plus `FUSION_TOKEN_RETRY=true` locally only.
- **Verified:** for non-secret values, the only differences are the four F8 timings. Live has `DEALER_ACTION_SLA_MINUTES=2`, `UNHAPPY_3_ESCALATION_WINDOW_MINUTES=2`, `UNHAPPY_7_RETENTION_MINUTES=5` and `RECONCILE_GRACE_MINUTES=2`.
- **Not compared:** secret values. The tooling blocked pulling them into a local command.
- **Unknown:** what the 08:22 save changed. Non-secret values match the 21 Oct record (from the [[deployed-state]] memory, not re-checked against a 21 Oct export). So it changed a secret, or nothing at all.

**Billing snapshots (cross-check only):** these are cycle-to-date totals from the Console. The per-day view isn't available, as the user confirmed. No usage API was found. The 22 Oct snapshot is the reference point. Add a row just before the Batch 1 deploy and a few times per cycle after it.

| Snapshot (IST) | Fetch | Update | Insert | Delete | ₹ ops (cumulative) | Self-metered ₹ for same period | Gap |
|---|---:|---:|---:|---:|---:|---:|---:|
| 22 Oct | 2,355,759 | 271,501 | 147,892 | 110,429 | 11,201 | — | — |
| before Batch 1 deploy | | | | | | — | — |

## Batch 1: Usage logging (instrumentation)

Purpose: every request and sweep emits **one** structured line that says what it cost. Nothing new is written to the datastore.

1. **Request context.** Add `services/usageContext.js` using `AsyncLocalStorage`, following the pattern of `services/integrations/alertContext.js`. Store:
   - `correlationId` (UUID, or Catalyst's request id if exposed)
   - `route` / `trigger`
   - `dealerCode` and `leadId` when known
   - counters
2. **Counting.** Wrap the per-request `catalystApp` in one place: right after `catalyst.initialize(req)` in `index.js`, `webhookRoutes.js` and `cronRoutes.js`. Count:
   - `zcql().executeZCQLQuery` as **fetch**
   - `datastore().table().insertRow/updateRow/deleteRow`, and their bulk variants, as insert/update/delete
   - Keep the wrapper transparent: same return values and errors.
3. **Zoho and dealer calls.** In `zohoCrmService.js` (MG CRM) and the adapters:
   - Count calls per org.
   - Record the last `X-API-CREDITS-REMAINING` value when present. An absent header means **unknown, not zero**.
   - Count token refreshes vs. cache hits in `zohoAuthService.js`, `zohoCrmOAuthHelper.js` and `fusionSdOAuthHelper.js`.
4. **Emit.** On response finish or sweep end, write one line through `logger.info('usage', ...)`:
   ```
   [INFO] [usage] {"cid":"…","route":"/webhooks/crm-notify","trigger":"Zoho CRM","ms":1066,
     "ds":{"fetch":9,"insert":1,"update":2,"delete":0},"zoho":{"mg":1,"dealer":0},
     "credits":{"mg":null},"token":{"refresh":0,"hit":1},"outcome":"unchanged"}
   ```
   - Make `logger` prefix every line with the `cid` from context, so app logs for one request can be grouped.
5. **crm-notify detail.** Log `module`, `operation`, the number of ids, and the result counts (`inserted / updated / unchanged / skipped`), using the existing `syncLeadsByIds` result.
6. Flag: `USAGE_LOG` (default **on**; logging only, no behaviour change). Add it via `config/env.js`.
7. **Tests:**
   - The counters match the operations done by an in-memory fake.
   - The wrapper preserves return values and thrown errors.
   - No secrets or customer payloads appear in the usage line.

**Deploy note:** Deploy Batch 1 together with the already-committed `main`, since `main` must ship first anyway. Then record 2–3 days of usage lines and billing deltas. Pause `happy4_fast_recover` (already disabled) and confirm AU008's `base_url` is an official Zoho host before deploying (see deployed-state notes).

**Done when:**
- The usage lines show which routes produce what share of fetches, inserts, updates and deletes. Record the table in this file.
- At least 2 days of self-metered daily cost are recorded. This is the fast-recover-off baseline that moved here from Batch 0.
- A billing snapshot cross-check is within ~10%.

### Batch 1 results (22 Oct 2026, code only, not deployed)

Branch `cost/batch-1-usage-logging`. Gate: backend **929 pass / 0 fail** on Node 20 (was 916; +13 new tests), frontend build OK.

**What was built**
- `services/usageContext.js`: one `AsyncLocalStorage` context per request, created by the first middleware in `index.js` (before webhooks and crons). `usageContext.initialize(catalyst, req)` replaces every `catalyst.initialize(req)` in `index.js`, `cronRoutes.js` and `webhookRoutes.js` (14 sites) and returns a counting `Proxy` of the app (same return values and errors, tested).
- Counted as **fetch**: each ZCQL query, `getRow`, `getPagedRows`, `getAllRows`, and `getIterableRows` (one per iteration). `fetchRows` = rows returned. **insert/update/delete**: one per row. Failed calls are counted (the request was made).
- CRM calls counted per org (`mg` or the dealer code) at every HTTP call site: `zohoCrmService` (6), `zohoWebhookService` (3), `genericRestAdapter` (each retry attempt), `fusionSdAdapter` (2), legacy `index.js` dealer post (`legacy-dealer`).
- Token `refresh` (each token endpoint call, incl. the Fusion retry) vs `hit` (cache or joined in-flight refresh) in `zohoAuthService`, `zohoCrmOAuthHelper`, `fusionSdOAuthHelper`.
- `/cron/fast-recover`: `stages` breaks ds ops down by `reconciliation`, `webhookEventRetention`, `outbound`, `inboundReplay`, `slaCheck`, `alertBatch` (needed to attribute Batch 2/3 savings).
- `crm-notify` adds `module`, `operation`, `ids` (count), `outcome` (`changed` / `unchanged` / `partial` / `failed`) and `result` counts (`fetched / inserted / updated / unchanged / failed / removed`; the sync result has no separate "skipped" count). Dealer webhooks add `dealerCode`.
- `logger` prefixes every line inside a request with `[cid=<uuid>]`.
- Flag `USAGE_LOG` (on unless `false`) in `config/env.js`; documented in `LEAD_EXCHANGE_DEMO_RUNBOOK.md`.
- `scripts/usageReport.js <exported-logs>`: sums usage lines per IST day and route and prices them (measurement step 1).

Actual line format (one per request, written on response finish or connection close):
```
[INFO] [cid=…] [usage] {"cid":"…","route":"/webhooks/crm-notify","method":"POST","trigger":"Zoho CRM","status":200,"ms":17,
  "ds":{"fetch":3,"fetchRows":0,"insert":6,"update":0,"delete":2},"api":{"mg":2},"credits":{},
  "token":{"refresh":1,"hit":1},"module":"Leads","operation":"insert","ids":1,"outcome":"changed","result":{…}}
```

**Verified / assumed**
- **Verified (tests):** counts equal the operations an independently tallied in-memory Data Store received, for a real crm-notify insert and an empty one; context survives `express.json()` / `express.raw()`; no tokens, secrets or lead PII in the line; `USAGE_LOG=false` writes nothing and leaves the app unwrapped. A mutation check (wrapper removed) makes the count tests fail.
- **Assumption (unverified):** Catalyst bills one Fetch per query/call, not per row. The line keeps both `fetch` and `fetchRows`; the first snapshot cross-check decides which one matches the bill.
- **Assumption (unverified):** the credits header name `X-API-CREDITS-REMAINING`. Not seen on a live response yet. If absent, `credits` stays empty (unknown), never 0. **To verify:** one live MG CRM response's headers after deploy.
- **Assumption (unverified):** whether Catalyst exposes a request id usable as `cid`; not checked, so `cid` is a random UUID.
- **Not counted:** Catalyst Cache (`segment().put/getValue`), mail, and any `catalystApp` created outside the 14 route sites (none found by search).

**Still to do (needs deploy, user decision):** deploy with `main`, record 2–3 days with `scripts/usageReport.js`, cross-check against a billing snapshot taken just before deploy, and fill in the per-route table below.

| Route | Share of fetch | insert | update | delete | ₹/day |
|---|---:|---:|---:|---:|---:|
| (after deploy) | | | | | |

## Batch 2: SLA sweep, no work for leads that can't breach (F2, F3)

1. Before selecting candidates, read the SLA dealers' integrations once per sweep.
   - Pass the ROWIDs of unhealthy integrations (status error/disabled/not configured/configuring) as `excludedIntegrationIds` to `selectOverdueMappings` (`slaMonitorService.js:146`, which already supports exclusions).
   - Keep the in-claim health re-check as the safety net.
2. For leads the dealer has already actioned, stop re-selecting them on every sweep without losing a real SLA transition. Preferred: enable the existing dealer-action clock (`SLA_DEALER_ACTION_CLOCK`, `config/env.js:193`) after verifying its column exists live. Otherwise, add a flag-guarded exclusion for actioned status values. **Decision needed: see open questions.**
3. Report the excluded count in the sweep summary (`excludedUnhealthy`).
4. **Op-count tests:**
   - 16 unhealthy candidates → at most 2 fetches, 0 inserts/updates/deletes (today: ~64 fetches + 16/16/16).
   - Healthy overdue unactioned lead → breach exactly as before.
   - Lead the dealer actioned → no claim.

### Batch 2 results (22 Oct 2026, code only, not deployed)

Branch `cost/batch-2-sla-sweep` (from `cost/batch-1-usage-logging`), commit `c503bcd`. Gate: backend **941 pass / 0 fail** on Node 20 (was 929; +12 new tests in `test/slaSweepCost.test.js`), frontend build OK.

**Live facts checked first (read-only, 22 Oct)**
- The 16 AU008 candidates were skipped because **AU008's `dealers` row is `Removed`**. AU008's integration is `CONNECTED`, so it is healthy. That in-claim skip writes nothing and doesn't rotate, so the same 16 came back on every sweep.
- So the baseline's "1 rotate update per candidate" was wrong for this path. Measured with the Batch 1 counter on today's code: **65 fetches + 16 inserts + 16 deletes + 0 updates** per sweep. The 72k billed updates came from somewhere else (or from the older live code `aa0045f`). **Not yet attributed.**
- `lead_integrations.last_dealer_action_at` **does not exist live**.
- `ROWID IN ('…' ×12)` and `dealer_code IN ('…' ×12)` are accepted by live ZCQL. The upper limit of an IN list is not known. If a screen query fails, the sweep falls back to its current behaviour.

**What was built** (`slaMonitorService.js`)
- `screenIntegrations`: after the candidate read, it reads the candidates' integrations (one `ROWID IN` query) and their dealers (one `dealer_code IN` query). It excludes integrations that the in-claim checks would skip **without writing**: `INTEGRATION_MISSING`, `OUTBOUND_DISABLED`, `INBOUND_DISABLED` (non-Fusion), `DEALER_MISSING`, `DEALER_REMOVED` (only when every row of that dealer is Removed).
- If more overdue rows exist than were read, the window is read again with `excludedIntegrationIds`, so excluded rows can't crowd out workable ones. Otherwise the rows are filtered in memory.
- Fusion dealers without a proven return channel are skipped **before** the claim. The check uses the screened row and is cached, so the in-claim check reuses the answer.
- New summary fields: `excludedUnhealthy` (count of excluded mappings) and `excludedIntegrations` (`[{dealerCode, reason}]`).
- No extra read when nothing is overdue (1 fetch, as before).

**Deliberately unchanged (outcome-preserving)**
- Integrations in an error status (`error / disabled / not configured / configuring`) are **still rotated under the claim**. Excluding them would stop the rotation, and then every overdue unactioned lead would breach the moment the integration recovers. At production timing (1440 min) each such row costs ~7 ops once a day.
- Dealer-actioned leads: unchanged (C3 answer). Turning on `SLA_DEALER_ACTION_CLOCK` would **not** stop re-selection: actioned leads are still rotated on the dealer clock (`test/slaDealerActionClock.test.js:132`).
- All in-claim checks are kept as the safety net. The screen can only defer a lead to the next sweep; it never decides an outcome.

**Op counts (in-memory, Batch 1 counter)**

| Case | Before | After |
|---|---|---|
| 16 overdue leads, dealer Removed | 65 fetch, 16 insert, 16 delete | ≤ 3 fetch, 0 writes |
| Outbound off / inbound off / dealer missing / integration missing | 1 claim + 4 reads per lead | ≤ 3 fetch, 0 writes |
| Fusion, no return channel (3 leads) | 3 claims (insert + delete) | 0 writes |
| Nothing overdue | 1 fetch | 1 fetch |
| Healthy overdue unactioned | breach | breach (identical) |

**Test changed:** `slaReturnChannelCoverage.test.js`, "dealer scope avoids…". It asserted exactly one `dealer_integrations` query. Now it asserts two, both for the in-scope candidate's ROWID only (the screen read plus the in-claim read). The test's intent, no out-of-scope reads, is now checked directly.

**Still to do (needs deploy, user decision):** ship after Batch 1 has been measured. Batch 1's `stages.slaCheck` in the fast-recover usage line gives the before/after.

## Batch 3: Inbound replay and outbound retry read only due rows (F4, F6)

1. **Inbound replay** (`inboundReplayScheduler.js`): add the due condition to the candidate ZCQL (based on `MODIFIEDTIME` and the 2–60 min interval), or as a first cheap pass. Then 200 held, not-due rows cost one small query instead of a full read.
   - Keep fairness (`sweepWindow`) and per-dealer budgets.
   - Skip unhealthy integrations up front.
2. **Outbound retry:** confirm the candidate query already filters on `next_retry_at` in ZCQL (`outboundRetryScheduler.js:60–83`). If any path reads then filters in JS, move the filter into the query.
3. Config (no code): recommend `OUTBOUND_RETRY_POLICY=classified` (10 attempts / 48 h, AUTH and PERMANENT stop). **This is a user decision.**
4. **Op-count tests:**
   - 200 held rows, none due → at most 2 fetches.
   - Due row → replayed exactly as before.

### Batch 3 results (22 Oct 2026, code only, not deployed)

Branch `cost/batch-3-due-rows` (from `cost/batch-2-sla-sweep`), commit `137f2c3`. Gate: backend **949 pass / 0 fail** on Node 20 (was 941; +8 new tests in `test/replayRetryCost.test.js`), frontend build OK.

**Live facts checked first (read-only, 22 Oct)**
- Replay queue: **319 FAILED rows, all AU008** (316 Unhappy 4, 3 Unhappy 9), created 23–24 Sep. A 300-row sample shows 82 dealer records; **43 of them wait only for a status mapping** (`STATUS_MAPPING_NOT_FOUND`). The rest are `ZOHO_ACK_UPDATE_FAILED` / `MG_WRITE_BACK_FAILED`. Only 17 of the 82 records have a `lead_integrations` row.
- Where the replay cost was: a hold that is not due is backed off with **no** reads. A mapping-only hold skips that backoff and paid **one `lead_integrations` read per hold per sweep**, just to learn nothing had changed. On the live shape that is ~33 fetches per sweep.
- Outbound queue: **1 FAILED row** (dealer 223201). The outbound change saves nothing today; it matters only when the queue is large.
- Verified live ZCQL: `(next_retry_at IS NULL OR next_retry_at <= '…')` filters correctly. An `IN` list of 99 quoted values is accepted. The batched mapping read over the 82 queued AU008 records returns the same rows as single reads, checked on records both present and absent.

**Why the replay window is not filtered in ZCQL (plan item 1 changed)**
Due-ness belongs to the *group* of rows for one dealer record. It is decided from the group's oldest row: an attempt stamps only that row's `MODIFIEDTIME`, and the other rows keep old timestamps. A row-level due filter would drop the recently tried oldest row, keep the others, and make a backed-off group look due. That would mean more dealer CRM reads and different outcomes. So the window read (head + count + tail, 1–3 fetches) is unchanged.
- **Open:** if Catalyst bills Fetch per *row* (Batch 1 question), those 200 rows per sweep would be the largest replay cost. Revisit after the Batch 1 cross-check.

**What was built**
- `inboundReplayScheduler.js`: the mapping rows of every hold the sweep is about to examine are read in one `IN` query per integration (chunks of 90). A failed chunk or a 300-row-capped result falls back to single reads. Holds past Unhappy 7 retention are excluded from the batch, so an expiry still reads its row just before acting. A hold whose integration is missing or unreplayable is now decided before its mapping read (it waits either way).
- `outboundRetryScheduler.js`: the paced sweep adds the due condition to the candidate ZCQL. Fast-recover (`ignoreSchedule`) still reads every failing row. The JS due check is kept as a safety net.

**Op counts (in-memory, Batch 1 counter)**

| Case | Before | After |
|---|---|---|
| Replay, live shape (30 awaiting mapping, 20 backed off) | 33 fetch | 4 fetch, 0 writes |
| Replay, 95 mapping-only holds | 98 fetch | ≤ 6 fetch |
| Replay, 10 due holds of a missing integration | 11 fetch | ≤ 2 fetch |
| Outbound, 150 not due + 2 due | 3 candidate reads (200 rows) | 1 read (2 rows) |
| Due row / changed mapping / retention expiry | replayed / replayed / expired | identical |

**Tests changed**
- `retryStarvation.test.js`, "the ordinary (paced) sweep still honours next_retry_at": `skippedNotDue` 1 → 0, because the not-due row is no longer read. The behavioural check (2 delivered, not-due row not attempted) is unchanged, and `totalCandidates` 2 was added. Only the sweep's log summary reads `skippedNotDue`.
- `inboundReplaySchedulerFairness.test.js`: its hand-written fake ZCQL now also answers the batched `IN` query. The assertions are unchanged.

**Closing review (22 Oct, same session)**
- AU008 held updates, read-only check: a due replay calls the AU008 dealer CRM (`getLead`), then `processResolvedInboundLead` returns `DEALER_CONFIGURATION_INVALID`. That reason is non-terminal by design (`crmIntegrationService.js:2291`), so the hold is re-stamped and retried. Live: 32 AU008 mappings are `HELD / DEALER_CONFIGURATION_INVALID`, and 33 held log rows were re-stamped between 14 Oct and 21 Oct 17:17. The `getLead` call costs no Data Store ops. Decision C8: keep as is.
- C4: leave unlimited for now.
- Replay window (up to 200 rows per sweep) stays as is. **Revisit only if** the Batch 1 cross-check shows Fetch is billed per row.
- Deploy: not yet (user, 22 Oct). Order when started: Batch 1 (with `main`) → measure 2–3 days → Batch 2 → measure → Batch 3 → measure.

**Still to do (needs deploy):** ship after Batches 1–2 have been measured. Batch 1's `stages.inboundReplay` / `stages.outbound` in the fast-recover usage line give the before/after.

## Batch 4: crm-notify, stop the expensive path early (F1, F7)

1. **Non-deliverable leads:** decide `INTEGRATION_NOT_CONFIGURED` / `DEALER_ROUTING_INVALID` before any claim, mapping or snapshot reads.
   - Keep **one log row per event** (user decision, 22 Oct).
   - Keep the alert behaviour unchanged.
2. **No-change notifications:** make sure the `unchanged` outcome in `leadSyncService.js` (`:620–907`) does **no** datastore writes and no outbound dispatch. Count reads on that path and remove any that aren't needed to decide "unchanged".
3. **Bursts:** investigate, don't build yet.
   - Zoho Notifications API options to avoid the per-notification CRM read: `return_affected_field_values`, field-level filters, ignoring our own writes.
   - Record the findings here and ask the user before changing the channel.
4. **Op-count tests:**
   - Unconfigured dealer → reads ≤ N (record today's N first).
   - Unchanged lead → 0 writes.
   - Real change → identical behaviour.

### Batch 4 results (22 Oct 2026, code only, not deployed)

Branch `cost/batch-4-crm-notify` (from `cost/batch-3-due-rows`), commit `0c54d80`. Gate: backend **962 pass / 0 fail** on Node 20 (was 949; +13 new tests in `test/crmNotifyCost.test.js`; no existing test changed), frontend build OK.

**Live facts checked first (read-only, 22 Oct)**
- F1's rows are all `Unhappy 5 / CREATE_LEAD` from crm-notify since 21 Oct: 244 `INTEGRATION_NOT_CONFIGURED` and 167 `DEALER_ROUTING_INVALID`. They are **not** outbound retries of the same event. A lead typically arrives with no dealer, gets one or two more MG edits within seconds, and later MG routing assigns a dealer with no integration. Each change is one real event, logged once (decision: one log row per event).
- So F1's saving is per event, not per repeat. The claims and the lead write are still needed, because the MG fields are mirrored on every change.

**Per-event cost on today's code (in-memory, Batch 1 counter, MG CRM mocked)**

| Case | fetch | insert | update | delete | MG API |
|---|---:|---:|---:|---:|---:|
| New lead, no dealer assigned | 6 | 10 | 1 | 2 | 2 |
| New lead, dealer without integration | 9 | 10 | **2 → 1** | 2 | 2 |
| Update, dealer without integration | 6 | 8 | **3 → 2** | 1 | 2 |
| Unchanged notification | 1 | 1 (`sync_logs`) | 0 | 0 | 1 |

The 10 inserts of a new held lead are: `leads` 1, claims 2, `integration_logs` 1, `sync_logs` 1, `notifications` 4 (Unhappy 5 alert and "Lead sync complete", each to ADMIN and SUPER_ADMIN), `integration_alert_queue` 1.

**What was built** (`leadSyncService.js`)
- `decideLeadUpdateRoute` / `resolveNewLeadRoute`: the hold (routing, consent, validation, dealer missing or removed, no integration mode) is decided **before** the lead row is written, so it is saved by the update or insert itself instead of a second `PENDING → hold` write.
- A new lead's dealer and integration are read once, before the insert, and reused by the dispatch (previously read again after the insert).
- A failed routing read leaves the lead `PENDING`, and the dispatch reports it exactly as before (Unhappy 1 `DISPATCH_FAILED`).
- Saving: 1 update per held event, about 270 events/day, so **≈ ₹1.3/day**. Small; the larger crm-notify costs are the per-event alert and notification rows, kept by decision.

**Unchanged path (plan item 2), verified:** an unchanged record is caught against the bulk snapshot before any claim. It does 1 fetch, 0 lead writes, no dispatch and no log row, and inserts only the run's `sync_logs` row (kept, decision C9).

**Bursts (plan item 3), findings; no channel change (decision C11)**
- MG's watch channel subscribes to `Leads.all`, with no field filter and no affected-field values. The dealer channel already uses `return_affected_field_values`.
- Zoho v8 `notification_condition` can filter by changed fields, but allows **at most 10 fields**. The mirror copies ~25 fields, so a filter would miss real changes. Not safe.
- `return_affected_field_values` returns the changed fields. That could skip the MG CRM re-read, but that saves MG API calls, not Data Store ops.
- No option is documented to ignore our own writes.
- Source: zoho.com/crm/developer/docs/api/v8/notifications/enable.html (read 22 Oct).

**Still to do (needs deploy):** ship after Batches 1–3 have been measured.

## Batch 5: Scheduler at production cadence (config, after Batches 2–3 are live and measured)

1. Re-enable recovery at **every 15 min**, with a single trigger. The 1-minute gaps on 21 Oct mean two triggers existed; find and remove the second.
2. Register the paced crons from `LEAD_EXCHANGE_DEMO_RUNBOOK.md` that are missing (F9): renew webhooks, daily error report at 12:00 AET, daily reconcile.
3. Measure for 2–3 days. **Done when:** recovery works (re-run Happy 4 / Unhappy 1 demo) and daily cost stays near the Batch 0 baseline.

### Batch 5 preparation (22 Oct 2026, read-only; no live change; decision C12: keep paused)

Batch 5 has no code. Every step is a live scheduler change, gated on Batches 2–3 being live and measured. None of Batches 1–4 is deployed yet, so only the preparation was done.

**Current state (verified 22 Oct, Job Scheduling API + access logs)**

| Route | What runs today | Caller |
|---|---|---|
| `/cron/fast-recover` | **Nothing since 21 Oct 17:19.** The Catalyst cron `happy4_fast_recover` (`*/2 * * * *`) is disabled. | 21 Oct calls came from external IP `103.89.74.25`, not the Catalyst cron |
| `/cron/sync-modified-leads` | Hourly at about :27 | Hidden scheduler `10.20.60.17` |
| `/cron/retry-outbound-syncs`, `/cron/daily-error-report`, `/cron/renew-dealer-webhooks` | Daily 11:59 IST | Hidden scheduler |
| `/cron/renew-webhook` | Daily 23:59 IST (skipped 21 Oct); 22 Oct 09:19 was a manual run | Hidden scheduler / manual |
| `/cron/replay-inbound-events`, `/cron/check-lead-sla`, `/cron/reconcile-dealer-leads` | Never | — |

The Job Scheduling API lists only 4 crons, all disabled: 3 one-off test crons and `happy4_fast_recover`. The hidden scheduler is not among them.

**Side effect of the pause (verified):** queued alert emails are sent by time window **only** from `/cron/fast-recover` (`cronRoutes.js:300`). The only other trigger is the queue reaching `ALERT_BATCH_SIZE`, which is 100 live. On 22 Oct, 68 alerts were queued from 11:26 IST and not sent. Decision C12: accept this until Batch 5.

**Blockers to clear before applying Batch 5**
1. Find the hidden scheduler (`10.20.60.17`) in the Catalyst Console, for example the function's Cron trigger. New Job Scheduling crons for renew, daily report or reconcile would otherwise run **twice**. The API can't see it.
2. Identify the owner of `103.89.74.25`, the external fast-recover caller on 21 Oct. If it resumes after the Catalyst cron is enabled, there are two triggers again.
3. Deploy Batches 1–3 and measure them first (plan order). Apply the 4 F8 timing env vars at the same deploy (C1).

**Target schedule (from `LEAD_EXCHANGE_DEMO_RUNBOOK.md:78–83`; one trigger each)**

| Route | Target | Change from today |
|---|---|---|
| `/cron/fast-recover` | Every 15 min (edit `happy4_fast_recover` to `*/15 * * * *` and enable) | Re-enable. Restores the alert window flush, Happy 4, SLA and replay. |
| `/cron/renew-webhook` | Every 12 h | Today daily, with a 23 h channel. Batch 0 found a 9.5 h crm-notify gap on 21–22 Oct. |
| `/cron/renew-dealer-webhooks` | Every 12 h | Today daily |
| `/cron/daily-error-report` | 12:00 Australia/Sydney | Today 11:59 IST. The business timezone needs confirming (runbook). |
| `/cron/reconcile-dealer-leads` | Daily | Missing today |
| `/cron/sync-modified-leads` | Hourly (keep) | — |
| `/cron/retry-outbound-syncs`, `/cron/replay-inbound-events`, `/cron/check-lead-sla` | Covered by fast-recover every 15 min; keep `retry-outbound-syncs` daily as today | Avoids paying for the same sweep twice |

**To check on 23 Oct morning (Batch 0 action, still open):** did the 23:59 IST `renew-webhook` run on 22 Oct, and is `crm-notify` still arriving?

## Batch 6: Shared Zoho token cache (conditional)

Only if Batch 1 shows token refreshes are frequent enough to matter (Zoho throttles token generation).
- Store the MG CRM access token in Catalyst Cache with expiry minus a safety margin.
- Keep the per-instance cache as the first level.
- Never log token values.

### Batch 6 decision (22 Oct 2026): not built, condition not met

The batch is conditional on token refreshes being frequent enough to matter. Batch 1 is not deployed, so the existing live application logs were used instead (read-only).

| Measure (MG Zoho token, `Refreshed Zoho access token` log lines, 15 Oct 18:25 – 22 Oct 14:01 IST, complete: 194 lines under the 200 page cap) | Value |
|---|---|
| Refreshes per day | ~24 (6 on the partial first day; 40 on 21 Oct, when fast-recover ran every 2 min) |
| Peak in any 10-minute window | **3** (22 Oct 10:20) |
| Distinct instances that refreshed | 54 |
| Token failures in 7 days (`OAuth token request failed`, `Access Denied`, `INVALID_TOKEN`, "too many requests") | **0** |

- **Zoho's limits** (Zoho One / Directory OAuth docs, found by web search 22 Oct; not confirmed specifically for CRM): 10 access tokens per refresh token per 10 minutes, 15 active per refresh token (the oldest is invalidated on the 16th), 1 h validity. The peak of 3 per 10 min is well below 10.
- **Cost:** a token refresh does no Data Store operations, which are 99.85% of the bill. A shared Catalyst Cache would add cache calls to every request and save nothing on the bill.
- **15-active-token cap:** ~1 refresh per hour across instances never approaches 15 active tokens in an hour on today's traffic.
- **Revisit if:** Batch 1's `token.refresh` counts show more than ~5 refreshes in any 10 minutes, or any token failure appears in the logs (for example after Batch 5 restores fast-recover, or under a traffic burst).
- Live application-log ingestion was stalled after 14:07 IST on 22 Oct, so that day is partial.

## Batch 7: Cost KPI dashboard

- Super-admin page in `mg-motor-web` showing:
  - billing snapshots (entered manually or uploaded)
  - daily cost trend and month-end projection
  - ops by route (from Batch 1 usage data)
  - cost per delivered lead
  - share of non-deliverable attempts
  - sweeps with zero useful work
  - retry recovery rate
  - Zoho credits remaining per org
  - token refreshes
- **Data source decision needed:** Catalyst logs API on demand (no datastore cost) vs. a small daily aggregate table (a few writes per day). Never one row per operation.

### Batch 7 results (22 Oct 2026, code only, not deployed)

Branch `cost/batch-7-cost-kpis` (from `cost/batch-4-crm-notify`), commits `864d7a5` (API) and `0baca05` (page). Gate: backend **979 pass / 0 fail** on Node 20 (was 962; +17 in `test/costKpi.test.js`; no existing test changed), frontend build OK (no warning from the new files).

**Decision C6:** an uploaded daily summary, not the logs API. The logs API would need a new Catalyst admin OAuth secret and many paged calls per view, and it shows partial data whenever log ingestion stalls (it did on 22 Oct, from 14:07 IST).

**What was built**
- **Table `cost_daily`** (the one new table this batch allows). A Super Admin upload writes a few rows; a page view writes nothing.
- **API**, Super Admin only (`routes/costKpiRoutes.js`, `services/costKpiService.js`):
  - `GET /admin/cost-kpis?days=7|30|90`
  - `POST /admin/cost-kpis/usage`: the JSON from `scripts/usageReport.js --json`. Re-uploading a day replaces that day. ₹ is priced on the server from the op counts; an uploaded ₹ figure is ignored.
  - `POST /admin/cost-kpis/billing`: `{ snapshotAt, fetch, update, insert, delete }`, the Console's cycle-to-date counters.
  - `DELETE /admin/cost-kpis/billing/:rowId`: BILLING rows only.
  - A missing table answers `503 COST_TABLE_MISSING`, and the page shows set-up guidance.
- **Page** `/cost-kpis` ("Cost KPIs" under Data & Sync, Super Admin only):
  - KPI tiles: metered cost, month-end projection, cost per delivered lead, non-deliverable share, retry recovery rate, share of crm-notify calls that changed nothing.
  - Daily cost chart and Data Store ops by route.
  - Sweeps with no useful work.
  - Zoho credits (lowest seen, latest day) and token refreshes.
  - Billing snapshot entry, plus billed vs self-metered between consecutive snapshots, with the gap %. Snapshots from different billing cycles are flagged, not subtracted.
- **KPI definitions:**
  - Delivered = Happy 1 + Happy 4.
  - Non-deliverable share = Unhappy 5 ÷ all Happy/Unhappy MG → dealer lead events (`CREATE_LEAD`/`UPDATE_LEAD`).
  - Recovery rate = Happy 4 ÷ (Happy 4 + Unhappy 3).
  - Projection = month-to-date metered ₹ + (average of the last ≤ 7 metered days × days left in the month).
- **Logging only:** sweep routes (`fast-recover`, `retry-outbound-syncs`, `replay-inbound-events`, `check-lead-sla`, `reconcile-dealer-leads`, `sync-modified-leads`) add `outcome: worked|idle` and `work` to their usage line. A sweep counts as worked only on an outcome that changed something: recovered or delivered, a breach, expired or closed holds, reconcile changes, synced records, or an alert batch sent.
- **`usageReport.js`** now also sums idle sweeps and unchanged notifications, keeps the lowest Zoho credits seen per org, and has a `--json` flag.

**To use it (needs deploy and a Console step):**
1. Create `cost_daily` in Data Store with these columns:
   - `record_type` Varchar(20), `usage_day` Varchar(10), `route_label` Varchar(255);
   - BigInt: `requests`, `ds_fetch`, `ds_fetch_rows`, `ds_insert`, `ds_update`, `ds_delete`, `api_calls`, `token_refresh`, `idle_runs`, `unchanged_runs`;
   - `cost_inr` Double, `credits_json` Text, `snapshot_at` DateTime.
2. Deploy with Batch 1. The usage lines must exist before there is anything to upload.
3. Daily: export the function logs, run `node scripts/usageReport.js --json <logs> > usage.json`, and upload it on the page. Add a billing snapshot a few times per cycle and always just before a deploy.

**Assumption (unverified):** the exact error text live Catalyst returns for a missing table on an insert. The route matches `Unkown Table cost_daily` (the ZCQL text seen live) and "not found" / "does not exist" variants. Any other text shows as a generic 502 until the table exists.

## Batch S: Secret rotation (parallel, ops)

Rotate everything listed in F10. `INTEGRATION_CREDENTIALS_KEY` needs a migration of encrypted dealer credentials first (see the cost audit, §COR / security notes). Move all secrets to Catalyst env vars only.

---

## Decisions already taken (22 Oct 2026)

| Topic | Decision |
|---|---|
| Audit trail for non-deliverable leads | Keep one `integration_logs` row per event (current behaviour) |
| `happy4_fast_recover` | Leave disabled; decide after the baseline (Batch 0/5) |
| APM | Deferred: list issues first, decide later |
| Timing env vars | Restored locally to 1440 / 1440 / 1440 / 10; live update pending |

## Open questions

| # | Question | Batch | Answer |
|---|---|---|---|
| C1 | Update the 4 timing env vars live now, or with the next deploy? | 0 | With the next deploy (22 Oct). **Applied with the Batch 1 deploy, 22 Oct 18:33 IST.** |
| C2 | Delete the 3 dead one-off crons? | 0 | Leave them for now (22 Oct). |
| C3 | Actioned-lead SLA exclusion: enable `SLA_DEALER_ACTION_CLOCK` (needs live column check) or add a flag-guarded status exclusion? | 2 | Keep current behaviour (22 Oct). The column is missing live, and the clock would not stop re-selection anyway. |
| C4 | Enable `OUTBOUND_RETRY_POLICY=classified` (10 attempts / 48 h)? MG hasn't formally approved the retry schedule (register open point 1). | 3 | Leave unlimited for now (22 Oct), until MG approves the retry schedule. |
| C8 | AU008 is Removed, but its held inbound updates (32 `HELD / DEALER_CONFIGURATION_INVALID` mappings, 319 FAILED log rows) are retried about hourly, each calling AU008's dealer CRM. Keep, skip the CRM call (flag), or close them (flag)? | 3 | Keep as is (22 Oct). By design they replay if AU008 is reinstated. The cost is mostly AU008 API credits, not Catalyst Data Store. |
| C5 | SLA clock basis: calendar vs. trading hours (register open point 4) | 2 | |
| C6 | Dashboard data source: logs API vs. daily aggregate table | 7 | Uploaded daily summary in table `cost_daily` (22 Oct). |
| C7 | Should the ~85 dealers without an integration receive Lead Exchange processing at all, or be filtered upstream in MG CRM? | 4 | |
| C9 | Skip the `sync_logs` row for a crm-notify run that changed nothing (~530 rows/day, ~₹3.2/day)? | 4 | Keep writing it (22 Oct). |
| C10 | Stop the "Lead sync complete" in-app notification for webhook runs (~290 rows/day, ~₹1.7/day)? | 4 | Keep them (22 Oct). |
| C11 | Change MG's watch channel to reduce bursts (field filter / affected values)? | 4 | No change (22 Oct): the field filter caps at 10 fields, and affected values save MG API calls only. |
| C12 | Re-enable recovery (fast-recover) now, before Batches 1–3 are deployed? It is also the only window-based alert flush. | 5 | Keep paused, plan order (22 Oct). Alerts go out only when 100 are queued until then. |

## Status

**23 Oct 2026 rollout (user decision: all today, one at a time).** Batches 2, 3, 4 and 7 were deployed in order from branch `release/cost-rollout`: live code (`fd26ab7` Batch 1 + `62d87c9` webhook hotfix) plus each batch cherry-picked (`aa5b8ef`, `5e5124c`, `c0ec65b`, `319c21b`/`937e6f0`). Before each deploy: the full suite on a clean checkout (947 → 955 → 968 → 985, 0 fail), and the deploy config rebuilt from the current live env (34 vars, unchanged). After each: health probes.
- Batch 2: a live SLA run screened AU008 out (`excludedUnhealthy: 16`, `DEALER_REMOVED`, 0 candidates, no writes).
- Batch 3: a live outbound retry run delivered 3 of 3 due leads.
- Batch 4: real crm-notify traffic returned 200.
- Batch 7: the web client was deployed only after checking that the live bundle had the same `main` features (no rollback).
- **Measurement consequence:** with Batches 2–7 live the same day, the self-metered saving can only be measured **combined**, not per batch.
- Batch 7: the `cost_daily` table was created at 09:21 IST and the missing-table fix (`fdda89d`) was deployed at 09:36.
- **Batch 7 replaced (23 Oct 09:45–09:48 IST, user decision):** cost monitoring is internal only and no longer in the MG portal. The Cost KPIs page was reverted and `/admin/cost-kpis` unmounted (`c7d5517`). Instead:
  - `usageRollup.js` saves every request's usage counts as hourly totals per component in `cost_usage_hourly`: one insert per function instance about every 10 minutes, counted as "(cost module)".
  - A standalone page at `/server/mg_motors_au_function/internal/cost` reads those totals with an access key (`COST_DASHBOARD_KEY`). It shows ₹ estimate, Data Store ops, rows read, CRM API calls per org, token refreshes, idle sweeps and the last credits seen, by component and by hour.
  - The totals are a floor: an instance recycled before saving loses its last minutes. The `[usage]` log lines stay the full record.
  - **Fix (10:00 IST, `d0f839e`):** live instances lived only 9 s to about 3 min, so the first version (save every 10 min) saved nothing. Totals are now saved 20 s after a burst's last request, and every 2 min while an instance stays busy. The first row was saved at 10:00:46.
- **Next (user decision, 23 Oct 10:05): wait for data.** Let the internal cost page collect a few hours, then choose fixes from the top-cost components. Candidates already seen in today's usage lines:
  - The portal dealers list reads 609 rows per view.
  - The leads list reads about 400 rows per view.
  - The notifications check reads 51 rows per poll.
  - The out-of-order events view makes 7 calls to removed dealer AU008's CRM per view.

| Batch | Status | Branch / commits | Daily cost after (₹/day) | Notes |
|---|---|---|---|---|
| Baseline (fast-recover on) | measured | — | ≈ 535–600 | 14→22 Oct snapshot delta |
| 0 | done (22 Oct) | — (no code) | | F9 answered: a hidden internal scheduler, and an external fast-recover caller. OEM channel lapsed for about 9.5 h on 21–22 Oct. C1/C2 answered. |
| 1 | **deployed 22 Oct 18:33 IST** (function only) | `cost/batch-1-usage-logging` `fd26ab7` | | Deployed with the C1 timings (1440/1440/1440/10) and `FUSION_INBOUND_V2=true` kept; `FUSION_TOKEN_RETRY` not set. Post-deploy: env diff 0, webhook auth probes OK. Still pending: the billing snapshot for 22 Oct just before the deploy, then 2–3 days of usage lines and a cross-check. |
| 2 | **deployed 23 Oct 08:56 IST** | `cost/batch-2-sla-sweep` `c503bcd` | | No-write integrations screened before the claim; 16 removed-dealer leads: 65 fetch + 32 writes → ≤ 3 fetch per sweep. Deploy after Batch 1 is measured. |
| 3 | **deployed 23 Oct 08:59 IST** | `cost/batch-3-due-rows` `137f2c3` | | Code complete. Replay mapping reads batched (live shape 33 → 4 fetch/sweep); outbound due filter in ZCQL. C4 and C8 answered (keep current). Waiting on deploy + measurement (after Batches 1–2). |
| 4 | **deployed 23 Oct 09:00 IST** | `cost/batch-4-crm-notify` `0c54d80` | | Held events write the lead once (≈ ₹1.3/day). Unchanged path verified write-free apart from `sync_logs` (kept). C9–C11 answered: keep. Burst findings recorded. |
| 5 | prepared (22 Oct), blocked | — (config only) | | Current state verified; target schedule written. Blocked on: Batches 1–3 deployed and measured, the hidden scheduler located in the Console, and the owner of `103.89.74.25`. C12: keep paused. |
| 6 | not built (22 Oct): condition not met | — | | Peak 3 refreshes per 10 min (Zoho limit 10), ~24/day, 0 token failures in 7 days; no Data Store saving. Revisit on Batch 1 data. |
| 7 | **deployed 23 Oct 09:03 / 09:04 IST; portal page replaced 09:48 by the internal cost page (`c7d5517`)** | `cost/batch-7-cost-kpis` `864d7a5`, `0baca05` | | Super Admin Cost KPIs page plus API; uploaded usage summaries and billing snapshots in `cost_daily`. Needs the table created and Batch 1 deployed. |
| S | not started | | | |

## Next session (written 23 Oct 2026, 10:10 IST)

**Verify first (live checks, no changes)**
1. The `happy4_fast_recover` cron (`*/15`, enabled 10:05) ran and returned 200 from 10:15 onward. Check failed leads recover within 15 minutes, and queued alert emails are sent.
2. `FUSION_TOKEN_RETRY=true` (10:05): count `Fusion SD token endpoint did not respond` and Unhappy 1 events since 10:05, compared with 12 timeouts from 20 to 23 Oct.
3. The internal cost page has a few hours of hourly totals in `cost_usage_hourly`. Compare against the `[usage]` log lines to see how much the totals undercount.
4. Fusion inbound (dealer → MG): no Fusion call since 22 Oct 09:54 IST. Ask Sami to resend, or to send a test event to each of the four addresses. Tell him about the ~35 calls on 22 Oct to `/webhooks/dealers/` with no dealer code. Check Buckby and Tynan secrets against what Fusion signs with.

**Optimization candidates (choose from the cost page data)**
- Portal reads:
  - The dealers list reads 609 rows per view.
  - The leads list reads about 400 rows per view.
  - The notifications check reads 51 rows per poll.
  - Out-of-order events makes 7 calls to the CRM of AU008 (removed dealer) per view.
- The cost of fast-recover at `*/15` now that it's back on (SLA, replay, retry, reconcile stages).
- Batch 5 remainder:
  - Find the hidden hourly scheduler `10.20.60.17` in the Console, and identify who calls from `103.89.74.25`.
  - Then set renew-webhook and renew-dealer-webhooks to every 12 h, the daily report to 12:00 AET, and add the daily reconcile.
- Batch 6: revisit only if token refreshes exceed ~5 in 10 minutes.

**Open items needing someone else**
- Billing snapshot (user): note today's Fetch, Update, Insert and Delete totals for the before/after proof.
- Fusion HTTP 500 at 22 Oct 22:06:40 UTC (lead `lead_01M5KCX1C7ZA047CT44CP57C98`): Fusion to investigate.
- Test leads are over Melanie's limit (Hillcrest 5, Tynan 5, Buckby 4): create no more test leads, and exclude them from KPIs.
- Open decisions C5 (SLA clock basis) and C7 (dealers without an integration).
- Batch S, secret rotation: `catalyst-config.json` secrets, and `COST_DASHBOARD_KEY` if it is ever shared.

## Session 23 Oct 2026, 10:10–13:00 IST (verification, cost ranking, audit)

**Verified live (read-only)**
- fast-recover */15: 10 runs from 10:05 to 12:20, all HTTP 200 (they fire at :05/:20/:35/:50). 10:05 sent the queued alert email (88 failures); 10:20 delivered 12 held 406802 leads. An idle run reads 360–450 rows in about 170 queries: 124 single-row outbound reads, plus 5 AU008 replays that recover nothing.
- FUSION_TOKEN_RETRY: 2 token timeouts (10:05:54, 11:12:06). Both recovered on the retry, with 0 Unhappy 1.
- `103.89.74.25` = the Catalyst Job Scheduler (it sends happy4_fast_recover). That Batch 5 item is closed.
- cost_usage_hourly: 64 rows in 2.4 h. 7 saves failed with `No privileges to perform this action`; the totals are kept and saved by a later flush. Cause: `usageContext.js:279` initializes with the requester's scope.
- Fusion inbound (34.34.245.x) did call after 22 Oct:
  - 411802 at 08:54: the signature passed, but the call was rejected with INVALID_TOKEN because of an extra `x-api-key`/`x-webhook-token` header.
  - 223201 at 12:17–12:19: 16 real calls got INVALID_SIGNATURE (`wouldMatch: none`); Tynan still stores the shared secret.
  - The team's signed 411802 tests (11:15–11:22) worked end to end. One was held: "Not Contacted" has no EXTERNAL_TO_ZOHO mapping.

**Cost ranking ([usage] lines, 22 Oct 21:56 → 23 Oct 10:11)**
- Per-row billing ≈ ₹550/day matches the bill; per-query would be ≈ ₹42/day. So fetches are probably billed per row (inference).
- #1 crm-notify [Dealers]: a daily 05:00–05:04 IST burst of ~213 notifications (21 and 23 Oct), each running a full syncDealers over 238 rows, with 0 changes.
- #2 fast-recover idle runs. #3 portal list reads. #4 crm-notify [Leads].

**Decisions (user, 23 Oct)**
- C13 Dealers burst = debounce in code. Branch `cost/dealer-sync-debounce` (from d0f839e, uncommitted, not deployed): a cross-instance `dealer-sync` claim held for its 5-min lease, a pending marker, and a trailing sync in fast-recover. 1003/1003 tests pass. It also fixes the overlapping-syncDealers race found by the audit.
- C14 fast-recover = keep */15 for now; measure a full day first.
- C15 Tynan/Buckby = the team restores the original per-dealer signing secrets (as was done for Hillcrest and Indooroopilly).
- C16 the extra token header on signed Fusion webhooks = ask Fusion (Sami) first; no code change yet.

**Code audit (23 Oct)**: 16 findings, all with failing tests in the session scratchpad. See the session summary. Top items:
- dealerSyncRoutes has no role guards (any logged-in user can trigger syncs and read the dealer master).
- A failure streak is never cleared on success (the next failure becomes Unhappy 3 "Dealer Unavailable").
- The dealer-sync race (fixed by C13).
- A signed webhook is rejected by the extra token header (C16).
