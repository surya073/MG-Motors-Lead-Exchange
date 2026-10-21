# MG Motor AU — end-to-end re-verification

**Review date:** 14 October 2026  
**Source:** current local working tree, including the authorized remediation applied after `6e83308`  
**Original review verdict (before the follow-up fixes):** Material gaps remain; passing tests alone are not production sign-off.

**Follow-up remediation, 14 October 2026:** The 11 findings below now have local code fixes and regression coverage. Final verification: **916 backend tests and 28 frontend tests passed; production build passed.** See [the remediation results and deployment requirements](MG_Motor_AU_E2E_Remediation_Results.md). The original evidence below is preserved as the pre-fix record. Broader limitations in section 3 and live verification remain open.

This is a fresh review of the remediated implementation. Application source was not changed during this review. The findings below were checked through source tracing, existing tests and additional synthetic failure cases; no production CRM records, credentials, schedules or database schema were changed. The earlier [cross-verification and cost audit](MG_Motor_AU_Cross_Verification_and_Cost_Audit.md) remains the record of baseline findings and delivered fixes. This report adds findings that its remediation section did not close.

## 1. What passed, and what that establishes

| Fresh check | Result | Limit of the evidence |
|---|---|---|
| Complete backend suite, Node 20.20.2 | **833 passed, 0 failed** | Existing covered scenarios pass. New failure cases described below are missing from that suite. |
| Frontend Jest | **18 passed, 0 failed**, three suites | Covers the existing notification, polling and search tests; not a complete browser journey. |
| Frontend production build | **Pass, 18 lint warnings** | Compiles successfully. Does not establish correct role/session behavior or hosted Catalyst behavior. |
| Fresh backend npm audit | **0 known findings** | Advisory result for the current dependency lockfile, not a security certification of application logic. |
| Fresh frontend npm audit | **100 affected package entries:** 63 high, 34 moderate, three low, zero critical | Build/plugin dependency work remains; the count does not mean 100 independently exploitable browser vulnerabilities. |
| `git diff --check` | **Pass** | Existing local changes have no reported whitespace errors. |
| Additional failure probes | **Confirmed defects** | Synthetic actors, records, clocks, HTTP and email providers; no customer data or real vendor writes. |

The first restricted backend run failed because test fixtures require loopback listeners and DNS. The successful rerun had that access. It is the result recorded above. Some mocked HTTP tests still depend on real DNS, which is a test-isolation weakness.

This review follows the main flows through OEM ingestion, outbound adapters, inbound webhooks, replay, scheduled recovery, SLA checks, alert dispatch, portal permissions and notification state. It does **not** establish a live MG → dealer → MG transaction, a real SMTP delivery, real database uniqueness enforcement, a deployed browser session, or capacity at production volumes.

## 2. Confirmed defects requiring another remediation pass

Backend paths below are relative to `functions/mg_motors_au_function/`; frontend paths are relative to `mg-motor-web/`. References describe this working tree. **High** means a credential boundary, authorization boundary, data delivery or correctness issue that should be resolved before broad rollout. **Medium** means a material operational/UI failure with a narrower trigger.

| ID | Priority / triggering context | Finding |
|---|---|---|
| E2E-01 | High; incorrectly configured Zoho API host | Watch registration bypasses destination checks and sends credentials. |
| E2E-02 | High; stale snapshots, old mappings or disabled/removed configurations | Current consent, ownership and lifecycle are not consistently enforced. |
| E2E-03 | High; deleted lead still has queued work | Retry sends the deleted lead and revives local state. |
| E2E-04 | High; role changes but dealer mapping remains | View-only account can mutate a dealer lead. |
| E2E-05 | High; mixed-result Zoho webhook batch | Failed item is acknowledged without durable retry work. |
| E2E-06 | High under sustained budget exhaustion | Stage and candidate rotations repeatedly miss valid retries. |
| E2E-07 | High when switching account/organization | Cached Zoho token survives credential/configuration changes. |
| E2E-08 | Medium; tab switch during bulk notification action | Old filter replaces the selected Unread results. |
| E2E-09 | High with unresolved mapping backlog | Old mapping holds repeatedly consume all replay slots. |
| E2E-10 | High at larger signed-Fusion dealer counts | Channel preflight uses the SLA budget before checking leads. |
| E2E-11 | Medium; persistent sent-row cleanup failure | One sent alert prevents new alert batches from being sent. |

### E2E-01 — High: Zoho watch registration bypasses the new destination policy

**Evidence:** `services/zohoWebhookService.js:183`, `:202`, `:214`, `:240`; `routes/dealerCrmIntegrationRoutes.js:159`; `routes/cronRoutes.js:136`.

The dealer lead adapter and OAuth helper now validate approved Zoho destinations. Dealer webhook registration still derives the API origin directly from `integration.base_url` and uses raw Axios for registration and deregistration. It does not apply the official-host allowlist or the shared pinned HTTPS transport. The save route checks general URL safety, which does not establish that a public hostname belongs to Zoho.

**Reproduced:** with a synthetic `https://outside.example` API origin, the actual registration service attempted a watch POST containing both a synthetic Zoho access token and a callback authentication token. The captured request did not have the shared safe transport configured. All HTTP and credential access were mocked.

**Impact:** an incorrect or malicious saved endpoint can receive credentials during manual registration or scheduled renewal even though ordinary lead delivery rejects it. This requires control of, or an error in, integration configuration; it is not an unauthenticated public endpoint exploit.

**Required correction:** validate the official API origin before token/secret retrieval; use the shared transport for both registration and deregistration; validate the same policy when saving a Zoho configuration. Preserve supported official datacenters and sandbox hosts.

**Acceptance test:** exercise the real watch service and its admin/cron entry points with non-Zoho, private, redirecting and valid official destinations. Disallowed destinations must result in zero secret-bearing HTTP calls.

### E2E-02 — High: current lead ownership and consent are not consistently enforced at dispatch

**Outbound evidence:** `services/integrations/crmIntegrationService.js:698`, `:709`, `:742`, `:777`, `:820`, `:1042`.

The outbound entry point validates the caller's snapshot before acquiring its claim. With the newly enabled fail-closed default, it then re-reads the lead inside the claim and builds a payload from that newer row. It does not repeat consent, dealer assignment or delivery validation on the replacement row. A read error also falls back to the older caller snapshot.

**Three reproductions:**

1. Caller snapshot had consent `true`; stored lead had consent `false`. One dealer update was sent, carrying the false value, and the operation returned success. The expected consent hold was bypassed.
2. Caller snapshot belonged to dealer `AU999`; stored lead had been reassigned to `AU_NEW`. One update containing the new dealer's values was sent through the old `AU999` integration.
3. The authoritative re-read threw a synthetic storage error. The older snapshot was still sent and returned success.

**Inbound evidence:** `services/integrations/crmIntegrationService.js:2060`, `:2096`, the current-lead read at `:2217`, and the OEM write at `:2540`.

Inbound lookup proves that an external record has an old mapping to the authenticated integration. It does not establish that this integration still owns the current OEM lead. A previously valid old-dealer event therefore remains capable of changing the lead after reassignment.

**Reproduced:** an authenticated synthetic `AU999` event changed MG `Lead_Status` to `Contacted` after the local lead had moved to `AU008`. This case needs no concurrent race: retaining the old mapping is enough.

**Explicitly disabled/removed configurations also remain accepted:** `routes/webhookRoutes.js:85–90` checks dealer existence, integration type and the inbound flag, but does not reject a dealer with `dealers.sync_status = 'Removed'` or an integration with status `DISABLED`. Two isolated route probes, each retaining the correct lead assignment, returned HTTP 200 and applied one mocked MG write: a Removed dealer with an ACTIVE integration, and a Synced dealer with a DISABLED integration. These are explicit lifecycle states, separate from the unresolved business policy for inactive dealer stages.

**Related static retry case:** when the old integration's retry sees the new dealer assignment early enough, it correctly avoids sending to the old CRM, but `holdOutboundLead` (`:628`) still sets the shared current lead to `ROUTING_HOLD`. A synthetic old-D1 failure/new-D2 success case left the D2 mapping `SYNCED` while its lead became held. Refusing obsolete work must not damage the current owner's delivery state.

**Impact:** data can reach the previous dealer, consent holds can be bypassed, and an old dealer can alter the reassigned lead. Claims keyed by integration plus lead also do not serialize old and new integrations against each other.

**Required correction:** after acquiring the applicable claim, load the current lead and integration, require a successful authoritative read, and validate current ownership, consent, active configuration and lifecycle before either direction performs a vendor write. Define retirement of old mappings on reassignment. Coordinate assignment changes with lead-level ownership/version checks; simply repeating a check outside the claim is insufficient.

**Acceptance tests:** revoke consent, change dealer, disable the integration or fail the re-read between candidate selection and dispatch. Assert zero unauthorized calls and an explicit held/deferred result. Old-dealer inbound events must not change the new owner's lead. Test both integrations concurrently.

### E2E-03 — High: an OEM-deleted lead can be retried and locally revived

**Evidence:** `services/leadSyncService.js:961`, `:989`; `services/integrations/outboundRetryScheduler.js:182`; `services/integrations/crmIntegrationService.js:686`, `:1213`.

OEM delete handling sets the local lead's `sync_status` to `Removed` but does not retire its pending outbound mapping. The retry sweep checks whether a lead row exists, not whether it is removed. The shared outbound path does not reject this lifecycle state.

**Reproduced end to end locally:** OEM delete handler → local `Removed` state → actual retry sweep → mocked dealer update → local `SYNCED` state. The sweep counted the lead as recovered.

**Impact:** deleting a lead in MG does not stop pending transmissions; customer data can still be delivered or updated at the dealer, and the portal can show the removed row as active again. The reproduced existing-record update did not require an OEM acknowledgement write. A second probe with a failed-create mapping also made one dealer CREATE before a simulated OEM 404 rejected acknowledgement; the local deleted state changed to `DELIVERY_FAILED`. That later error did not undo transmission.

**Required correction:** enforce the removed/tombstoned state in the common outbound path and all automatic mutation paths; retire or explicitly cancel associated pending work when processing deletion. Keep historical records without treating them as active delivery work. Vendor-side deletion is a separate business decision and is not required merely to stop further transmission.

**Acceptance tests:** delete a lead with a failed create, failed update, pending inbound event and overdue SLA mapping. Run all sweeps; expect no new vendor mutations and no local revival.

### E2E-04 — High: view-only users can mutate dealer leads through a retained mapping

**Evidence:** `routes/dealerLeadRoutes.js:37`, `:46`, `:156`, `:171`, `:214`.

`requireDealerCode` verifies an authenticated user and a dealer-user mapping, but never checks the user's current role. A mapping that survives a role change continues to authorize the dealer PATCH route. Frontend route visibility cannot enforce this API boundary.

**Reproduced:** a synthetic `VIEW_USER` with an existing dealer mapping updated `next_followup_date` successfully, received HTTP 200 and generated two admin notifications. The same endpoint also exposes the status-write branch after this deficient authorization check.

**Impact:** changing a user to a read-only role does not reliably revoke mutation privileges. Unknown roles with retained mappings are also not rejected by this helper.

**Deployment qualification:** live table ACLs and actual retained user mappings were not inspected. The reproduction establishes the application route's authorization gap under the stated mapping condition; it does not establish which production users currently meet that condition.

**Required correction:** require an explicitly permitted current role before dealer mutations, retain row ownership checks, and define whether other roles may use dealer read endpoints. Remove or retire stale mappings as part of role changes without relying on cleanup alone for authorization.

**Acceptance tests:** Dealer, View User, Admin, unknown role, removed role and anonymous sessions with and without mappings. View-only/unknown users must receive 403 before any lead or notification write.

### E2E-05 — High: partial Zoho webhook batches can lose failed work

**Evidence:** `services/integrations/crmIntegrationService.js:1888`, `:1915`, `:1926`; `routes/webhookRoutes.js:162`.

When a Zoho notification contains multiple IDs, an exception while fetching one dealer record is added only to the returned `results` array. Unlike failures after record resolution, this fetch exception does not create a per-lead failed replay log. If another ID succeeds, the aggregate returns `ok: true, held: false`; the route records the webhook as `SUCCESS` and acknowledges it successfully.

**Reproduced:** one ID succeeded and one threw a synthetic transport error. The aggregate was successful, one item failed, and there were **zero failed replay logs for that item**.

**Impact:** the vendor has been told processing succeeded while failed work has no durable retry record. Later dealer edits or reconciliation might repair it, but neither is a reliable substitute for retaining this failure. A real event ID can additionally cause a repeated delivery to be treated as a successful duplicate.

**Required correction:** persist each failed ID and its retryable classification before acknowledging the batch. Aggregate event success must mean every item is complete or durably retained. Do not mark a partially processed event permanently successful just because one record succeeded.

**Acceptance tests:** mixed success/timeout, mixed success/429, all-failed and process restart. Retry only unfinished items, preserve successful effects, and verify that every acknowledged failure survives in durable work state.

### E2E-06 — High under sustained backlog: scheduler rotations can repeatedly miss valid work

**Evidence:** the stage rotation in `routes/cronRoutes.js`, `services/integrations/sweepWindow.js:48`, and `services/integrations/outboundRetryScheduler.js:23`, `:96`.

Fast recovery chooses the first of four stages from a two-minute clock bucket modulo four. The retry tail chooses its candidate window from the **same** bucket modulo the number of tail windows. If earlier stages consume the budget, outbound can be productive only in its first-position slots. With four tail windows, those slots select the same tail repeatedly.

**Reproduced using the current router and retry selector:** 500 failed mappings consisting of 200 dangling front rows and 300 valid rows, with other first-position stages consuming the request budget. Across 12 consecutive two-minute slots, outbound was productive in slots 0, 4 and 8. Each selected tail offset 100; none of the 300 valid records was delivered.

**Impact:** each rotation works in isolation, but their interaction invalidates the advertised fairness under load. Dedicated independently scheduled sweeps may mitigate it; their presence and cadence were not verified. Light-load regression tests do not establish fairness during exhaustion.

**Required correction:** give each stage independent progress tracking that advances on productive invocations, or partition resumable work explicitly. Verify both candidate fairness and stage fairness together. Increasing a row cap alone does not remove this interaction.

**Acceptance test:** keep an undrainable/dangling prefix, a stable valid tail and repeated deadline exhaustion. Every valid tail window must eventually receive service across multiple function instances and restarts.

### E2E-07 — High when changing organizations: dealer Zoho tokens survive credential/configuration changes

**Evidence:** `services/integrations/adapters/zohoCrmOAuthHelper.js:34`, `:38`, `:115`; `routes/dealerCrmIntegrationRoutes.js:206`, `:245`.

The dealer Zoho token cache and in-flight refresh map use only the integration ROWID. Saving changed credentials does not invalidate this cache; the save route invalidates the Fusion cache only. Validating the new accounts hostname does not prove the cached token was issued for it.

**Reproduced:** obtain a synthetic token, change both credential values and the official accounts domain on the same integration ID, request a token again. The old token was reused; only one token request occurred.

**Impact:** a warm instance can continue using the previous account token for most of its remaining lifetime, potentially operating on the old organization when the API host is unchanged, or repeatedly failing after credential revocation/domain changes. With a 3,600-second token and the current margin, reuse can persist for approximately 55 minutes from issuance. A same-instance cache clear alone would not invalidate other warm instances. Unlike Fusion's bounded 401 refresh, the generic/dealer-Zoho request retry at `adapters/genericRestAdapter.js:84` does not refresh a token on 401.

**Required correction:** bind cached tokens and single-flight refreshes to a persisted configuration/credential generation and invalidate correctly on change. Ensure an older in-flight refresh cannot repopulate the new generation. Keep old lead mappings from silently following a CRM/account switch.

**Acceptance tests:** rotate credentials, switch account in the same datacenter, switch datacenter and race a save against an in-flight refresh across two simulated instances. Neither token use nor connection testing may reuse the previous generation.

### E2E-08 — Medium: bulk notification completion can replace the selected tab's results

**Evidence:** `src/layouts/MainLayout/Navbar/NotificationBell.jsx:148`, `:239`, `:258`; similar captured refresh/error paths around `:280` and `:290`.

The new actor/role epoch checks protect account switches. They do not protect a filter/tab switch within the same account. An action started on the All tab captures the old refresh callback. If the user switches to Unread while that action is pending, its completion can issue a newer All-tab fetch that wins the request sequence and replaces Unread data.

**Reproduced in a targeted Jest probe:** start Mark all read on All, switch to Unread, then complete a partial bulk response with `hasMore: true`. An All fetch (`unreadOnly: false`) replaced the correctly fetched Unread result. The tab remained Unread with 101 unread items indicated, but the older unread row disappeared from the rendered list.

**Required correction:** associate every request/action completion with its actor and current filter, or refresh through a current-tab reference. A higher sequence number from an obsolete filter must not make that result valid.

**Acceptance tests:** switch tabs during mark-all, clear-all and their error paths, including a >2,000 backlog. Keep the selected filter, count and visible rows consistent.

### E2E-09 — High under unresolved mapping backlog: mapping holds consume replay capacity repeatedly

**Evidence:** `services/integrations/inboundReplayScheduler.js:279`, `:317`, `:328`, `:346`.

Mapping failures deliberately bypass ordinary replay backoff so a corrected mapping can release them promptly. However, the mapping-change gate compares the latest mapping timestamp with the original hold's `CREATEDTIME`, not with the mapping version last attempted. One later mapping edit keeps that condition true indefinitely, even when it did not resolve this lead's status. Updating the replay-attempt timestamp does not close the gate.

**Reproduced:** 120 older unresolved mapping holds across four dealers followed by one valid newer event. A later but irrelevant mapping edit made the same first 20 holds eligible on each two-minute run. Four runs performed 80 replay attempts on those holds and never attempted the valid newer event. This does not require a vendor outage or the stage-rotation case in E2E-06.

**Impact:** repeated mapping reads, dealer reads/replay work and attempt writes consume the replay allowance; valid updates can wait indefinitely behind unresolved work.

**Required correction:** record the mapping generation last attempted, retry once per relevant change, and use a due time/progress cursor for unresolved work. Preserve immediate release after an actual fix without allowing permanently eligible old holds to occupy every slot.

**Acceptance test:** an unrelated mapping edit must not reactivate an unresolved record every run. A valid newer record must progress while older holds remain unresolved; a later relevant mapping correction must still release them.

### E2E-10 — High at larger dealer counts: SLA preflight can consume every sweep before checking leads

**Evidence:** `services/integrations/slaMonitorService.js:140`, `:175`, `:184`, and its preflight call before candidate processing; `services/integrations/fusionReturnChannelProof.js`.

The complete, fail-closed Fusion channel check fixes the previous >300-integration coverage hole. It also checks all in-scope Fusion integrations serially before processing overdue mappings. Reading each current signing credential and stored proof consumes the same budget as actual SLA work. There is no retained progress through this preflight.

**Reproduced with a simulated clock:** V2 enabled, 200 healthy Fusion integrations with valid signed-channel proof, two 50 ms proof-related reads per integration, and one overdue healthy Zoho lead. The 20-second standalone SLA budget was consumed by preflight. Across three sweeps, 600 credential reads and 603 ZCQL queries occurred; no OEM SLA write occurred and the overdue lead never reached processing. The latency is a test input, not a measured Catalyst latency.

**Impact:** global proof checking can prevent even an unrelated non-Fusion dealer from being checked. Raising the budget alone conflicts with the function's execution limit and does not make the algorithm scale.

**Required correction:** check proof for candidate integrations, cache it within the sweep, and make integration discovery/proof work bounded and resumable. Keep current-key validation and fail-closed behavior; do not regain throughput by treating an unreadable proof as valid.

**Acceptance test:** hundreds of Fusion integrations with realistic query latency plus overdue non-Fusion and Fusion leads. Both must receive bounded-time attention, including when one credential/proof read fails.

### E2E-11 — Medium: one undeletable sent alert can block all new alert batches

**Evidence:** `services/integrations/integrationAlertBatchService.js:65`, `:90`, `:163`; `services/integrations/integrationOperationClaimService.js:101`.

The sent-receipt mechanism correctly avoids re-emailing rows already accepted by SMTP. Dispatch always cleans the oldest receipt and returns before selecting new work. If a sent queue row remains present but repeatedly cannot be deleted, that receipt stays at the front forever, preventing delivery of unrelated unsent alerts.

**Reproduced:** one already-sent queue row with persistent synthetic deletion failures, followed by 100 new alert rows. Three flushes sent no new email; 101 rows remained queued and cleanup remained pending.

**Impact:** the duplicate-prevention improvement can turn a cleanup fault into a global alert-delivery stall. Existing partial-cleanup tests establish no duplicate email, but not continued progress of new mail.

**Required correction:** maintain durable sent identity while separating cleanup progress from selection of unsent batches. Quarantine/escalate persistent cleanup failures and bound their work. Do not discard the receipt or send its rows again merely to unblock the queue.

**Acceptance test:** persistent failure to delete one sent row must not suppress new unsent alerts, duplicate the sent batch or erase its receipt.

## 3. Important earlier limitations that remain open

These were not newly discovered in this pass. They remain relevant even after the defects above are fixed.

| Area | Remaining gap | What closes it |
|---|---|---|
| Create idempotency | The stable OEM ID is reused with payloads rebuilt from mutable current state. An ambiguous create followed by an MG edit can retry a different body under the same key. | Persist an immutable create intent or establish a vendor-supported recovery procedure. Never change the key merely to bypass a conflict after possible acceptance. |
| OEM checkpoint/recovery | Checkpoint state depends on sync logs. The stronger lookup is flag gated; without a usable checkpoint the fallback is 24 hours. Full-window fetch/process work is not a resumable page worker. | Durable progress independent of audit-log retention, bounded page execution, crash/restart tests and backlog drain measurement. |
| In-flight timeouts | Fast recovery bounds starting new work; it does not cancel already-running HTTP/SMTP work. `/cron/sync-modified-leads` and synchronous webhook work are not made bounded by that fast-recovery change. | Request-level budgets propagated through queues and vendor calls, durable continuation and actual timeout tests. |
| Database guarantees | Local mocks do not prove real unique constraints, column sizes, access rules or transactional behavior. | Inspect the deployed schema and test concurrency in a controlled staging environment. |
| Credential storage | Multi-credential saves are not atomic; key/AAD migration and rotation procedures remain incomplete. Historical exposure is documented, revocation not verified. | Versioned credential/configuration writes, migration/rollback design and owner evidence of rotation. |
| Email | SMTP acceptance followed by crash/receipt-write failure remains ambiguous. Claims do not make SMTP exactly-once. | Durable delivery state, explicit uncertainty handling and a staged provider failure test. |
| API rate limits | Fusion budgeting is optional and not an atomic distributed limit shared by every use of the same credential. | Measure effective per-credential traffic across workers and integrations; implement a shared limiter if needed. |
| Uploaded documents | Input/output limits do not bound compressed workbook expansion, parser memory or CPU time. | Isolated bounded parser workers and representative stress tests. |
| AI endpoints | Gemini/Sarvam calls have no explicit request timeout in these helpers. Some tools fetch complete lead lists then return only 30 items; AI query can also perform TTS on text requests when configured. | Bounded database tools, provider budgets/timeouts and usage-based decisions about voice generation. No evidence attributes the supplied datastore bill to AI usage. |
| Frontend dependencies | 100 affected dependency entries and 18 lint warnings remain. | Reviewed Catalyst-compatible tooling updates/migration, with a clean build/deploy test. Do not force npm's incompatible automatic replacement suggestions. |
| Capacity | No real load, sustained recovery, queue-age or multi-instance vendor test was run. | Measure against agreed peak arrivals, updates per lead, retry rates, dealer distribution and actual quotas. |

Catalyst documents a **30-second Advanced I/O timeout**. An HTTP route named `/cron/...` inside this Advanced I/O function does not by itself become a separate 15-minute Cron function. [Catalyst Advanced I/O documentation](https://docs.catalyst.zoho.com/en/serverless/help/functions/advanced-io/), [Serverless FAQ](https://docs.catalyst.zoho.com/en/faq/serverless/).

Zoho's Get Records API also documents a 100,000-record pagination ceiling. A successful small-data pagination test does not establish a single uninterrupted 200,000-record import strategy. This is a scale limitation, not evidence that the present first-page token handling is broken. [Zoho CRM v8 Get Records](https://www.zoho.com/crm/developer/docs/api/v8/get-records.html).

## 4. Contract and business cross-verification

The seven supplied documents were used as inputs, with later recorded decisions distinguished from earlier proposals:

| Input | Re-verified implication |
|---|---|
| Technical audit handover | Requires end-to-end ownership, concurrency and recovery safety. The reproduced reassignment, deletion and partial-batch defects violate those technical expectations. |
| External clarifications | Pending business questions remain decisions, not proof of absent vendor documentation. Authentication, standard statuses and documented HTTP operations are substantially answered by the vendor files. |
| OpenAPI YAML | Documents client credentials, a 600-second token, POST/PATCH, a 300-request-per-credential allowance shared by POST/PATCH, 32 KB bodies, identical-body idempotency, and signed webhooks. The payload/signature fixes are covered by passing tests; idempotency and rollout prerequisites remain. |
| Supplied PDF | The supplied 11-page export is dated 29 September. The older Fusion audit cites a different 14-page October export. Do not attribute that other PDF's page references to this file. The supplied guide requires a name plus usable phone or email. |
| CRM workbook | First/last name, contact, consent, status, department, model/variant/powertrain and ownership requirements are broader than the present status-only Fusion inbound scope. Some are explicitly deferred by later decisions. |
| Fusion audit | Useful baseline, but its source revision and several findings predate the remediation. Fixed signature, token error, payload-size and missing-ID items must not be reported as if unchanged. |
| Fusion remediation plan | Later Q1/Q26 decisions explain intentional differences from the spreadsheet. Q32 deliberately avoids sending clears. These are approved application choices, not reasons to replace current mappings with the older spreadsheet. |

Still requiring MG/vendor decisions: production SLA minutes and scope; inactive dealer behavior; unknown marketing-consent semantics; authoritative current status picklists; cross-system field ownership; outcome/conversion and Retail/Fleet/Demo meaning; department/variant/powertrain/customer-message scope; Australian reporting timezone/DST; CRM-switch/reassignment lifecycle; and AutoPlay documentation/approval.

These decisions do not block fixing the authorization, current-ownership, removed-state or durable failure-recording defects above.

## 5. Local configuration is not proof of deployed behavior

A secret-safe inspection printed only an explicit allowlist of non-secret settings from the local Catalyst configuration. It found a two-minute SLA and a 1,440-minute reconciliation interval. It did not find explicit entries for the flags below. This is **local-file evidence only**; injected environment variables and the live console were not inspected.

| Source behavior when unset | Settings |
|---|---|
| Enabled by the recent remediation | `MAPPING_CACHE_PER_RUN`, `FAST_RECOVER_HONOUR_SCHEDULE`, `SYNC_CLAIM_FAIL_CLOSED` |
| Still opt-in | `FUSION_INBOUND_V2`, `INBOUND_EVENT_STORE`, `SLA_DEALER_ACTION_CLOCK`, `FUSION_RATE_BUDGET`, `DURABLE_SYNC_CHECKPOINT`, `FULL_SYNC_STRICT_SNAPSHOT`, `FUSION_CHANGES_ONLY_PATCH`, `KEEP_OUTBOUND_RETRY_ON_INBOUND` |
| Still require explicit configuration for the relevant paths | `ZOHO_API_TIMEOUT_MS`, `CRON_WORK_BUDGET_MS`, classified `OUTBOUND_RETRY_POLICY` |

Consequently, an all-flags-on test is evidence about that configuration, not evidence that production currently has signed V2 inbound, durable event replay, the new SLA clock or classified retries enabled. Some flags need schema columns first.

Before release, verify the actual unique `outbound_sync_claims.claim_key` constraint, receipt-capable `request_reference` storage, `webhook_events` columns/uniqueness, credential key management, authorized table roles and feature flags. Preserve durable proof/receipt rows during maintenance. Verify real signed Fusion SUCCESS evidence against the current key, approved official Zoho hosts, cron cadence and historical secret revocation.

Also exercise a dealer's **first signed event being held and later replayed**. The current proof recorder is called on successful signed route processing; replay-only completion does not create that proof. SLA eligibility can therefore remain conservatively disabled until a later signed route success. Do not count a held 202 response or an enabled flag as established SLA return-channel coverage.

## 6. Cost reassessment

The supplied bill still points primarily to datastore activity: **₹4,740.30 in fetch charges, approximately 74.1% of the ₹6,396.77 listed gross total**. Function execution is about ₹12.46, approximately 0.2%. These are calculations from the supplied line items; no billing period or live usage attribution was available.

The prior fixes retain useful measured reductions: scoped lead reads, bounded navbar results, removal of unnecessary grouped reads, mapping reuse within a run, skipping backed-off work, visible-only 120-second polling and duplicate-dispatch prevention.

Remaining cost questions are tied to correctness:

- Retrying removed leads, stale mappings or the same starvation windows consumes work without useful recovery.
- Safe channel validation and durable receipts add necessary database operations; their scalability must be measured rather than assumed free.
- Full-list AI/reporting paths, repeatedly checked healthy/actioned SLA rows, legacy complete-list consumers and dealer-wide directory reads still deserve endpoint-level measurement.
- Multiple schedules can overlap logically even when same-instance overlap is blocked. Confirm actual schedules before changing frequency.

Record sanitized query/write counts and elapsed time by service stage in structured logs. Compare matched billing windows normalized by lead changes, active users and successful recoveries. Keep oldest pending age and duplicate/lost-work metrics alongside costs. The local tests do **not** establish a percentage or rupee saving in production.

## 7. Release decision and verification order

**The code is improved, but it is not ready for an unconditional “solid end to end” sign-off.**

1. Close credential egress, current-role authorization, current lead ownership/consent and removed-state enforcement first.
2. Make partial webhook failure durable; fix productive-run scheduling fairness and credential-generation cache invalidation.
3. Close the remaining alert/SLA operational cases and notification filter race, then rerun the full suite with these scenarios added as permanent regressions.
4. Verify schema, flags and schedules in staging. Run controlled create → acknowledgement → dealer edit → MG write-back → retry/replay → portal flows, plus deletion, reassignment, key rotation and provider failure. Confirm the externally visible state as well as HTTP responses.
5. Establish load and cost results on representative data before a controlled production rollout.

No deployment or further application edits were performed in this re-verification pass.

## 8. Evidence artifacts

Fresh full-suite commands, run in the indicated project directory:

```sh
# functions/mg_motors_au_function
/Users/fristineinfotech/.nvm/versions/node/v20.20.2/bin/node --test test/*.test.js
npm audit --json

# mg-motor-web
CI=true npm test -- --watchAll=false --runInBand
npm run build
npm audit --json
```

Fresh full-run logs:

- `/private/tmp/mg-e2e-backend-tests.log`
- `/private/tmp/mg-e2e-frontend-tests.log`
- `/private/tmp/mg-e2e-frontend-build.log`
- `/private/tmp/mg-e2e-backend-audit.json`
- `/private/tmp/mg-e2e-frontend-audit.json`

Additional synthetic reproduction artifacts:

- `/private/tmp/mg-e2e-root-probes.test.cjs` and `.log`: consent revocation, reassignment, failed authoritative read, OEM deletion followed by scheduled retry.
- `/private/tmp/mg-e2e-contract-proofs.js` and `.log`: watch destination bypass, stale Zoho token, partial webhook batch, old-dealer inbound after reassignment.
- `/private/tmp/mg-e2e-scheduler-probes.js` and `.log`: stage/window interaction, repeated mapping holds, sent-alert cleanup stall, SLA preflight exhaustion and stale-dealer retry state corruption.
- `/private/tmp/mg-e2e-portal-review-tests/notification-tab-race.test.jsx`: selected-tab race.

Temporary files support the session and may be removed by the operating system. The triggering conditions, observed outcomes and required acceptance tests are preserved in this report so the findings do not depend on those files remaining available. The reproduction tests intentionally demonstrate current incorrect behavior; their own passing assertions are not evidence that the defects are fixed.
