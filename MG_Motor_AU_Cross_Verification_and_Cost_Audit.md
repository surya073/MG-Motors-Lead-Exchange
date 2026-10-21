# MG Motor AU — Code, Integration and Datastore Cost Audit

**Latest remediation:** The 11 defects found in the subsequent re-verification have now been fixed locally and tested (916 backend, 28 frontend tests passing). See [E2E remediation results](MG_Motor_AU_E2E_Remediation_Results.md) for the final changes, cost tradeoffs and deployment prerequisites. No deployment or measured production savings are claimed.

**Audit date:** 14 October 2026  
**Source revision:** `6e83308`  
**Current scope:** Local code remediation authorized by your subsequent **“Do it”** instruction. No deployment or live-data changes. Sections 1–13 preserve the original baseline assessment; **section 14 records the delivered remediation**. The subsequent **[end-to-end re-verification](MG_Motor_AU_End_to_End_Reverification.md)** identifies 11 remaining defects in that working tree and is the latest assessment of readiness.  
**Current validation:** 833 backend tests pass on Node 20.20.2; 18 frontend tests pass; production frontend build passes. Backend npm dependency findings: 0. Frontend findings: 100, with 0 critical. Local implementation details, compatibility changes, cost evidence and remaining work are recorded in section 14.

**Baseline provenance:** At the original read-only handover, temporary edits were undone and source matched revision `6e83308`. The subsequent authorized fixes now modify local source and lockfiles. Earlier statements such as “unchanged source,” “unimplemented” and the 732-test baseline in sections 1–13 refer to that original assessment.

## 1. Verdict

The application has a substantial, functioning synchronization implementation and a strong regression suite. **It is not yet defensible to call it fully solid, secure, cost-efficient or production-ready at the proposed scale.**

The unchanged backend passes **732 tests, zero failures**, including a fresh run on the configured **Node 20.20.2** runtime. The unchanged frontend builds successfully with **18 warnings**. Those checks validate covered behavior; additional read-only probes exposed authorization gaps, a Fusion signature fallback, duplicate alert dispatch, incomplete SLA coverage above 300 Fusion integrations, and unnecessary datastore work.

The supplied charges add up to **₹6,396.7674332**, approximately **₹6,396.77**. Datastore Fetch is **₹4,740.30, or 74.10%**. Function compute is only **₹12.46, or 0.19%**. Reducing function memory or optimizing a few JavaScript operations will have little effect on this bill. Repeated datastore queries, retry attempts and bookkeeping are the main targets.

**Baseline cost assessment:** At the original read-only audit no fixes had been delivered. Local fixes have now been implemented as recorded in section 14; no production savings have been measured because they have not been deployed. The invoice does not contain endpoint/table attribution or its billing dates, so it cannot prove which code path produced each charge.

## 2. Evidence, scope and limits

### Supplied material reviewed

| Input | Use and assessment |
|---|---|
| [Technical Audit Handover](MG_Motor_AU_Technical_Audit_Handover.md) | Checked architecture, security, routing, synchronization, scheduling, scale and evidence requirements against current source. Its context statements are not treated as verified production facts. |
| [External Clarifications](MG_Motor_AU_External_Clarifications.md) | Checked open business/vendor decisions. Some old pending questions have later technical answers in the vendor contract or remediation register; business approval still needs an owner. |
| [Fusion OpenAPI](lead-api-mg-motors-openapi%203.yaml) | Checked authentication, endpoints, payloads, responses, status names, signed webhooks, limits and error behavior. It is a dealer-specific Sandbox snapshot. |
| [Fusion PDF guide](lead-api-mg-motors-guide.pdf) | Extracted and reviewed all 11 physical pages. Generated 29 September 2026, 23:35:44. |
| [CRM exchange workbook](CRM%20fields%20for%20Exchange.xlsx) | Reviewed `MG CRM Matrix` and `Fusion SD Map`, including mandatory fields, editing rights, statuses and mapping proposals. |
| [Previous Fusion audit](FUSION_SD_AUDIT.md) | Rechecked old findings against current implementation rather than assuming they remain open. |
| [Fusion remediation plan](FUSION_REMEDIATION_PLAN.md) | Checked recorded decisions, flag/schema prerequisites, implementation notes and unfinished work through Batch 11. |

### Method

- Inspected the starting Git status and recent history. Starting tracked files had no modifications; supplied documents/images were already untracked and were preserved.
- Reviewed backend routes, adapters, credential handling, mapping, retries, replay, SLA, reconciliation, alert batching, reporting and relevant frontend requests.
- Ran the existing backend suite and frontend build after restoration.
- Ran read-only `npm audit --json` for both lockfiles against current npm advisories. No dependencies were installed or updated.
- Used synthetic in-memory datastore, HTTP, DNS, OEM and email stubs to reproduce additional defects. These probes did not send dealer leads, edit a live datastore or email anyone.
- Checked official Catalyst billing documentation. Rupee calculations use **your supplied unit prices**, not a replacement public price list.

### Not verified in this session

Deployed revision, active feature flags, live saved dealer mappings, actual scheduler registrations/frequencies, live datastore permissions/unique constraints, credential revocation, vendor-side request outcomes, production indexes, peak load, queue drain rate, and the invoice's exact period/account scope were not independently inspected. Historical live observations in the remediation notes remain **historical evidence**, not fresh verification.

A local configuration file contains deployment settings and credentials, but its contents do not establish what is currently deployed. This report records relevant configuration names and non-sensitive operational settings only.

## 3. Current architecture and what already works

The project has one Catalyst Advanced I/O Express backend and a React portal. Webhooks and cron routes authenticate separately before the session middleware; portal APIs run after current-user lookup. The adapter factory supports **GENERIC_REST, ZOHO_CRM and FUSION_SD**. AutoPlay is not implemented.

Several previous findings are substantially addressed in current source:

| Area | Current positive evidence | Remaining condition |
|---|---|---|
| OEM ingestion | Zoho notifications with IDs fetch only affected records. No-ID recovery uses modified-since ingestion. Incremental runs do not soft-delete records merely absent from a partial response. | Durability and checkpoint flags must be verified; manual full sync remains a large operation. |
| Duplicate/concurrency protection | Per-lead/dealer claims, canonical business fingerprints, unique-key event dedupe and bounded call pools exist. Tests cover cross-instance scenarios with an emulator. | Real unique constraints are essential. Claim fail-closed behavior is optional; simulated tests do not establish platform-wide guarantees. |
| Fusion OAuth | Basic access-key/secret authentication and form-encoded client credentials match the contract. Ten-minute fallback lifetime, refresh margin, invalidation and process-local single-flight are implemented. | Token errors and transport defenses have residual gaps. |
| Fusion record identity | Adapter accepts documented `lead_id` or a plausible Location. Accepted-without-ID requests are parked as `ACK_UNRESOLVED` instead of ordinarily recreated. | Manual linkage/vendor recovery remains needed; generic REST behavior is intentionally different. |
| Fusion updates | Correct PATCH path and merge-patch content type. Disabled updates are skipped/held. Manual/ignored-field diagnostics are recorded. | Recorded submission does not certify live-enquiry application. Changes-only patches depend on flags and snapshots. |
| Mapping | Dotted targets are expanded; prototype/collision checks and directional status mapping exist. Marketing preset uses `contact.marketingOptinEmail`. | Existing stored admin mappings are not automatically migrated by changing presets. |
| Fusion inbound | Flat status-only translator, signature verifier, encrypted durable event store and replay implementation exist. | Feature/schema prerequisites and the signature fallback defect below remain. |
| Dashboards/lists | Ordinary lead pages are paginated. Many dashboard counts use aggregation rather than downloading every lead. | Several legacy callers still scan whole tables; aggregation cost is not proven constant. |
| Notifications | Bulk writes are concurrency-limited. Notification bell has no recurring polling timer. | Ownership and completeness defects remain. |
| Auth debug | Debug output is suppressed in production builds by `authDebug.js`. | Development still prints token prefixes; this is not a confirmed production-bundle leak. |

The timeline **Unhappy 1 → Happy 4 → Happy 1** can be intentional recovery bookkeeping: an initial failure, recovery, then successful creation. It does not itself prove duplicate lead creation. Batch 11 records prior token-call timeouts as the observed cause; this audit did not re-fetch live logs to confirm that cause today.

## 4. Highest-priority security and correctness findings

**Classification:** Confirmed means demonstrated in current source or a synthetic reproduction. Conditional means the trigger/configuration is known but live occurrence is unverified. Priorities reflect application impact, not only dependency advisory scores. These findings describe the **baseline**; section 14 records which remedies have now been implemented locally.

### SEC-01 — Legacy dealer/lead routes lack role checks

**Priority:** P1 / High; potential cross-dealer access or mutation.

**Evidence:** `functions/mg_motors_au_function/index.js:40` checks that a current user exists. Its inline `/dealers`, `/dealers/:rowId`, `/leads` and `/leads/:rowId` handlers then lack `requireAdminRole` or `requireAdminOrViewRole`. The same applies to dealer creation/update/deletion/key regeneration and lead creation/delivery/deletion. Comments saying “admin only” are not enforcement. Newer `/admin/...` routes have guards, but these legacy routes are still mounted.

Responses return raw dealer records, including `APIKey` where that column is present. Key generation uses `Math.random()`. Legacy delivery uses a stored endpoint directly with `fetch`, a credential header, no explicit timeout and no shared SSRF check. PUT also spreads the request body after ROWID, allowing caller-supplied fields/ROWID to override the intended row.

**Impact/limit:** A signed-in dealer or view user reaches handlers intended for administrators. Effective datastore access depends on deployed SDK/table permissions and whether legacy columns are active; those were not inspected. Frontend route restrictions do not provide server authorization.

**Recommendation:** Guard reads by intended roles and mutations by admin roles; explicitly scope dealer-facing records; whitelist update fields and keep the path ROWID authoritative; remove secrets from ordinary reads; use cryptographic key generation; guard and bound outbound legacy delivery. Test every legacy route with anonymous, dealer, view and admin identities, including absence of datastore access for rejected users.

### SEC-02 — Notification ROWID mutations lack recipient authorization

**Priority:** P1 / High.

**Evidence:** `routes/notificationRoutes.js:38` and `:74` pass the requested ID to `markRead`/`deleteNotification`. `services/notificationService.js:69` and `:84` mutate that row without comparing its recipient to the authenticated user/role. Synthetic original-source probes performed both mutations on an arbitrary foreign ID with **zero recipient reads**.

**Recommendation:** Resolve the row using ID plus authenticated recipient scope before mutation; return 404 when outside scope. Define whether role-wide notifications are globally mutable by one role member. Verify deployed datastore permission behavior separately.

### SEC-03 — Fusion V2 accepts unsigned legacy-token requests

**Priority:** P1 / High; confirmed, conditional on V2 and a valid token.

**Evidence:** `services/integrations/webhookVerificationService.js:240` selects Standard Webhooks verification only when `webhook-signature` is present. Omitting it reaches the static-token fallback around `:265`, even with `FUSION_INBOUND_V2=true`. A synthetic probe returned:

```json
{"signedWebhookFlagOn":true,"standardSignatureHeadersPresent":false,"result":{"ok":true}}
```

This contradicts the later Q19 decision that a valid signature is required. It requires knowledge of an accepted legacy token; it is not unauthenticated public access. It bypasses signed-body integrity and five-minute freshness requirements.

**Recommendation:** Always invoke the signed verifier for Fusion V2, including when headers are missing. Preserve legacy fallback only for the legacy mode. Add missing-signature-with-valid-token, stale, tampered and rotated-secret tests.

### SEC-04 — Incomplete SSRF checks and unguarded dealer OAuth destinations

**Priority:** P1 / High.

**Evidence:** `services/integrations/adapters/genericRestAdapter.js:34` blocks selected ranges only. Mock DNS results for `fd00::1`, `fc12::1`, `fe90::1`, `::ffff:127.0.0.1` and `100.64.0.1` are accepted. DNS is checked before Axios performs its own resolution, leaving a resolution-to-connection gap. Requests do not explicitly disable redirects or pin validated addresses.

`adapters/zohoCrmOAuthHelper.js:73` constructs the token destination from arbitrary `oauth_accounts_domain`. A mocked call accepted `http://127.0.0.1`. Credentials can therefore be sent to an unintended account host. Arbitrary public dealer `base_url` also risks sending a Zoho token to the wrong service. Q8 already records a historical third-party-host setting; its correction/revocation was not freshly verified.

**Recommendation:** Use approved Zoho account/API hosts for Zoho integrations, complete HTTPS/address checks, connection-time address pinning and explicit redirect handling. Apply these before releasing credentials. Preserve datacenter support using official host tables. Axios documents separate redirect/proxy/transport options in its [request configuration](https://axios-http.com/docs/req_config); merely validating the initial URL does not validate a later destination.

### SEC-05 — Historical credentials were committed; rotation is unverified

**Priority:** P1 / High historical exposure.

**Evidence:** Current `.env` and function `catalyst-config.json` are untracked, but commit `d8a09fb` contains nonempty `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_WEBHOOK_TOKEN`, `CRON_SECRET`, `GEMINI_API_KEY`, `SARVAM_API_KEY` and `EXTERNAL_CRM_API_KEY`. Later commits blank/remove/ignore the configuration; they do not remove older Git objects.

**Recommendation:** Confirm revocation/rotation of previously exposed values and relevant access review. Ignoring the current file is insufficient evidence of remediation. Any history rewrite requires a separate repository-owner procedure. Rotating the encryption key requires migration of encrypted dealer credentials, inbound events and snapshots; simply replacing it can make them unreadable. No values are reproduced here.

### COR-01 — SLA skips channel checks after the first 300 Fusion integrations

**Priority:** P1 / High at the reproduced scale.

**Evidence:** `services/integrations/slaMonitorService.js:154` uses bare `SELECT *` for Fusion integrations. The returned set is capped; only its members are added to the exempt list. With **301 synthetic Fusion integrations**, inbound disabled and V2 off, an overdue mapping belonging to the 301st integration was nevertheless breached: **300 exemptions, one SLA_BREACH and one mocked OEM write**.

**Recommendation:** Read all integrations with stable pagination and fail closed for candidate integrations not present in the verified lookup. Add a >300-dealer regression. This is a demonstrated scale condition, not a claim 301 dealers are deployed today. Catalyst documents SELECT result limits in its [Cloud Scale FAQ](https://docs.catalyst.zoho.com/en/faq/cloud-scale/).

### COR-02 — Concurrent alert flushes send duplicate digests

**Priority:** P1/P2 / High operational correctness and cost amplification.

**Evidence:** `integrationAlertBatchService.js:63`, `:117` and `:136` share no dispatch lease. With 99 queued rows and three concurrent enqueues, original code sent **three mocked emails**, issued **300 delete attempts for the same first 100 rows**, and left two rows queued. Snapshot isolation does not make email sending/deletion atomic.

**Recommendation:** Use a durable single-worker dispatch lease and deterministic batch identity; retain entries after failed delivery. A warm-process mutex alone does not cover multiple instances. Test enqueue/cron overlap, mail success followed by delete failure and crashes around dispatch.

### COR-03 — Signed-channel proof has no authentication provenance

**Priority:** P2 / Medium, configuration-dependent.

**Evidence:** `slaMonitorService.js:136` treats any SUCCESS event with a non-null event ID as proof of a signed Fusion return channel. Stored rows do not prove how they authenticated. Token-only historical events can qualify after flags/secrets are enabled. Retention can also delete the last proof and exempt a quiet dealer again.

**Recommendation:** Store verified authentication method and a separate durable channel-health record. Keep channel proof independent of arbitrary event retention.

### COR-04 — Contact/body-size protection can corrupt data and still exceed the limit

**Priority:** P2 / Medium, oversized structured payload condition.

**Evidence:** `fusionSdAdapter.js:243` trims the longest flat strings rather than approved free text. A nested `messages` fixture still sent **88,071 bytes** after truncating `contact.email`; the contract limit is 32 KB. The helper can run out of flat strings and return an oversized body.

**Recommendation:** Protect contacts, IDs and enums; truncate only agreed note/transcript fields; measure final serialized UTF-8 size after nesting and hold an oversized record with an explicit error. Do not infer that ordinary current leads hit this case.

### COR-05 — PDF upload analysis uses the wrong parser API

**Priority:** P2 / Medium; confirmed runtime mismatch.

**Evidence:** `services/onDemandAiService.js:79` assigns `require('pdf-parse')` and `:83` calls it as a function. Installed v2 exports an **object containing `PDFParse`**, confirmed under Node 20. The successful import is therefore followed by a non-callable-object invocation. Existing sync tests do not exercise this user flow.

**Recommendation:** Implement the installed v2 class API with lifecycle cleanup and one genuine uploaded-PDF regression. This audit's document extraction used a working extraction method; it does not certify the application's upload parser.

## 5. Billing breakdown and interpretation

| Resource | Supplied usage | Supplied unit price | Gross amount | Share |
|---|---:|---:|---:|---:|
| Function, 256 MB | 51,932 seconds | ₹0.00024/second | ₹12.463680 | 0.195% |
| Datastore Update | 199,408 requests | ₹0.0048 | ₹957.158400 | 14.963% |
| Datastore Fetch | 1,316,750 requests | ₹0.0036 | ₹4,740.300000 | 74.105% |
| Datastore Insert | 70,793 requests | ₹0.0060 | ₹424.758000 | 6.640% |
| Datastore Storage | 1.471324 GB-days | ₹0.0432/GB-day | ₹0.0635612 | 0.001% |
| Datastore Delete | 54,557 requests | ₹0.0048 | ₹261.873600 | 4.094% |
| Datastore Bulk Read | 6 datasets | ₹0.0012 | ₹0.007200 | <0.001% |
| Web Client Fetch | 5,958 requests | ₹0.000024 | ₹0.142992 | 0.002% |
| **Total supplied gross charges** | | | **₹6,396.7674332** | **100%** |

The datastore request categories total **1,641,508** operations. All datastore categories together account for approximately **99.80%** of the supplied charges. There are approximately 221 datastore Fetch units per Web Client Fetch unit, but these counters describe different services and cannot be interpreted as 221 database queries per user visit.

The billing period, taxes, free-tier credits, subscription offsets, other account projects and whether unsuccessful/repeated operations are charged are unknown. This is a total of the provided gross amounts, not a reconstruction of the final payable invoice.

Catalyst's [pricing calculations](https://docs.catalyst.zoho.com/en/deployment-and-billing/billing/pricing-calculations/) explain operation-specific billing units, including amount per request/API call for datastore insertion. Its [current pricing page](https://catalyst.zoho.com/pricing.html) also discusses database operation allowances. Neither establishes from this invoice whether a particular ZCQL aggregate/result translates into one billed Fetch unit, rows, or another accounting treatment. **Measure query counts and billing-counter deltas together.** Returning fewer rows is useful, but it is not automatically fewer billed requests.

### Savings arithmetic, not a forecast

| Verified reduction in billed Fetch units | Savings for the same period | Remaining supplied gross total if everything else is unchanged |
|---|---:|---:|
| 10% | ₹474.03 | ₹5,922.74 |
| 25% | ₹1,185.08 | ₹5,211.69 |
| 50% | ₹2,370.15 | ₹4,026.62 |
| 75% | ₹3,555.23 | ₹2,841.54 |

These scenarios do not promise the code changes below will achieve those percentages. Eliminating all supplied function compute would save only ₹12.46.

## 6. Confirmed cost drivers and recommended remedies

### COST-01 — Retry scheduling is bypassed by default

`routes/cronRoutes.js:236` passes `ignoreSchedule = !fastRecoverHonourSchedule`. In `config/env.js:128`, honoring schedules defaults off and ordinary policy defaults to retrying failures without a classified attempt/age cap. Thus fast recovery can repeatedly reattempt a failing lead even before `next_retry_at`.

At an illustrative two-minute cron cadence versus a fifteen-minute due interval, an eligible persistent failure may be attempted roughly 7.5 times as often. Every attempt involves claims, lookups, mapping reads, logs and updates, not just the dealer HTTP request. Deployed cadence/flags were not verified.

**Recommendation:** Review `OUTBOUND_RETRY_POLICY=classified`, `FAST_RECOVER_HONOUR_SCHEDULE=true`, capped attempts/age and Retry-After handling. Preserve explicit operator replay. Confirm escalation business rules before changing them.

### COST-02 — Two-minute demo SLA repeatedly processes already actioned leads

Local configuration has `DEALER_ACTION_SLA_MINUTES=2` and scope `AU008`; the plan identifies these as demo values. `slaMonitorService.js:309` claims candidates, rereads mapping/integration/lead, then rotates an already actioned lead around `:354`.

An original-source fixture with one Contacted lead produced **five sweep queries, one claim insert, one mapping update and one claim delete**, despite **zero dealer checks and zero breaches**. Its per-mapping portion is three reads + one insert + one update + one delete. Using your rates and a one-request-per-unit assumption:

```text
3 × ₹0.0036 + ₹0.0060 + ₹0.0048 + ₹0.0048 = ₹0.0264 per rotation
```

An illustrative 30-day/two-minute cycle has 21,600 ticks: **₹570.24 per continuously eligible actioned mapping**, excluding setup. Once daily would be ₹0.792 for the same per-mapping portion. Exact eligibility, timing and billed units can reduce/change these figures. They are a model, not attribution of the actual bill.

**Recommendation:** Agree production SLA minutes/scope, then redesign due eligibility/fairness to avoid repeatedly rewriting completed work. Preserve dealer-action timestamps, re-entry grace and concurrency claims; simply deleting safety claims would trade cost for duplicate/race risk.

### COST-03 — Field/status mappings are reread per lead unless a flag is enabled

`config/env.js:290` defaults `MAPPING_CACHE_PER_RUN` off. `mappingRunCache.js` already safely caches mappings within one run, retries failed reads and reloads in the next run; standalone webhooks read fresh.

For N same-dealer leads, two mapping queries per lead can become two queries per run. With N=100, this avoids up to **198 reads**, modeled as **₹0.7128 per batch** using the supplied Fetch rate. Multiply by actual processed batches, not every idle cron tick.

**Recommendation:** Verify and enable the existing per-run cache in the intended environment after checking its behavior with current mappings. This has better cost evidence than merely narrowing returned columns.

### COST-04 — Backed-off inbound replay still performs per-record lookups

`inboundReplayScheduler.js:275` loads the mapping and integration before the due check around `:320`. One synthetic failure on a sixty-minute replay interval, last retried a minute ago, made **three queries** and **zero replay attempts**.

**Recommendation:** Check durable ordinary backoff before per-lead lookups. Preserve immediate status-map-change and retention-expiry paths. Batch remaining equivalent lookups; do not drop failed history or shorten retention solely to lower cost.

### COST-05 — Work budgets do not cover all setup/subpasses

An already expired budget still caused: retry **one query**; reconciliation **two queries**; replay **one query and a FAILED→CLOSED update**. Candidate reads occur before deadlines; routing-hold and never-created loops do not consistently receive the deadline. Fast recovery can extend SLA to at least five more seconds after earlier stages consume their allowance.

**Recommendation:** Check deadlines before scans/writes, propagate a common deadline into every subpass, and report unknown deferred counts when no backlog scan was performed. Time limits on starting work do not bound an in-flight API call; downstream timeouts and durable stage workers remain necessary.

### COST-06 — Navbar and dealer-detail callers download the whole lead table

`adminDashboardService.js:106` reads all leads/dealers then filters in JavaScript. `DealerDetailsTabs.jsx:104` uses this legacy path. In a fixture, requesting a dealer's **two leads read all 650 leads in four unfiltered queries**. `NavbarSearch.jsx:49` uses a browser-local five-minute cache, then downloads unpaged leads and dealers on a miss, even before actual search text narrows results.

**Recommendation:** Put dealer/status/search predicates into database queries; return bounded suggestions; use paginated detail tabs. Avoid dealer-count aggregation when only a name/code suggestion is required. At 100,000 rows, a 200-row full scan needs approximately 500 queries; repeating it on user interactions is expensive regardless of cached browser sessions.

### COST-07 — Out-of-order polling repeats while the tab is hidden

`LeadExchangePage.jsx:1075` sets a 30-second interval with no visibility guard or single-request serialization. The endpoint rereads held-event logs and enriches records.

**Recommendation:** Pause hidden tabs, serialize refreshes and consider a two-minute cadence/manual/event refresh. A 30→120-second interval reduces automatic endpoint calls by about **75% for continuously visible sessions**; it does not reduce the entire bill by 75%. The notification bell does not poll and should not be blamed for this recurring load.

### COST-08 — Unnecessary global groups and unbounded sync-log limits

`leadListService.js:465` loads global path/status groups for path-only pages even without requested facets/scenario filters. Two such page requests reproduced two unnecessary global grouped reads. Group pagination also lacks stable ordering.

`routes/adminDashboardRoutes.js:236` accepts `Number(limit)`, while `dashboardStatsService.js:180` lacks a finite maximum. A supplied `Infinity` returned all **700 synthetic logs in three queries** rather than a bounded dashboard page.

**Recommendation:** Load groups only when needed, order grouped pages stably, and validate finite positive integer limits with a documented maximum.

### COST-09 — Alert queue materialization and concurrent deletion storms

Each enqueue reads up to 100 pending bodies; a growing 100-event batch can materialize 1+…+100 = **5,050 row results**. Every recovery tick can read up to 300 bodies before deciding the thirty-minute window has not elapsed. COR-02 also shows redundant dispatch/deletion work under concurrent enqueue.

**Recommendation:** Use due-time/oldest-timestamp probes and a single durable dispatch worker, fetching bodies only for an actual dispatch. **A COUNT-first replacement alone does not guarantee request savings:** it may still query once per insertion and add another body-fetch query at threshold. An oldest probe plus COUNT can increase calls from one to two. Optimize billable calls, not only payload size.

### COST-10 — Reconciliation has deliberate fairness writes and historical scans

Unsupported Fusion, disabled or missing-ID mappings are rotated through `last_attempted_at` writes to keep readable dealers from starvation. The never-created pass also scans the latest 300 successful-create logs and then does per-lead mapping queries, including already linked records.

**Recommendation:** Query eligible integrations up front and use a separate cursor/durable queue where appropriate; batch historical mapping resolution. Preserve ambiguous-create protection and fairness. These writes are real overhead, but removing them without replacement can starve work or duplicate leads.

## 7. Additional operational/data-quality gaps

| ID / priority | Confirmed or conditional finding | Evidence / recommended action |
|---|---|---|
| OPS-01 / P2 | “Mark all read” is incomplete; badge is not total unread. | With 250 unread fixtures, badge shows 50 and mark-all leaves 50 unread because reads are capped at 50/200. Count scoped unread separately; process bounded unread batches with continuation. |
| OPS-02 / P2 | “Clear all” silently stops at 2,000. | With 2,101 notifications, response is only `{deleted:2000}` and 101 remain. Keep bounded work but expose continuation/hasMore and preserve UI truth. |
| OPS-03 / P2 | All-time dealer error KPI can show zero for ERROR integrations. | `adminDashboardService.js:824` checks integration_status on raw dealer rows that were not enriched. Synthetic ERROR integration reports zero. Join authoritative state or define metric from consistent failure logs. |
| OPS-04 / P2 | Out-of-order panel is recent logs, not all unresolved work. | `aiAssistantToolService.js:250` samples latest 200 Unhappy-7 logs. Older unresolved events disappear; any historical RECOVERED row can outrank a later hold. Query authoritative unresolved state/paginate and use chronological transitions. |
| OPS-05 / P2 | Dealer-active rule is incomplete. | `leadSyncService.js:402` rejects missing/Removed dealers but does not establish the MG business meaning of an inactive Dealer_Stage. Q34–Q36 remain open. Confirm inactive handling and pause/release rules before changing routing. |
| OPS-06 / P2 | Mutable retry payload with a stable create key. | Creates use immutable Zoho ID, but retries rebuild latest payload. An MG edit between ambiguous attempts can reuse the key with a changed body and receive 409. Persist create intent or hold conflicts; never switch keys blindly. Vendor key-retention semantics remain Q10. |
| OPS-07 / P2 | Credential save race and encryption binding remain deferred. | `integrationAuthService.js:65` uses query-then-insert upsert, not an atomic uniqueness primitive; AES-GCM has no integration/type AAD. Concurrent first saves may duplicate absent a real composite/unique key. Q31 explicitly defers this migration. Verify constraints; plan versioned migration. |
| OPS-08 / P2 | Token 429/5xx lose useful retry diagnostics. | `fusionSdOAuthHelper.js:104` labels HTTP errors authentication failure and drops Retry-After. Synthetic 429 retains status but no retry header. Classified scheduler can infer transient status, yet lacks the required delay. Preserve sanitized header/status; keep 401 auth. |
| OPS-09 / P2 | Marketing unknown is converted to false. | `leadSyncService.js:147` stores `Receive_Offers_Updates ?? false`, losing unknown before the tri-state mapper. Whether the live checkbox can be unknown remains unverified/Q15. Preserve omission semantics if approved. |
| OPS-10 / P2 | Conversion KPI definitions do not match agreed sales outcomes. | Legacy summaries use Delivered/Test Drive/Quotation buckets despite real-MG-picklist caveats. Agree conversion/outcome definitions; operational status is not proof of a sale. |
| OPS-11 / P2 | Daily maintenance windows can repeat or be missed. | Reconciliation uses epoch-minute modulo interval <2; retention uses 16:00–16:01 UTC, assuming a two-minute cron. Jitter or different cadence can miss/repeat work. Use durable last-success/due scheduling. MG central/dealer timezone and DST rules remain open. |
| OPS-12 / P2 | Full sync/checkpoints/load readiness are conditional. | Strict snapshot/durable watermark protections default off; code still has bounded full-table snapshots. Batch 9b says isolated queue/cursor/100k–200k load tests not started. No capacity certification follows from 732 unit/regression tests. |

## 8. Feature/configuration readiness

The following protections exist in source but need verified runtime configuration. Local newer switches were unset in the inspected function config; that is **not proof they are off in the deployed environment**. Do not enable every flag blindly.

| Setting | Intended benefit | Prerequisite / caveat |
|---|---|---|
| `MAPPING_CACHE_PER_RUN=true` | Avoid repeated mapping queries within a sweep/sync. | No new schema; mappings reload between runs. |
| `OUTBOUND_RETRY_POLICY=classified` | Bounded retries of appropriate transient/local failures. | Review permanent/auth states and explicit replay expectations. |
| `FAST_RECOVER_HONOUR_SCHEDULE=true` | Respect next_retry_at/Retry-After. | Verify required delivery latency and existing schedules. |
| `ESCALATION_TRANSIENT_ONLY=true` | Avoid treating permanent/local/auth failures as dealer outages. | Agree escalation rules. |
| `CRON_WORK_BUDGET_MS` | Stop starting new work near the request deadline. | Existing setup/subpass gaps mean this alone is insufficient. |
| `ZOHO_API_TIMEOUT_MS` | Bound OEM requests/token refresh. | Timeout must fit the whole worker budget, not just one request. |
| `FUSION_RATE_BUDGET=true` | Shared approximate Fusion request budget and cooldown. | Check Cache availability and credential reuse; approximate counters are not a strict distributed limiter. |
| `CRM_API_PER_DEALER_LIMIT` | Stop one dealer occupying its CRM type's call pool. | Instance-local call pools do not prove a global vendor concurrency ceiling. |
| `SYNC_CLAIM_FAIL_CLOSED=true` | Defer processing when claims cannot be stored. | Real claims table and unique claim_key must be verified. Preserve a durable way to retry deferred OEM work. |
| `DURABLE_SYNC_CHECKPOINT=true` | Find latest clean incremental run instead of only latest twenty log rows. | Logs/retention still underpin progress; independent checkpointed-page design remains unfinished. |
| `FULL_SYNC_STRICT_SNAPSHOT=true` | Stop an incomplete local snapshot rather than treating unseen records as new. | Full snapshot still consumes memory/time; not a scale benchmark. |
| `FUSION_INBOUND_V2=true` | Flat Fusion status translation and Standard Webhooks. | Signing secret, configured vendor events and SEC-03 fix needed for strict signed-only behavior. |
| `INBOUND_EVENT_STORE=true` | Durable encrypted Fusion payload/replay/leases. | webhook_events payload_encrypted, external_lead_id, attempt_count, lease_until columns; key management. |
| `SLA_DEALER_ACTION_CLOCK=true` | Separate dealer-action time from OEM updates. | last_dealer_action_at column; existing fallback/rotation caveats. |
| `FUSION_CHANGES_ONLY_PATCH=true` | Avoid full resend and preserve dealer-owned changes. | Encrypted last_sent_payload column; missing/oversized snapshots fall back. |
| `KEEP_OUTBOUND_RETRY_ON_INBOUND=true` | Retain pending OEM outbound updates during dealer inbound changes. | Review across all CRM types, especially concurrent updates. |
| `LEAD_NAME_PARTS=true` | Preserve first/last name independently. | first_name and last_name columns must exist before writes. |
| `WEBHOOK_EVENT_RETENTION_DAYS` | Retain/delete old SUCCESS events per policy. | Approved retention; channel proof must not disappear with last event; deletes also have a cost. |
| `FUSION_TOKEN_RETRY=true` / token timeout | Retry a token call that got no response before a lead request. | Does not fix token HTTP-throttle diagnostics or end-to-end budget. |

## 9. Dependency audit

Fresh `npm audit --json` against the unchanged lockfiles reported:

| Project | Critical | High | Moderate | Low | Total affected package entries |
|---|---:|---:|---:|---:|---:|
| Backend | 1 | 3 | 2 | 0 | **6** |
| Frontend, including development/build dependencies | 2 | 73 | 36 | 3 | **114** |

These totals count affected package entries and dependency effects; they are not 120 independently exploitable application defects.

| Backend locked package | Reported severity | Assessment |
|---|---|---|
| axios 1.19.0 | High | Multiple request/prototype/transport advisories. Review a patched release and all adapter transports. |
| multer 2.3.0 | Moderate | Upload-related advisory. Actual routes use memoryStorage; confirm applicability of disk-write condition rather than assuming exploitability. |
| nodemailer 9.1.1 | High | Parser/DNS advisories; audit recommends a major-version update. Review email compatibility and input paths. |
| proxy-addr 2.0.7, transitive | Critical | Patched at 2.0.8; advisory requires specific trust-proxy subnet conditions. Those were not demonstrated in this Express app. See the [maintainer advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h). |
| qs 6.15.3, transitive | Moderate | Resolve through reviewed dependency refresh and route/body regressions. |
| xlsx 0.18.5 | High, audit offers no npm fix | Particularly relevant: `onDemandAiService.js:68` reads uploaded spreadsheets. The [SheetJS advisory](https://cdn.sheetjs.com/advisories/CVE-2023-30533) describes malicious-file prototype pollution; choose a vetted fixed distribution or maintained parser, rather than assuming npm audit fix resolves it. |

Frontend direct affected entries include axios, react-router-dom, react-scripts, tailwindcss and the Catalyst React plugin. Critical transitive entries include proxy-addr and shell-quote. Much of the count belongs to the CRA/build tooling tree; separate shipped browser behavior from build/development exposure before prioritizing.

**Recommendation:** Review upgrades in isolated changes with lockfile diffs and relevant regression/build checks. Avoid `npm audit fix --force` as an automatic remedy: the output suggests incompatible major versions and even `react-scripts@0.0.0`, which is not a sensible application migration plan. No package changes were made here.

## 10. Recommended work order and acceptance criteria

| Order | Work | Evidence required before calling it fixed |
|---|---|---|
| 1 | Legacy route authorization, notification ownership, signed-only Fusion V2 and credential destination checks. | Negative authorization/signature/SSRF tests; real datastore permission review; no credential-bearing call to a disallowed host. |
| 2 | Confirm historical secret rotation; address relevant vulnerable runtime dependencies and PDF parser. | Revocation evidence, reviewed lockfile, uploaded-file regression, Node 20 suite/build. |
| 3 | Fix >300 SLA coverage and alert dispatch concurrency. | >300 dealer fixture; concurrent enqueue/cron/crash tests; one coherent batch state and no false return-channel breach. |
| 4 | Verify runtime flags, production SLA and scheduler overlap; respect retry due times and enable run mapping cache where appropriate. | Sanitized env/scheduler inventory, actual request counts per run, correct recovery/escalation timeline. |
| 5 | Replace legacy full-table search/detail reads, unbounded limits and hidden-tab polling; tighten replay/deadline work. | Query-count assertions, scoped response checks, bounded work on expired deadlines, no missing retained replay path. |
| 6 | Durable scheduling/checkpoints, credential-save migration, agreed field ownership/status/outcome rules. | Migration/rollback plan, business decision owners, real schema constraints and controlled dealer verification. |
| 7 | Isolated load/drain-rate and bill measurement. | 100k/200k dataset tests with CRM stubs; measured peak latency/queue age/memory/API rates; billing-counter reconciliation. |

For cost attribution, record sanitized operation counters by endpoint, service stage, table and run: queries, rows returned, inserts, updates, deletes, retries due/backed off, candidates skipped/actioned, duplicate events, cache hits and elapsed time. Prefer structured logs/metrics; writing a telemetry datastore row for every query would itself add billable activity. Compare matched billing windows and normalize by actual leads/updates/users; a quiet week is not proof an optimization worked.

Useful outcome measures: reads per changed lead, datastore writes per successful delivery, retries per recovered lead, recurring operations on idle data, bills per 1,000 leads, oldest pending age and duplicate-create count. Keep reliability measures beside cost so reduced polling does not conceal delayed or lost work.

## 11. Validation record

| Check on restored source | Result | What it establishes |
|---|---|---|
| Backend `npm test`, with local listener/DNS access | **732 pass, 0 fail** | Covered existing regression paths pass. |
| Node 20.20.2 direct `node --test test/*.test.js` | **732 pass, 0 fail**; approximately 12.3 seconds | Existing suite passes on configured runtime. |
| Frontend `npm run build` | **Pass, 18 lint warnings** | Production compilation succeeds. Warnings include BOM/unused bindings and two hook-dependency warnings; not all are cosmetic. |
| Backend dependency audit | Exit 1, six affected package entries | Current advisories affect unchanged locked dependencies; exit 1 is the findings result. |
| Frontend dependency audit | Exit 1, 114 affected package entries | Includes runtime and development/build tree. |
| Synthetic signature/SSRF/body/token probes | Findings reproduced | Mocked external dependencies; no vendor/server/data writes. |
| Synthetic replay/SLA/alert probes | Findings reproduced | Original-code query/write counts, >300 gate gap and duplicate digests. |
| Synthetic portal/notification probes | Findings reproduced | Full scans, limit bypass, ownership/completeness/KPI defects. |
| Final `git diff --stat` | Empty | Tracked source/tests match starting revision. |

Initial sandbox attempts failed when HTTP tests could not bind loopback or fixtures could not resolve the QA hostname. Those were rerun with permitted access. A separate adapter-only sandbox run had 12 DNS-dependent failures, superseded by the successful full restored suites; it is not reported as an adapter regression. Some fixtures depend on real DNS even with HTTP mocked, so better test isolation is recommended.

Fresh successful test evidence is in `/private/tmp/mg-motor-audit-original-tests.log` and `/private/tmp/mg-motor-audit-node20-tests.log`; build evidence is `/private/tmp/mg-motor-audit-original-build.log`. Dependency JSON and synthetic evidence are also in `/private/tmp`. Temporary logs are supporting session artifacts; the findings/results needed to read this report are included above.

Suggested later verification commands, after authorized fixes:

```sh
cd functions/mg_motors_au_function
npm test
npm audit --json
cd ../../mg-motor-web
npm run build
npm audit --json
```

## 12. External decisions still needed

Technical questions that the supplied documents answer should be closed with those documents as evidence: OAuth flow, ten-minute lifetime, Basic credentials, POST/PATCH paths, flat webhooks, required usable contact, documented Fusion statuses and nominal rate limit. They do not all require another vendor question.

The following remain material:

- **MG:** approved live dealer/status matrix; missing/invalid/inactive dealer handling; production SLA and delivery latency; status/outcome/conversion definitions; first/last-name/contact requirements and field editing ownership; Retail/Fleet/Demo outcomes; central/dealer timezone/DST; retention/alert recipients; CRM-switch migration and AutoPlay scope.
- **Fusion:** current production dealer configuration and valid contact example; signing-secret encoding and a real signed sample; idempotency retention and changed-body recovery; agreed manual/ignored update behavior; production credential scope/rate accounting; outcome/test-drive/activity mappings.
- **Deployment owner:** actual revision/flags/schema/constraints, approved Zoho hosts, schedules/timeout, credential rotation, Cache availability, invoice dates/counter semantics and table/endpoint usage attribution.

Until those are verified, mark production rollout/capacity and achieved cost savings **Not Verified**.

## 13. Detailed vendor and workbook cross-verification

The following appendix records contract and field-level evidence. Its conditional implementation descriptions do not override the defects and limits above.

### Document provenance and consistency

| Document | What was actually inspected | Implication |
|---|---|---|
| `lead-api-mg-motors-guide.pdf` | 11 physical pages; generated **29 September 2026, 23:35:44**; MG Motors → MG Motors Sandbox | This is the supplied guide. It has native fields and an error table, but no signed-webhook section. |
| `FUSION_SD_AUDIT.md` | D2 references **`lead-api-mg-motors-guide 7.pdf`**, generated 8 October, 14 pages | That is a different file. Its PDF page references and claims about D2 webhook sections cannot be attributed to the supplied 11-page PDF. The YAML does independently document webhooks. |
| `lead-api-mg-motors-openapi 3.yaml` | OpenAPI 3.1; version 1.0.0; dealer-specific Sandbox export | A valid contract snapshot; not evidence of production host, live mappings or enabled dealer triggers. |
| `CRM fields for Exchange.xlsx` | Sheets `MG CRM Matrix` (21 rows, 8 columns) and `Fusion SD Map` (19 rows, 21 columns) | Business requirements and proposed field/status mappings. Does not prove live admin mappings match the default preset. |
| `MG_Motor_AU_External_Clarifications.md` | Pending questions and decision register | Many questions are partially answered by the supplied YAML/PDF or later remediation decisions. An old “Pending” label must not override later recorded answers. |
| `FUSION_REMEDIATION_PLAN.md` | Later answers Q1–Q36 and implementation notes through Batch 11 | Explains why current code intentionally differs from the initial spreadsheet. Its prior read-only live observations were not independently rechecked against production in this audit. |

A notable vendor-document inconsistency remains: PDF p2 says create needs **a first or last name plus a usable phone or email**; the YAML `AmsProLead` description says nothing is mandatory other than at least one recognised field (line 1445), yet its 422 `missing_contact` error documents contact rejection. Do not interpret optional OpenAPI properties as permission to create a contactless lead. Resolve against the actual dealer validation and a sanitized successful request.

PDF p3 describes the older `enquiry_updated` result, while YAML `LeadUpdated` (line 1890 onward) uses `update_mode`, `enquiry_linked`, `updated_fields`, `ignored_fields`. Current code follows the YAML. If a dealer still returns the old field, it is not summarized by `summarizeLeadUpdated` and the UI may omit that diagnostic; the underlying recorded submission is not automatically a failed request.

### Vendor contract versus current implementation

| Contract item | Supplied evidence | Restored code and verdict |
|---|---|---|
| Base and OAuth path | `{host}/api/leadapi`; `/oauth2/token` | `fusionSdOAuthHelper.js:49` appends token path to configured prefix. Correct only if the dealer `base_url` includes `/api/leadapi`. |
| Client-credentials authentication | PDF p1; YAML lines 26–58: Basic access key/secret, form body `grant_type=client_credentials`, 600 seconds | `fusionSdOAuthHelper.js:62` uses correct Basic and form body. Cache uses documented 600-second fallback and refresh margin at most half lifetime (`:118`). Per-integration single-flight avoids duplicate refresh in one process. No full distributed token cache is claimed. |
| Scopes | `leads:write`, `leads:update`; omitting scope grants held scopes | Omission is supported, not an auth defect. Token-only `testConnection` proves endpoint/keys, not lead creation permission, update permission, dealer mapping or actual enquiry application. |
| Lead POST shape | Nested `contact`, `requirement`; POST `/v1/leads`; `application/json` | `fusionSdAdapter.js:152` expands dotted admin targets; `:265` posts. This corrects the old flat-target problem. Reserved prototype segments and parent/child mapping collisions are checked. |
| Usable contact / 422 | PDF p2 and YAML missing_contact | Default preset maps first/last name, email, phone. Name parts require `LEAD_NAME_PARTS` and schema columns; otherwise full name is sent as first name. Old live hand-mapped fields described in the plan may still be invalid until re-saved. The contract is now substantially understood; a current live 422 cannot be blamed on Fusion without the exact sanitized body and dealer mapping. |
| Record identity | Required `201` JSON `lead_id`; store permanently | `fusionSdAdapter.js:330` trusts `lead_id` or a plausible `/v1/leads/{id}` Location, not arbitrary id/plain text/HTML. `crmIntegrationService.js:1148` parks Fusion accepted-without-ID as `ACK_UNRESOLVED` and prevents ordinary re-create. Old audit C1 is substantially fixed for Fusion. Generic/Zoho missing-ID handling is deliberately not extended (plan Q12). |
| Duplicate prevention | YAML Idempotency-Key max 128; identical retries reuse key, different body gives 409 | `crmIntegrationService.js:1137` uses the immutable Zoho record ID for create. It still builds a new payload from the latest lead on each retry; no durable immutable create intent exists. An intervening MG edit can reuse the same key with a different body. Classified retry policy stops the 409; legacy policy may continue. Retention/recovery semantics remain Q10. A key must not be changed just to suppress a conflict after an ambiguous acceptance. |
| PATCH | RFC 7396; `/v1/leads/{lead_id}`; merge-patch content type | `fusionSdAdapter.js:386` implements the correct verb/path/content type and encodes record ID. Changes-only behavior requires `FUSION_CHANGES_ONLY_PATCH` and usable encrypted `last_sent_payload` storage. Flag off/missing snapshot falls back to a full mapped payload. |
| Clear semantics | RFC 7396 null clears | Plan Q32 intentionally says emptied MG fields leave Fusion unchanged. Therefore current omission of clears is an approved application rule, not accidental failure to implement RFC 7396. Product behavior should disclose this rule. |
| Recorded versus applied update | YAML `update_mode:manual` and ignored fields | Adapter summarizes these; orchestrator records them in log `dealer_response`. Disabled updates return skipped and failed mappings become HELD (`crmIntegrationService.js:861`). Old “403 marked delivered” finding is fixed. `SYNCED` still means submission recorded; a manual/ignored result does not certify live enquiry application. |
| Errors / retry | PDF p11: 429/5xx retry; unchanged 4xx do not. YAML Retry-After | Fusion lead-request diagnostics retain status/type/instance/Retry-After (`fusionSdAdapter.js:122`). Classified bounded retries are flag gated. **Token** 429/5xx still get auth labels and lose Retry-After (`fusionSdOAuthHelper.js:104`), a remaining inconsistency. |
| 409 lead_not_ready | PDF p11 says fix/re-send, not unchanged auto retry | New shared classifier treats it permanent, matching the guide. `fusionSdAdapter.js` comment around line 358 still calls it transient: a stale comment, not reliable current behavior. |
| Rate | YAML 300/60s **per credential**, shared POST/PATCH; 32 KB | Shared rate-budget mitigation exists behind a flag, keyed by integration. It is approximate, not an atomic global limiter. Credentials reused across integrations must share one effective budget. The body-size helper has a confirmed remaining guard failure below. |
| GET / search | No GET lead/list/search endpoint in supplied contract | `getLead` correctly throws unsupported; capabilities explicitly deny read and duplicate search. Do not invent a read endpoint. Recovery must use stored event replay or an agreed vendor mechanism. |
| Incoming event shape | YAML flat PushedLead with `lead_id` and dealer status, nullable fields | `fusionSdInbound.js:35` translates only status plus timestamp under `FUSION_INBOUND_V2`. This follows Q16. No-status activities/messages are acknowledged without a CRM update (`crmIntegrationService.js:1815`). |
| Incoming authentication | YAML requires id, timestamp, Standard Webhooks signature over exact bytes, five-minute freshness | Signed verification is implemented, **but may be bypassed by supplying only a valid legacy static token even with V2 enabled**. See confirmed high-severity finding below. |
| Dealer identity | YAML dealer_id may be provider's own or Fusion's ID | Q18 deliberately logs unfamiliar identity, rejects another known MG dealer; do not insist every Fusion dealer_id must equal its MG code. Secret isolation remains essential. |
| Activities / test drives / trade-ins | Native fields documented; minimum fields needed to create those side records | Default preset has no dedicated activity/testdrive/trade-in orchestration. Arbitrarily mapping `enquiry_outcome` to `activity.subType` cannot implement Retail/Fleet/On-Sold Demo and may lack `activity.startDate`. This is an approved scope gap awaiting MG/vendor business rules, not proof generic adapter lacks POST capability. |
| Conversation messages | YAML PATCH messages accepted separately from field mappings | No dedicated typed conversation workflow is implemented. A generic mapped payload alone is not end-to-end conversation support. Nonstatus incoming messages are intentionally ignored for MG. |
| AutoPlay | Handover treats as planned | Factory has GENERIC_REST, ZOHO_CRM, FUSION_SD only; unsupported CRM types fail closed. No production AutoPlay support can be claimed. |

### Spreadsheet field crosscheck

The workbook calls all of these mandatory unless qualified below. Its input examples and spelling should be preserved as stakeholder evidence, not silently treated as the current Zoho field metadata.

| MG field | Exact API name / rule | Current default Fusion coverage / caveat |
|---|---|---|
| First name | `First_Name`; text incl special characters; mandatory; dealer editable | `first_name → contact.firstName`. Preset required=false; individual first name not enforced by general customer-name validation. Source storage depends on name-part flag. |
| Last name | `Last_Name`; mandatory; dealer editable | `last_name → contact.lastName`, required=false. Flag-off fallback omits last name. Workbook is stricter than Fusion's first-or-last minimum. |
| Email | `Email`; must contain @; mandatory; dealer editable | `email_address → contact.email`. Fusion receives it; non-Fusion dealer inbound defaults protect email against changes, contrary to workbook permission. |
| Mobile | `Mobile`; 10 digits; mandatory; dealer editable | `mobile_number → contact.phone`. MG validation/format policy differs from Fusion's stored bare digits; non-Fusion inbound mobile protected by default. |
| Postcode | `Postcode`; 3–4 digits; mandatory; dealer editable | `postcode → contact.areaCode`; native field exists and separate phoneCode exists. Do not label postcode mapping defective merely from the name “areaCode.” |
| Marketing | `Receive_Offers_Updates`; Boolean; mandatory; dealer editable | Corrected preset sends `contact.marketingOptinEmail`, not `contact.optinEmail` (digital consent). However source import converts absent/null to false (`leadSyncService.js:147`), so unknown consent is lost before tri-state mapper. Q15 remains open. |
| Privacy | `Accept_Privacy_Polic`; Boolean; mandatory; dealer NOT editable | Internal true-consent gate holds false/unknown. Preset sends nonnative `privacy`; YAML has no native privacy property, Fusion records digital consent separately. Do not assume this arbitrary property is applied without a dealer custom mapping. |
| Enquiry status | `Lead_Status`; workbook list below; mandatory; dealer editable | Mapped as `enquiryStatus`; defaults and newer MG metadata are resolved directionally. Latest plan intentionally overrides initial workbook Update Pending → Open. Live saved rows are not automatically replaced by code presets. |
| Nature of Enquiry | `Nature_of_enquiry`; mandatory; dealer NOT editable | `nature_of_enquiry → leadSource`. Initial workbook requested sharing MG's value. Fusion display requires dealer enum recognition. Other dealers' generic inbound mappings can still alter this unless ownership rules prevent it (Q27). |
| Lead source | `Lead_Source`; mandatory; dealer NOT editable | Derived `enquiry_channel → enquiryType` covers source channel according to Q2; actual raw MG lead source is not a separate default Fusion field. Non-Fusion ownership discrepancy remains Q27. |
| Lead outcome | `Enquiry_Outcome`; mandatory when available; dealer editable | Omitted by approved Q1 until Retail/Fleet/Demo and activity meaning resolved. Won/Delivered alone cannot identify which order category MG requires. |
| Timestamp | No API name in workbook; system only | Internal delivery/action timestamps and copied pushed_at exist; not a direct editable MG field. Action clock is flag/schema gated. |
| Department | `Lead_Department`; Sales/Service/Parts/Customer Care/Marketing/Aftersales/General; mandatory; dealer editable | No agreed native Fusion department mapping in default preset (Q27/Q29). Do not reuse `origin` as department. |
| Model | `Enquiry_Model`; mandatory when available; global-list mapping; dealer editable | `vehicle_model → requirement.model`; mapper required definition exists but empty values allowed by optional-delivery rules. Global-list correspondence remains onboarding data, not verified from source. |
| Variant | `Variant`; mandatory when available; global-list mapping; dealer editable | Stored/internal MG field exists, no default Fusion outbound mapping or status-only inbound coverage. |
| Powertrain | `Enquiry_Powertrain`; mandatory when available; global-list mapping; dealer editable | Same scope gap as Variant. |
| Customer message | `Message`; optional, 2000 characters, customer notes only; dealer NOT editable | No customer-message entry in current default Fusion preset. Workbook permission is stricter than generic reverse mapping of configured message fields. |
| Zoho record ID | Mandatory; neither MG nor dealer editable | Used internally as stable reference; fallback refID uses `enquiry_id` when present, otherwise `crm_record_id`. A customer-editable arbitrary identifier must not replace it. |

Workbook MG statuses: `Update Pending, Not Contacted, Contacted, Contact in Future, Not Qualified, Dropped, Lost, PMA Unassinged, Dealer Unavailable` (including workbook's misspelling).

Workbook Nature of Enquiry: `Test Drive, Pre-Order, Finance Enquiry, Service Booking, Request a Quote, Product Enquiry, Fleet Enquiry, General Enquiry, Get in Touch, Registger Your Interest` (including spelling).

Workbook Lead_Source: `OEM Drivechat, MG AU Website, OEM Event, OEM Marketing Activity, OEM Sponsorship, OEM AU Website`.

Workbook outcome: `Test Drive, Retail Order, Fleet Order, On-Sold Demo, Lost, Outcome Pending`.

Fusion YAML enquiry statuses: `Open, Won, Delivered, Lost, Prospect Lost`. Workbook initially maps Update Pending/Not Contacted/Contacted/Contact in Future→Open; Not Qualified/Dropped/Lost→Prospect Lost; PMA Unassigned and Dealer Unavailable→none. Later Q1 keeps Update Pending MG-only and intentionally leaves Fusion Won/Delivered unchanged in MG, while Q26 uses actual MG `Lost Lead`. Current frontend preset (`DealerCRMConfig.jsx:224`) follows these later decisions and adds Follow-up/Pre-Qualified/Finance Intro. `Finance Intro→Open` is explicitly documented as an assumption still awaiting MG confirmation. A newer authoritative picklist is required; the workbook is not a substitute for current metadata.

## 14. Authorized local remediation — current status

**Authorization:** Your subsequent “Do it” instruction superseded the earlier read-only restriction for local source changes. This section describes the final local implementation. Nothing was deployed, no existing credentials were rotated, no datastore schema or live records were changed, and no production scheduler configuration was edited.

### Implemented fixes

| Finding | Delivered local behavior | Verification |
|---|---|---|
| SEC-01: legacy authorization/keys | All inline dealer/lead reads require admin/view roles; mutations require admin roles. Read responses omit dealer APIKey. Keys use 32 cryptographic random bytes. PUT whitelists fields and preserves the path ROWID. Legacy page sizes are restricted to 1–200. | `legacyRoutesAccess.test.js` tests dealer/unknown/anonymous rejection before database access, permitted view reads without secrets, mutation denial, key generation and ROWID/secret injection. |
| SEC-01: legacy outbound delivery | Shared validated HTTPS transport, pinned DNS, no redirects/proxy diversion, 15-second timeout, bounded outbound body. Dealer responses are streamed and immediately closed after headers; only HTTP status is used. | Legacy tests verify private destinations receive no call and success/error status handling never reads a streaming body. |
| SEC-02: notification ownership | Read/delete mutations resolve the requested numeric ROWID within the authenticated recipient scope. Unknown roles never match empty role broadcasts. Already-read rows avoid a redundant write. | `notificationAccess.test.js` covers foreign/own/role recipients and write avoidance. Existing shared role-broadcast behavior is preserved. |
| SEC-03: signed Fusion inbound | Every Fusion V2 request requires valid Standard Webhooks authentication, including when a legacy token is supplied. Legacy mode retains its supported token behavior. | Missing-signature, stale/tampered body, signature rotation and flag-off compatibility regressions. |
| SEC-04: safe HTTP/Zoho destinations | Shared HTTP helper validates public addresses, binds resolved DNS to the real Axios HTTP transport, refuses changed origins, disables redirects/proxies and reuses TLS connections. Dealer Zoho API/OAuth endpoints must use exact supported official HTTPS hosts before credentials are read. OAuth credentials use the form body. | `safeHttp.test.js` and `zohoEndpointSafety.test.js`, including actual transport/DNS-binding behavior, private/mapped addresses and deceptive hosts. |
| COR-01: SLA coverage | Fusion integration lookup is paginated and ordered, fails closed on incomplete reads, respects dealer scope, and checks candidate integrations absent from the lookup. | More-than-300 coverage, later-page errors and candidate-coverage cases. Healthy non-Fusion processing is retained. |
| COR-02: duplicate alert dispatch | Actual dispatch takes a fail-closed durable lease before re-reading the batch. Separate sent receipts preserve accepted-batch IDs across stale-lease recovery and partial deletion. Later cleanup does not email a persisted sent batch again. | Concurrent independent module instances near threshold now send one mocked email and delete one batch; tests cover unavailable claims, stale leases, partial cleanup and receipt storage failures. |
| COR-03: signed-channel provenance | A successful signed webhook records a small durable proof, independent of webhook-event retention. It is bound to current signing-secret fingerprint and dealer identity. A duplicate proves the channel only if freshly signed and its exact body matches a stored SUCCESS. | Proof persists after event deletion, invalidates on secret rotation/reassignment, does not rewrite on steady traffic and cannot turn successful processing into a failed acknowledgement. |
| COR-04: Fusion payload size | Final nested UTF-8 body size is checked. Only selected notes/message text can be shortened; contact/ID/enum fields are protected. An untrimmable oversized body is held as FIELD_MAPPING_INVALID. | Structured oversized messages, UTF-8 limits, protected contact fields and ordinary valid bodies. |
| COR-05: PDF/file parsing | Uses PDFParse v2 getText/destroy with cleanup on success/error. Limits uploads to 10 MB, restricts supported types, extracts at most 60 spreadsheet rows/8,000 characters, and labels sampled input in the AI prompt. | A genuine synthetic PDF, XLSX/XLS/CSV parsing, total row count, wide one-row CSV, rejected input and cleanup failure tests. |
| COST-01/03: safe defaults | Fast recovery respects next_retry_at by default; per-run mapping cache defaults on. Explicit false remains an operational compatibility override. Claim processing also now fails closed by default. | Default/override tests and existing retry/mapping/concurrency regressions. Classified retry policy remains explicitly configured rather than silently changing its business caps. |
| COST-04/05: backoff/deadlines | Ordinary backed-off replay checks happen before per-lead mapping/integration reads. Expired sweeps perform no setup queries/writes. Routing-hold and never-created subpasses receive deadlines. | Synthetic request-count, expiry, fairness and retained-release tests. |
| COST-05: recovery-stage fairness | Fast recovery shares a start-based deadline capped at 25 seconds, including SLA/alerts. It does not extend spent requests. Due maintenance runs first; the four recurring stages rotate first position across documented two-minute slots. | Sustained simulated backlog consumes the whole budget but each recurring stage gets first use once across four successive two-minute slots. Production cadence still needs verification. |
| COST-06/08: portal reads | Legacy dealer/status predicates run in SQL. Navbar uses bounded scoped suggestions, projected rows and a lightweight dealer directory. Path-only pages skip unnecessary grouped reads; grouped pages have stable order; sync logs cap at 500. | `portalReadCost.test.js` and `searchSuggestions.test.js`; existing pagination, facets, role and route regressions. Complete legacy list responses remain available. |
| COST-07: hidden/overlapping polling | Out-of-order refresh runs every 120 seconds while visible and serializes requests, sharing ongoing work with manual refresh. | Visibility, slow response, manual refresh and unmount tests. |
| COST-09: alert idle work | Empty/recent timed queues use one bounded oldest-row read and no claim writes. Bodies are fetched only for actual dispatch. Immediate threshold is constrained to 1–300 so impossible >300 thresholds cannot repeatedly acquire claims without sending. | Quiet-period, spent-budget, threshold 301/302, concurrent dispatch and bounded cleanup tests. COUNT after enqueue is a payload optimization, not claimed as fewer billable requests. |
| OPS-01/02/03: notification/KPI completeness | Full scoped unread count; bulk processing up to 2,000 with explicit hasMore and UI continuation. Older unread entries can be loaded. All-time dealer errors use actual integration state. User/role epochs prevent stale async actions restoring another actor's notifications. | 250/450/2,101 backlogs, ≤5 concurrent writes, recipient isolation, continuation, actor-change failures and ERROR-integration KPI cases. |
| Additional checkpoint safety | OEM work skipped due to a busy/unavailable claim makes the sync run incomplete. Its records_failed count prevents clean incremental progress advancing past a lead that was never stored. | Busy-claim incremental and full-sync concurrency regressions; no duplicate force-processing. |
| OPS-08: useful error classification | Token 429/5xx and network errors retain temporary-failure status/Retry-After. Missing credentials are AUTH, and unreadable credentials have a permanent configuration error code. | Token error, cooldown, classifier and existing recovery tests. |

### Dependencies and final checks

Backend axios, multer and nodemailer were updated to patched releases. SheetJS is pinned to the maintainer's official 0.20.3 tarball with lockfile integrity; compatible transitive updates resolved proxy-addr/qs findings. This retains existing XLS/XLSX/CSV APIs. The major Nodemailer update is covered by the mocked email regressions; a real staged SMTP check remains appropriate before rollout. Installation followed the [official SheetJS distribution instructions](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).

Compatible frontend lockfile updates patched runtime dependencies and removed the two critical findings. No forced build-tool major migration was attempted. Generated frontend dependency directories were read-only, so their owner-write directory permissions were restored for npm; source/file permission modes were not changed by that repair.

| Final check | Result |
|---|---|
| Complete backend suite on Node 20.20.2 | **833 passed, 0 failed**; baseline was 732. |
| Frontend Jest suites | **18 passed, 0 failed**, 3 suites. |
| Production frontend build | **Pass**; existing lint warnings remain. |
| Backend npm audit | **0 known findings**; baseline 6, including 1 critical. |
| Frontend npm audit | **100 affected package entries: 63 high, 34 moderate, 3 low, 0 critical**; baseline 114, including 2 critical. |
| Diff whitespace check | **Pass**. |

Final logs: `/private/tmp/mg-remediation-final-backend-tests.log`, `/private/tmp/mg-remediation-final-frontend-tests.log`, `/private/tmp/mg-remediation-final-frontend-build.log`, and `/private/tmp/mg-remediation-{backend,frontend}-audit.json`.

The remaining direct frontend findings are in react-scripts, Tailwind and the Catalyst React plugin/dependency trees. Removing them needs a reviewed build/deployment-tool migration. The audit's suggestions include incompatible replacements such as react-scripts@0.0.0; forcing that is not a valid fix. No claim is made that the remaining 100 entries are all exploitable in the shipped browser app.

### Measured cost improvement versus production savings

| Synthetic scenario | Baseline | Local fix |
|---|---|---|
| Dealer's two leads among 650 | Four unfiltered lead queries | One scoped lead query |
| Two Happy/Unhappy-only pages | Two global grouped reads | Zero global grouped reads |
| Navbar match among 650 leads | Downloaded 650 complete lead rows | Five projected matching rows in one lead query, plus dealer-directory lookup |
| Same-dealer mappings within one batch | Repeated reads per lead | One field/status read pair per run by default |
| Backed-off ordinary replay | Mapping/integration lookups despite no attempt | No such per-lead reads while backed off |
| Already expired recovery budget | Setup queries and some writes | No setup queries/writes |
| Three concurrent enqueues near 100 threshold | Three emails / 300 overlapping queue deletes | One email / 100 queue deletes in the reproduced case |
| Visible automatic panel refresh | Every 30 seconds | Every 120 seconds; hidden tabs pause |

These results are regression evidence, **not a rupee-saving forecast**. Recipient authorization/counting, truthful full backlogs, durable alert receipts and signed-channel proof add necessary database operations. Navbar directory cost still scales with dealer count; distinct terms can create requests on a small dataset. Invoice savings must be measured after a controlled deployment using the attribution plan in section 10.

### Required deployment checks and compatibility changes

1. Verify the existing `outbound_sync_claims` table, the **real UNIQUE claim_key constraint**, and `request_reference` capacity sufficient for up to 10,000 characters. Durable alert receipts can hold 300 row IDs; a short Varchar column is insufficient. Missing claim storage now defers work instead of bypassing protection. No new schema is assumed merely because tests emulate it.
2. Preserve rows with `proof:fusion-return-channel:*` and `operation:integration-alert-dispatch:receipt:*` keys during claims maintenance. They are durable evidence, not abandoned outbound leases.
3. Audit legacy-route consumers and permissions. Dealers now use scoped dealer APIs; view users cannot mutate legacy records or retrieve keys.
4. Validate dealer Zoho API/OAuth hosts against the supported official datacenter hosts. A historical arbitrary third-party host will now be rejected. Confirm that correction and token revocation before rollout.
5. Before Fusion V2 rollout, configure genuine signed vendor events. Static-token-only V2 calls now fail authentication. Each dealer must establish fresh signed SUCCESS proof under its current key before SLA monitoring applies; historical token-only events do not qualify.
6. Review source-default changes against deployed flags: mapping cache, honoring retry due times and fail-closed claims now default on. Explicit false is an override; classified retry/escalation, rate budget, name-part/event/snapshot/action-clock schema flags remain independently configured.
7. Verify the documented two-minute fast-recovery cadence or use the dedicated stage schedules. A differently synchronized cadence can change rotation opportunities. The 25-second budget bounds starts, not every in-flight HTTP/SMTP operation; downstream limits and real queue-drain measurements still matter.
8. Validate real SMTP and controlled dealer create/update/replay on a staging environment, and compare matched billing windows. Local tests did not send mail or mutate vendor systems.

### Remaining work, explicitly not represented as fixed

- Historically exposed secret revocation/rotation and live datastore/schema/role checks require deployment-owner evidence.
- Production SLA minutes/scope, inactive dealer rules, consent unknown semantics, status ownership, conversion/outcome definitions, AutoPlay and Australian timezone/DST remain business/vendor decisions. The two-minute demo SLA was not silently changed.
- Immutable create-intent/changed-body idempotency recovery, credential-save atomicity/AAD migration, independent durable checkpoint/page workers, complete authoritative out-of-order state and durable maintenance scheduling require further design/migration work. Existing recent-log panels are not certified as the full unresolved backlog.
- Frontend build/plugin dependency advisories and the existing lint warnings remain. A tooling migration must preserve Catalyst build/deploy behavior.
- Compressed workbook expansion and parser CPU time are not fully bounded by the 10 MB input / 60-row / 8,000-character limits. Isolated upload workers/time/memory limits merit a separate implementation.
- SMTP acceptance followed by crash or failed receipt persistence remains ambiguous. The new lease/receipt logic addresses overlapping dispatch and recoverable partial deletion; **it does not promise exactly-once SMTP delivery**. Lease expiry assumes work does not outlive five minutes.
- Production capacity, vendor limits across reused credentials/multiple instances, and achieved bill reduction remain **Not Verified** until measured.

## 15. Subsequent end-to-end re-verification

The requested fresh review of the remediated working tree is recorded in [MG_Motor_AU_End_to_End_Reverification.md](MG_Motor_AU_End_to_End_Reverification.md). Fresh validation still passes 833 backend tests, 18 frontend tests and the production build; dependency audit results remain zero backend and 100 frontend affected entries.

Additional synthetic failure cases nevertheless confirmed 11 remaining findings: a Zoho watch-registration destination bypass; current consent/ownership failures across reassignment; deleted leads being retried and revived; dealer mutations authorized by stale mappings despite a view-only current role; incomplete Zoho webhook batches acknowledged without durable failed work; interacting scheduler rotations that starve valid retries; stale Zoho tokens after configuration changes; a notification tab race; repeated unresolved mapping replays; SLA proof preflight exhausting the budget; and sent-alert cleanup blocking new mail.

The linked report contains exact code references, trigger conditions, observed results, required corrections and acceptance tests. No further application changes or production mutations were made during that re-verification. Section 14's implementation record must not be interpreted as closing these newly demonstrated gaps.

## 16. Follow-up E2E remediation delivered

E2E-01 through E2E-11 from the subsequent re-verification now have local fixes and regression coverage. The complete backend suite passes 916 tests; frontend Jest passes 28 tests; the production build succeeds with its 18 existing lint warnings.

See [MG Motor AU — E2E remediation results](MG_Motor_AU_E2E_Remediation_Results.md) for the finding-by-finding implementation, validation evidence, datastore cost tradeoffs, claim-key rollout requirements and remaining broader limitations. The original sections remain historical audit evidence, not a statement that these 11 defects are still unpatched.
