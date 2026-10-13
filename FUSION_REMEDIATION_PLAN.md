# Fusion SD Remediation Plan (batched)

| | |
|---|---|
| Created | 12 October 2026 |
| Baseline revision | `aa0045f` (main) — 334 backend tests passing, frontend build passing |
| Source of findings | [FUSION_SD_AUDIT.md](FUSION_SD_AUDIT.md) (written against `bd76283`) plus the cross-check of 12 Oct 2026 |
| How to use | One batch per session. Start a new session with: **"Implement Batch N from FUSION_REMEDIATION_PLAN.md"**. Update the status table at the end of each batch. |

## Ground rules (apply to every batch)

1. **Don't break current behavior.**
   - Every batch is additive.
   - Any change of behavior visible to ZOHO_CRM / GENERIC_REST dealers (AU008 etc.) needs an explicit line in that batch's "Behavior change" section. If there isn't one, the change must be scoped to `crm_type === 'FUSION_SD'`.
   - Riskier changes go behind an env flag read through `config/env.js`. Flags default **off**, so a deploy without the env var behaves exactly like today.
2. **Tests first.** Write the failing test that reproduces the audit finding, then fix it. Never edit an existing test's assertion to make it pass unless the batch says that behavior is intentionally changing. In that case call it out in the commit message.
3. **Gate before each commit:**
   ```bash
   cd functions/mg_motors_au_function && npm test          # must be >= previous count, 0 fail
   cd ../../mg-motor-web && node node_modules/react-scripts/bin/react-scripts.js build
   ```
   (`npm run build` currently fails: `node_modules/.bin/*` lost its exec bit. Fix that with `chmod +x mg-motor-web/node_modules/.bin/*` in Batch 0.)
4. **One branch per batch:** `fusion/batch-N-<slug>` off the previous batch. Make one or more focused commits, and merge only after review.
5. **No datastore schema changes unless the batch says so.** When one is needed, first inspect the live table with the Catalyst MCP (`List_All_Columns`). Write the column additions into the batch notes, and add them in the Catalyst console **before** deploying the code. The code must tolerate the column being absent (feature off) until it exists.
6. **Cross-check field and status names** against `functions/mg_motors_au_function/VERIFIED-CRM-FACTS.md` (see CLAUDE.md).
7. **New env vars:** add them via `config/env.js`, and list them in the batch's "Deploy notes". They are also recorded in `LEAD_EXCHANGE_DEMO_RUNBOOK.md` → "Production configuration checklist" at the end of the batch.
8. **Out of scope unless a batch says otherwise:** live CRM writes, cron schedule changes, credential changes.

## Batch overview

| # | Batch | Audit items | Risk | Schema change | Blocked on |
|---|---|---|---|---|---|
| 0 | Baseline and safety net | — | None | No | — |
| 1 | Isolated security and hygiene fixes | M1, M2, M9, H3, M6, M7, L2, S10, L3, L4 | Low | No | — |
| 2 | Outbound false success and status handling | New issue #2, H4, M5 | Low–Med | No | — |
| 3 | Retry, escalation and missing-ID safety | C1, C2, S2, L5 | Medium | Maybe (1–2 cols) | — |
| 4 | Outbound mapping/contract alignment | H1, H2 (partial), 32 KB guard, name split | Medium | No | Q1, Q2 (MG decisions) |
| 5 | Fusion inbound translator and verifier | H5 (remainder) | Medium (flagged) | No | Q3 (Fusion signing fixture) |
| 6 | Durable inbound events and replay | C4, M8, L7, S9 (events) | Med–High | **Yes** | Batch 5 |
| 7 | SLA correctness | C3 | Medium | Maybe (1 col) | Q4 |
| 8 | Rate limiting, timeouts, claims | S1, S3, S4, L6 | High | Maybe | Q5 |
| 9 | Datastore scale and load testing | S5–S8, S11 | High | Maybe | Isolated Catalyst project |
| 10 | Changes-only PATCH and field ownership | Contract step 2 | Medium | **Yes** | Batches 3, 8 |

Batches 1–3 are not blocked and are the highest-value safe work. Batch 4 can start in parallel once Q1/Q2 are answered.

---

## Batch 0 — Baseline and safety net

**Goal:** a clean, reproducible starting point. No application behavior changes.

1. Create branch `fusion/batch-0-baseline` from `main` (`aa0045f`).
2. Clean up line-ending noise. About 30 files show as modified only because of CRLF/whitespace (`git diff --ignore-all-space --ignore-cr-at-eol --stat` is empty for them).
   - Restore those to HEAD with `git checkout -- <file>`, file by file, after confirming each one's diff is whitespace-only.
   - **Do not** touch `SCALABILITY_TEST_PLAN.md`: its diff is real (the local version was intentionally kept).
   - Optionally add a `.gitattributes` with `* text=auto` in a separate commit.
3. Commit `FUSION_SD_AUDIT.md` and this plan.
4. Fix the frontend bin permissions: `chmod +x mg-motor-web/node_modules/.bin/*`. This is local only, not committed.
5. Add test helpers under `functions/mg_motors_au_function/test/helpers/`:
   - `fusionFixtures.js`:
     - a synthetic Fusion `201 {lead_id,status,received_at}` response
     - a PATCH `LeadUpdated` response (with `updated_fields`, `ignored_fields`, `update_mode`, `enquiry_linked`)
     - a 403 `updates_not_enabled` problem body
     - a 429 response with a `Retry-After` header
     - an inbound flat webhook payload (`lead_id`, `dealer_id`, `status`, `pushed_at`)
   - `standardWebhooksSigner.js`: produces `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,<base64 HMAC-SHA256 of id.ts.body>`. It is used by Batch 5 tests.
6. Record the baseline in the status table: test count and build result.

**Acceptance:** `git status` shows only intended files; tests show 334 passing; the build passes.

---

## Batch 1 — Isolated security and hygiene fixes

Each item is small, local and independently testable. None changes successful-path behavior.

| Item | File(s) | Change | Test |
|---|---|---|---|
| **M1** Prototype pollution | `services/integrations/adapters/fusionSdAdapter.js` (dotted-path setter ~l.129–145), `routes/dealerCrmIntegrationRoutes.js` (mapping save) | Reject the path segments `__proto__`, `prototype` and `constructor` when the mapping is saved (400 `FIELD_MAPPING_INVALID`). The setter skips them and uses `Object.hasOwn` instead of inherited properties. | A mapping with `__proto__.x` is rejected on save, and the setter doesn't mutate `Object.prototype`. |
| **M2** Parent/child path collisions | Same mapping save route and setter | On save, reject the case where one target is a prefix of another (`contact` and `contact.firstName`). The setter refuses to overwrite an object with a scalar or the reverse, and logs it. | A collision is rejected on save; the existing presets still save. |
| **M9** Unguarded timeline | `routes/dealerCrmIntegrationRoutes.js` `GET /leads/:crmRecordId/timeline` (mounted at `/admin/dealers`) | Add `requireAdminOrViewRole`. The frontend doesn't call this route: it uses `/admin/leads/:id/timeline`, verified 12 Oct. So no UI change is needed. | A dealer role gets 403; admin and view roles get 200. |
| **H3** Token URL SSRF guard | `adapters/fusionSdOAuthHelper.js` (~l.54–65), integration save route | Run `assertSafeUrl` on the token URL before sending keys, and validate that `base_url` is HTTPS and passes `assertSafeUrl` at save time. | An HTTP or private-IP token URL is refused before any request; a valid HTTPS host still works. |
| **M6** Loose ID extraction | `fusionSdAdapter.js` (~l.192–228) | For FUSION_SD, accept only `lead_id` (a string matching a sane ID pattern) from the JSON body. Use the `Location` header only if its path matches `/v1/leads/{id}` after stripping the query. Otherwise return no ID, so the existing `DEALER_ACK_MISSING_ID` path runs. | A body of `OK` gives no ID; a real `lead_id` still works. |
| **M7** Token cache | `fusionSdOAuthHelper.js` | Treat a missing or invalid `expires_in` as 600, not 3600, and make the refresh margin `min(300, lifetime/2)`. Add `invalidateToken(integrationId)` and call it from the credential save route and once on a 401 (refresh and retry the request once). Test Connection bypasses the cache. | The cache is invalidated on save; a 401 triggers exactly one refresh; Test Connection always fetches. |
| **L2** HTTP 0 on token failure | `fusionSdOAuthHelper.js` (~l.75–77), `fusionSdAdapter.js` (~l.313–317) | Keep `response.status` on the wrapped token error, and tell network errors apart from 4xx/5xx. | Test Connection shows the real status. |
| **S10** Alert batch above the ZCQL bound | `services/integrations/integrationAlertBatchService.js` (`MAX_BATCH_ROWS = 500`) | Page reads in chunks of ≤300 (loop `LIMIT offset,300`) while keeping the 500 logical batch size, or lower it to 300. | The in-memory ZCQL emulator (300 cap) accepts a full flush. |
| **L3** Stale comments | `fusionSdOAuthHelper.js`, `fusionSdAdapter.js:32,80`, config comments | Fix the comments that say PATCH is unsupported or that there is no webhook. Leave the code as is: the capability flag `webhook: false` changes in Batch 5. | — |
| **L4** Required unused endpoint | `crmIntegrationService.js` `validateIntegrationConfiguration` (~l.495–498) | Require `update_lead_endpoint` only for adapters that don't derive PATCH (i.e. not for FUSION_SD). | A Fusion config without `update_lead_endpoint` passes; GENERIC_REST still requires it. |

**Behavior change:** none for working configurations. Bad mappings or URLs that used to be accepted are now rejected at save time, so check the live Fusion and AU008 mapping rows don't contain such paths before deploying.

---

## Batch 2 — Outbound false success and status handling

| Item | Change | Test |
|---|---|---|
| **New issue #2** — inbound-only statuses block outbound | In `buildOutboundPayload` (`crmIntegrationService.js` ~l.456–491): when the MG status has no ZOHO_TO_EXTERNAL mapping **but does** have an inbound-only reverse row, **omit** the status field, the same way OEM-only states are handled, instead of throwing. MG statuses with no mapping at all keep today's `STATUS_MAPPING_NOT_FOUND` hold. Also review the error classification at ~l.1173: an **outbound** `STATUS_MAPPING_NOT_FOUND` must not be labelled Unhappy 4, which is the inbound scenario. Agree the correct code with pathPolicy first. | A lead in "Contacted" (inbound-only) syncs other field edits to Fusion without `enquiryStatus`; a status with no mapping at all still holds. |
| **H4** `skipped` updates recorded as delivered | In the orchestrator (~l.754–887), when the adapter returns `skipped: true` (403 `updates_not_enabled`), **don't** mark SYNCED or write recovery. Write a log `status: 'SKIPPED'` with reason `DEALER_UPDATES_DISABLED`, keep the mapping's previous state, and raise one configuration alert per integration (deduped). | A 403 `updates_not_enabled` doesn't produce SYNCED or Happy; the alert fires once. |
| **H4** PATCH diagnostics | Parse `updated_fields`, `ignored_fields`, `update_mode` and `enquiry_linked` from the 200 response. Persist them, truncated, in the integration log. `update_mode: manual` counts as submitted, awaiting dealer acceptance: don't retry it. A non-empty `ignored_fields` is logged as a field-level warning. | Fixtures for manual mode and ignored fields produce the right log content and no retry. |
| **M5** Lost vendor diagnostics | `wrapFusionError` (~l.104–119): keep `status`, the problem `type` / `title` / `detail` / `instance`, and the `Retry-After` header on a safe `err.vendor` object. Truncate it, with no secrets and no raw customer payload. The failure log (~l.958–981) writes `err.vendor` into the log's details. | A 429 fixture keeps `retryAfter`; a 422 keeps `type` and `instance`. |

**Behavior change:** a 403 `updates_not_enabled` no longer shows as SYNCED. Check any frontend status badges for the new SKIPPED log status: `LeadExchangePage.jsx` and the sync-log pages must render unknown statuses gracefully.

**UI follow-up (same batch):** render SKIPPED and "Awaiting dealer acceptance" in `SyncLogsPage.jsx` and `LeadExchangePage.jsx`.

---

## Batch 3 — Retry, escalation and missing-ID safety

**Before coding:** inspect `lead_integrations` columns with MCP (`retry_count`, `next_retry_at`, `failure_streak_started_at`, `sync_status`) and decide whether a column is needed for the parked reason (prefer reusing an existing `last_error` / `error_message` column).

| Item | Change |
|---|---|
| **S2** Error classification | Add one classifier, `classifyDealerError(err)` → `TRANSIENT` (network, timeout, 429, 5xx), `AUTH` (401 after one refresh), `PERMANENT` (400, 403 other than updates_not_enabled, 404, 409, 422), or `LOCAL` (`CRM_API_QUEUE_FULL` and other limiter errors). Only TRANSIENT and LOCAL are retried automatically. |
| **S2** Backoff | Replace the fixed 15-min interval (`crmIntegrationService.js` ~l.62–67, 256) with capped exponential backoff plus jitter (e.g. 2 → 5 → 15 → 30 → 60 → 120 min, cap 6 h), honouring `err.vendor.retryAfter` from Batch 2. Add a max attempt count and age (env, e.g. 10 attempts / 48 h). When exhausted → `FAILED_CRITICAL` with reason `RETRY_EXHAUSTED`, excluded from sweeps until an admin replays it. |
| **S2** fast-recover | `cronRoutes.js:220` passes `ignoreSchedule: true`. Change it to honour `next_retry_at`, except for rows that have never been attempted. Put this behind `FAST_RECOVER_HONOUR_SCHEDULE` (default **on** after review, or off for the first deploy). |
| **C1** Missing ID | A successful create with no trustworthy ID → new state **`ACK_UNRESOLVED`** on the mapping. It is excluded from create retries, raises one alert, and the immutable submitted payload hash is kept in the log. Add an admin "link manually" action (enter the Fusion `lead_id`) → mapping is linked and later edits use PATCH. The existing `crmIntegrationServiceAckMissingId.test.js` assertions change intentionally: document this in the commit. |
| **C1** Idempotency | Retries of a create must reuse the original key **and** the original payload, or skip the create when the payload changed and the previous attempt's outcome is unknown. This needs the original payload hash stored with the failure row. |
| **C2 / L5** Status-safe escalation | `recordOutboundFailureAndCheckEscalation` (~l.920–938) only counts TRANSIENT dealer-side failures toward the Dealer Unavailable streak. It never counts LOCAL queue saturation, missing ID, or update failures for leads already delivered. Writing OEM `Dealer Unavailable` stays as is for genuine outages (current approved behavior), but limit it to leads not yet delivered. |
| UI | Frontend: show `ACK_UNRESOLVED` and `RETRY_EXHAUSTED` in `LeadExchangePage.jsx`, with the link and replay actions in the admin view. |

**Behavior change (all dealers):** failures that are permanent no longer retry forever, and queue saturation no longer escalates to Dealer Unavailable. Put the escalation change behind `ESCALATION_TRANSIENT_ONLY` if a staged rollout is wanted.

**Deploy notes:** new env vars `OUTBOUND_RETRY_MAX_ATTEMPTS`, `OUTBOUND_RETRY_MAX_AGE_HOURS`, `FAST_RECOVER_HONOUR_SCHEDULE`, plus the optional `ESCALATION_TRANSIENT_ONLY`.

---

## Batch 4 — Outbound mapping/contract alignment (needs Q1, Q2)

| Item | Change |
|---|---|
| **H1** Tri-state booleans | New `parseTriState(value)` → `true` / `false` / `undefined`, which rejects garbage. It is used for `data_type: boolean` mappings. Unknown consent is **omitted** from the payload, never sent as `false`. Do not reuse `isTrue()`. |
| **H1** Empty values | On create, drop `""` and `null` optional fields. Don't change PATCH semantics here (clearing values is handled in Batch 10). |
| **H1** Marketing consent | Change the preset in `DealerCRMConfig.jsx:190` from `contact.optinEmail` to `contact.marketingOptinEmail` (per D1 I7). Existing saved configs are **not** migrated automatically: an admin re-saves the AU Fusion dealer's mapping. Note this in the deploy notes. |
| Name split | Map `First_Name` → `contact.firstName` and `Last_Name` → `contact.lastName` instead of the concatenated full name (see VERIFIED-CRM-FACTS: `Last_Name` is mandatory and `Full_Name` is read-only). Preset change plus a source-field addition in `leadSyncService.js` (~l.102–158). |
| 32 KB guard | Before POST, measure `Buffer.byteLength(JSON.stringify(payload))`. If it is over 32,000, truncate the longest note fields with a marker, or hold with `PAYLOAD_TOO_LARGE`, depending on Q2. |
| **H2** Status map completion | Implement only after Q1 is answered: Update Pending, Contacted / Contact in Future → Open, Dropped → Prospect Lost, and whether Won means Contacted or Delivered. The many-to-one direction is supported by the inbound-only mechanism plus Batch 2; review whether a separate "outbound-only" flag is needed for many MG → one Fusion. |
| `lostReason` | Send it only when the mapped Fusion status is Lost or Prospect Lost, and only if not empty. |
| Enquiry outcome | Remove `activity.subType` from any default (it isn't in the preset today; verify). The outcome transformation waits on Q1. |

**Behavior change:** Fusion-only payload shape. AU008 (ZOHO_CRM) is unaffected; verify with the existing `integrationMapping.test.js`.

---

## Batch 5 — Fusion inbound translator and verifier (needs Q3)

Everything is behind **`FUSION_INBOUND_V2=true`** and scoped to `crm_type === 'FUSION_SD'`. With the flag off, today's code path, including the X-Webhook-Token auth from `38e7e63`, is untouched.

| Item | Change |
|---|---|
| Standard Webhooks verifier | In `webhookVerificationService.js`, when the `webhook-signature` header is present:<br>• compute base64 HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}` with the Fusion **signing secret**<br>• accept any `v1,` signature in the space-separated list (rotation)<br>• constant-time compare<br>• reject when `|now − timestamp| > 300 s`<br>Keep the static-token check as an additional, not alternative, requirement if the dealer configured one. |
| Signing secret storage | Store it as a separate credential type (`WEBHOOK_SIGNING_SECRET`) via `integrationAuthService`, distinct from the token secret. Admin UI field in `DealerCRMConfig.jsx`. Confirm the secret's encoding with the Fusion fixture: Standard Webhooks secrets are usually `whsec_<base64>`. |
| Event ID | `webhookRoutes.js` (~l.94–99) also reads the `webhook-id` header. |
| Translator | New `services/integrations/adapters/fusionSdInbound.js`, `translateFusionWebhook(payload)` → `{ externalLeadId: payload.lead_id, record }`. `record` is keyed by the **outbound target field names** (`status` → `enquiryStatus`, `name` → `contact.firstName`, `email` → `contact.email`, `phone` → `contact.phone`, `postcode` → `contact.areaCode`, `model` → `requirement.model`). That lets the existing `processResolvedInboundLead` and mapping logic run unchanged. Absent keys stay absent; `null` consent stays unknown. Called from `processInboundWebhook` (~l.1345) before the `id`/`leadId` lookup, for FUSION_SD only. |
| Capability | `fusionSdAdapter.js:80` sets `webhook: true` only when the flag is on. `getLead` stays false. |
| Unknown `lead_id` | This is a dealer-originated lead. Keep today's Unhappy 7 hold (phase 2 is out of scope). |
| `dealer_id` check | If `payload.dealer_id` is present and isn't equal to the route's dealer code → 401. |

**Tests:** signed fixtures (valid, stale timestamp, rotated signature, tampered body); a flat payload produces the right MG status through the inbound-only Won/Delivered rows; partial payloads; flag off leaves behavior identical (the existing `sharedWebhookSecret.test.js` and `fusionInboundWebhook.test.js` still pass).

**Deploy notes:** `FUSION_INBOUND_V2`. Give the dealer the final URL (`https://<public-base>/server/mg_motors_au_function/webhooks/dealers/<dealerCode>` — confirm the prefix), the chosen header auth, and the `dealer_id` value.

---

## Batch 6 — Durable inbound events and replay (schema change)

**Schema (add in the Catalyst console first, after an MCP inspection of the webhook events table):**
- `payload_encrypted` (text): the verified body, encrypted with the same AES-GCM helper used for credentials
- `attempt_count` (int)
- `lease_until` (datetime)
- `last_error` (text, ≤500)
- `processed_at` (datetime)

Confirm that `dedupe_key` has its UNIQUE constraint.

| Item | Change |
|---|---|
| **C4** Dedupe semantics | On a duplicate `dedupe_key`, read the existing row:<br>• `SUCCESS` → 200 duplicate<br>• `RECEIVED`, `FAILED` or `PENDING` with an expired lease → take the lease and process again from the stored payload<br>• otherwise → 202 "in progress"<br>Never return 200 for work that isn't durably stored. |
| Store before processing | Insert the row with the payload, then process; mark SUCCESS / PENDING / FAILED. When the payload column is absent (pre-migration), fall back to today's behavior. |
| **M8 / L7** Replay | `inboundReplayScheduler.js`: for CRMs without `getLead`, replay from `payload_encrypted` instead of skipping. `adminDashboardRoutes.js` (~l.140–158): check `getLead` support before calling it, and show "not readable from dealer" instead of "record missing". Close rows with no integration or external ID with a reason instead of leaving them waiting forever. |
| **S9** Retention | Add a cron step, e.g. in `daily-error-report`, that deletes SUCCESS webhook-event rows older than N days (`WEBHOOK_EVENT_RETENTION_DAYS`, default 30), in ≤300-row batches. |

**Acceptance (from audit C4):** a crash after receipt, a failed OEM write, a duplicate while processing, and a later redelivery each recover exactly once.

---

## Batch 7 — SLA correctness (needs Q4)

| Item | Change |
|---|---|
| **C3** Return-channel gate | `slaMonitorService.js` (~l.78–108, 181–234): skip action-based breaches for integrations whose return channel isn't verified (FUSION_SD with `inbound_enabled` false, or V2 not on). Record a channel-health note instead. |
| Timestamps | Use an explicit `last_dealer_action_at` (set only by applied inbound dealer changes), not `last_synced_at`, which is reset by outbound updates and sweeps. Schema: one new column on `lead_integrations` (or on `leads`; decide after inspection). Fall back to today's logic if the column is absent. |
| Config | Document that the local 2-minute SLA / escalation values are demo-only. The production values are part of Q4. |

---

## Batch 8 — Rate limiting, timeouts, claims (needs Q5)

| Item | Change |
|---|---|
| **S1** Per-credential rate budget | Add a token bucket per Fusion integration: 300 requests per 60 s shared by POST and PATCH, with a configurable headroom of 80%. It must be shared across instances: use Catalyst Cache (segment + TTL keys per 60 s window) with a fallback to the process-local limit if the cache is unavailable. Fairness: a per-dealer cap on concurrent slots in `crmApiConcurrencyLimiter.js`, which the code comment claims exists but isn't enforced. |
| Cooldown | On 429, store the credential's cooldown until `now + Retry-After`; every caller checks it. |
| OEM timeouts | Add an Axios timeout (e.g. 15 s) to every `zohoCrmService.js` call. |
| **S3** Request deadlines | Each cron or fast-recover stage gets a time budget, e.g. `stopBy = start + 25 s` on Advanced I/O. Stop starting new work after it. Confirm the real function limit first (Q5). |
| **S4** Claims | When claim storage errors → defer to the retry queue instead of proceeding without a claim. Re-read the lead under the claim before building the payload. Add a dirty marker: if an edit arrives during `CONCURRENT_SYNC_IN_PROGRESS`, set `pending_resync=true`, and the claim holder drains it before releasing. Schema: possibly one column. |
| **L6** Credential save race | Make it insert-or-update on a unique key (verify the constraint), and add AAD to AES-GCM for integration ID and type. This needs a re-encrypt migration, so do it last or skip it. |

---

## Batch 9 — Datastore scale and load testing

This follows `SCALABILITY_TEST_PLAN.md` and the audit's §6 and §10, in an **isolated Catalyst project** with CRM stubs. It covers S5 (checkpointed full sync, fail visibly on truncation), S6 (cache mappings per batch), S7 (drain-rate measurement), S8 (cursor pagination where supported), and S11 (a durable incremental checkpoint, independent of logs). Split it into sub-batches when the session starts, based on measurements.

## Batch 10 — Changes-only PATCH and field ownership

Store the last-sent canonical payload per mapping (the fingerprint already exists; add a snapshot column) and send only the changed fields as merge-patch. Explicit clears become `null`. Define field ownership (dealer-owned fields are never overwritten by a stale OEM PATCH). It depends on Batch 3 (immutable payloads) and Batch 8 (claims/dirty marker).

---

## Open questions (owners: MG / Fusion / deployment)

| # | Question | Blocks |
|---|---|---|
| Q1 | MG status policy for Fusion: Update Pending, Contacted / Contact in Future → Open, Dropped → Prospect Lost; does Fusion Won mean MG Contacted (the current preset) or an order outcome / Delivered (the D1 workbook)? Enquiry outcome → which Fusion field? | Batch 4, and reviewing the `aa0045f` preset |
| Q2 | Payload rules: what to do when a lead exceeds 32 KB (truncate notes vs hold); first/last name split acceptable; campaign = dealer code or a real campaign value; enquiryType vocabulary mapping. | Batch 4 |
| Q3 | Fusion: a signed test webhook (secret encoding + example), enabled triggers and blocks, retry and suspension behavior, whether `lead_id` and flat `status` are what the dealer will actually send. | Batch 5 |
| Q4 | Production SLA scope and minutes, escalation window (local is 2 min / AU008), and whether SLA should apply to Fusion at all before the return channel is live. | Batch 7 |
| Q5 | The deployed function's real timeout, cron frequencies, the OEM Zoho edition and API credits, the production Fusion rate limit, and whether Catalyst Cache is available. | Batch 8 |
| Q6 | A skipped Fusion update (403 `updates_not_enabled`) on a lead that is FAILED and waiting for a retry: Batch 2 keeps the mapping FAILED, as this plan says. The retry sweep then re-sends the PATCH and logs SKIPPED on every fast-recover run until the dealer re-enables updates. Recommended: park it as HELD with reason `DEALER_UPDATES_DISABLED`; the next OEM edit or a manual Retry sync re-sends it. SYNCED leads are unaffected either way. Keep or change? | Batch 2 follow-up (small change in `crmIntegrationService.js`) |
| Q7 | Live status mappings (read 13 Oct 2026): 568026 and AU004 map MG Contacted ↔ Fusion Won and Contact in Future ↔ Delivered in both directions, so MG sends "Won" and "Delivered" out. The `aa0045f` preset makes those two inbound-only. 725001 maps MG Contacted ↔ Fusion Lost. Re-save these dealers with the agreed mappings once Q1 is answered? | Re-saving those dealers' status mappings (with Q1) |
| Q8 | AU008 (ZOHO_CRM) has base_url `https://www.example.in` (read 13 Oct 2026). The generic adapter sends every create, update and test request there, with the dealer's `Zoho-oauthtoken` header, so deliveries cannot reach Zoho. A deliberate demo setting, or should it be the dealer's Zoho API domain? | AU008 deliveries; token sent to a third-party host |
| Q9 | AU004's Fusion field mapping looks like leftover testing (read 13 Oct 2026): email_address → `contact.optinEmail`, postcode → `contact.optinPost`, dealer_code → `contact.areaCode`, receive_marketing_updates → `updates`. Re-apply the Fusion preset? | AU004 deliveries |
| Q10 | C1 idempotency: on a Fusion create retry, compare the payload's hash with the previous attempt's and skip the create when it changed and the previous outcome is unknown. This needs Fusion to confirm how long an Idempotency-Key is kept, and whether a key whose first request failed (4xx) can be reused with a corrected body. Until then, with `OUTBOUND_RETRY_POLICY=classified`, a 409 `idempotency_conflict` stops retrying. | Batch 3 follow-up (Fusion) |
| Q11 | Is Fusion's 409 `lead_not_ready` ever temporary? Batch 3's classifier treats every 409 as PERMANENT, as this plan and D2 (no retries of unchanged 4xx) say; an older adapter comment calls it transient. | Batch 3 classifier |
| Q12 | Extend the missing-ID safety (`ACK_UNRESOLVED`) to GENERIC_REST and ZOHO_CRM? Batch 3 limits it to Fusion: Zoho creates are idempotent upserts, and a generic dealer's idempotency is unknown. | Batch 3 follow-up |
| Q13 | Buckby MG (725001), the dealer currently in focus, points at Fusion's QA environment (`https://qa.fusionamspro.com/api/leadapi`, read 13 Oct 2026). Should it move to Fusion's production URL, and when? | Buckby go-live (admin config change) |
| Q14 | Which Source values does each Fusion dealer have? Batch 4 sends MG's Nature of Enquiry as Fusion `leadSource`. Fusion confirmed "Test Drive"; other values (Service Booking, General Enquiry, …) appear in the lead's notes once Fusion's change ships. | Display only |
| Q15 | Is MG's `Receive_Offers_Updates` a checkbox (always true or false), or can it be left unanswered? The lead sync stores false when Zoho has no value, for every dealer. Batch 4 left that alone and only stops Fusion receiving a value that is not clearly true or false. If MG can leave it unanswered, the sync must store "unknown" instead. | Consent accuracy for all dealers |
| Q16 | Which Fusion webhook fields may update MG? With the Batch 4 preset, Fusion's lead_source would overwrite MG's Nature of Enquiry, and phone formatting differences would raise Unhappy 6 alerts. | Batch 5 translator |
| Q17 | A webhook for a `lead_id` MG never sent (a lead the dealer created itself): hold it as Unhappy 7 or acknowledge it silently? | Batch 5 |
| Q18 | Fusion's `dealer_id` is "your own id for this dealer if you gave them one, otherwise ours". Reject an event whose `dealer_id` isn't MG's dealer code? | Batch 5 |
| Q19 | A Fusion dealer with both a signing secret and an `X-Webhook-Token` secret: require both, or the signature plus the token only when it is sent? | Batch 5 verifier |
| Q20 | Fusion: a real signed sample from Buckby's production account, to confirm (a) the signing secret's encoding (`whsec_<base64>` or plain), (b) that `lead.updated` carries the same `lead_id` as Fusion's 201 to our create, and (c) that `status` uses the enquiryStatus words (Open, Won, Delivered, Lost, Prospect Lost) rather than the dealer's own status names. | Switching `FUSION_INBOUND_V2` on |
| Q21 | Buckby MG's 6 lead mappings were all sent at or before the 12:16 switch to Fusion production (13 Oct), so their Fusion `lead_id`s are probably QA ids. Production webhooks will not match them (Unhappy 7). Re-deliver those leads to production? | Buckby inbound for existing leads |
| Q22 | Batch 6's durable event store (stored payloads, the C4 duplicate handling, replay from a stored payload): every CRM type, or Fusion only, and behind which switch? | Batch 6 |
| Q23 | Batch 6's S9 retention (deleting SUCCESS webhook event rows after N days): on by default at 30 days, or off until `WEBHOOK_EVENT_RETENTION_DAYS` is set? | Batch 6 |

### Answers (13 Oct 2026)

Fusion's emails to MG, shared on 13 Oct 2026, also settled several points:
- The MG lead ID shows in the lead's "Lead API" tag, and Fusion will add a dedicated field for it.
- Enquiry Type, Origin, Source and Campaign are enums. A value displays only when it matches one the dealer has mapped. Fusion suggested Internet, Manufacturer Lead and Test Drive as test values.
- Fusion is changing its system so that values that don't match appear in the lead's notes.
- Fusion doesn't need the dealer code. It adds digital consent automatically.
- For status updates (Batch 5), Fusion asked for the webhook URL, the authentication method and the setup details.

| # | Answer | Next |
|---|---|---|
| Q1 | Outbound: D1, extended to every MG status. These go to Open: Not Contacted, Follow-up 1, Follow-up 2, Attempted to Contact, Contacted, Contact in Future and Pre-Qualified. These go to Prospect Lost: Not Qualified, Dropped, Lost, Junk Lead and Lost Lead. Update Pending, Dealer Unavailable and Unattended Alert stay MG-only and are left out. Fusion Won and Delivered leave MG unchanged (no inbound rule). Fusion Open, Lost and Prospect Lost keep today's inbound rules: Not Contacted, Lost and Not Qualified. Enquiry outcome is not sent (MG to decide). | Batch 4. Batch 5 must stop Fusion "Open" from moving a progressed MG lead back to Not Contacted. Contacted and similar statuses now go out as Open. |
| Q2 | Split first and last name. Over 32 KB: trim the longest text fields and still send. Fusion enums, following Fusion's guidance: Enquiry Type comes from MG's lead source channel (Phone → Phone, Walk-in → Walk In, everything else → Internet). Origin is always "Manufacturer Lead". Source is MG's Nature of Enquiry. Campaign is not sent. | Batch 4. The name split needs `first_name` and `last_name` text columns on `leads` (Catalyst console), then `LEAD_NAME_PARTS=true`. |
| Q3 | Build Batch 5 from Fusion's documented Standard Webhooks spec, behind `FUSION_INBOUND_V2` (off). Check it against a real Fusion sample before switching it on. | Batch 5 unblocked |
| Q4 | Fusion dealers stay exempt from the dealer-action SLA until their return channel is live. Production minutes are not decided. The live values (AU008 only, 2 minutes) are demo values. | Batch 7 unblocked (C3 gate) |
| Q5 | Use safe, configurable defaults: Fusion's documented 300 requests per minute per credential at 80% headroom, a 15 s timeout on Zoho calls, and a 25 s work budget per cron run. A read-only check (13 Oct) found that only `/cron/fast-recover` is scheduled (every 2 min). Catalyst Cache is available (Default segment). The API does not expose the function timeout. | Batch 8 unblocked |
| Q6 | Park it as HELD, with reason `DEALER_UPDATES_DISABLED`. | Batch 4 (small change) |
| Q7 | Fix now: an admin uses "Load Fusion default map" and saves it for 725001 (Buckby MG) and 568026, then re-saves with the D1 preset after Batch 4. On 13 Oct, all of 725001's leads were Not Contacted, so none had been sent as "Lost". 568026's lead 44707000060074862 was probably sent as "Won". | Admin action |
| Q8 | Set AU008's base URL to the dealer's Zoho API domain, and revoke and regenerate the AU008 dealer Zoho token. Test connections to `www.example.in` returned HTTP 200 on 6–8 Oct. | Admin action |
| Q9 | Moot: AU004 no longer has an integration row (13 Oct). 10 orphaned status-mapping rows remain. | None |
| Q10, Q11 | Keep Batch 3's safe handling. Ask Fusion. | Open (Fusion) |
| Q12 | Keep it Fusion-only. No GENERIC_REST dealer exists (13 Oct). | Revisit when one is onboarded |
| Q13 | Answered by the switch itself: Buckby MG (725001) moved to Fusion production (`https://app.fusionamspro.com/api/leadapi`) at 12:16 on 13 Oct 2026, with inbound turned on. 568026 stays on QA. | None |
| Q16 | Status only. Every other webhook field is ignored for Fusion (13 Oct 2026). | Batch 5 |
| Q17 | Keep today's Unhappy 7 hold (one alert per lead, answered 202). It can't be replayed for Fusion before Batch 6. | Batch 5 |
| Q18 | Log a mismatch, don't reject. Reject only when `dealer_id` is a different MG dealer's code. The per-dealer signing secret already proves the sender. | Batch 5 |
| Q19 | A valid signature is required; an `X-Webhook-Token` header, when sent, must also match. | Batch 5 |
| Q22 | Fusion only, behind a new flag `INBOUND_EVENT_STORE` (default off). AU008 and generic dealers keep today's handling. | Batch 6 |
| Q23 | Off until `WEBHOOK_EVENT_RETENTION_DAYS` is set. When set, it runs once a day in fast-recover and in daily-error-report. | Batch 6 |

Batch 9 is skipped for now: there is no isolated Catalyst project for load testing.

## Status

| Batch | Status | Branch / commit | Tests after | Notes |
|---|---|---|---|---|
| 0 | Done (12 Oct 2026) | `fusion/batch-0-baseline`: `5a05737` docs, `2ecd23b` .gitattributes, `6541642` test helpers | 345 pass, 0 fail (334 baseline + 11 helper self-tests) on Node 20.20.2; frontend build passes (18 existing warnings) | Run the gate on Node ≥ 20.4 (deploy stack is node20): on Node 18, 3 `sweepStarvation` tests fail on the `mock.timers` API. `SCALABILITY_TEST_PLAN.md` was already identical to HEAD (stale index entry only); the 32 CRLF-only files were restored. `.bin` exec bits fixed locally, so `npm run build` works. |
| 1 | Done (13 Oct 2026) | `fusion/batch-1-security-hygiene`: `22df517` M1/M2, `6619855` M9, `4053e64` H3, `c49570f` M6, `94978da` + `de4a4aa` M7/L2, `9976229` S10, `5a3be46` L4, `fbca793` L3 | 371 pass, 0 fail (345 + 26 new) on Node 20.20.2; frontend build passes (18 existing warnings) | Read-only live checks (13 Oct): no saved mapping or base_url is refused by the new save rules; every Fusion lead id matches the M6 rule; live ZCQL refuses `LIMIT 0, 500`, confirming S10. Deploy: the first fast-recover run emails one catch-up digest (16 failures queued on 13 Oct). Fusion-only behaviour change: a token-endpoint 401/403 during a sync now marks the integration ERROR (L2). M6 changed 3 existing tests on purpose. No new env vars. |
| 2 | Done (13 Oct 2026); Q6 answered, done in Batch 4 (`4000616`) | `fusion/batch-2-outbound-status`: `9823d79` issue #2, `c9731da` M5, `804b9f5` H4 skipped updates, `17ddc27` H4 update outcome (`9564981` records Q6–Q9) | 386 pass, 0 fail (371 + 15 new) on Node 20.20.2; frontend build passes (18 existing warnings) | Open: Q6, whether a skipped update should park a FAILED mapping as HELD; for now it keeps FAILED, as this plan says. UI: SKIPPED and "Awaiting dealer acceptance" are rendered where integration logs appear: the lead timeline (LeadDetailView), the dealer config activity log, the Integrations page and the dealer drawer. `SyncLogsPage` shows lead-sync runs, not these logs. Read-only live checks (13 Oct): no live Fusion dealer has inbound-only status rows yet, no lead is held for that reason, and no update has been refused with 403. No schema change: logs use the existing `status` (varchar 20) and `field_changes` (text, 10,000) columns. No new env vars. |
| 3 | Done (13 Oct 2026); Q10–Q12 open | `fusion/batch-3-retry-safety`: `64290ae` error classifier, `8f4f717` S2 retry policy, `c545b7e` S2 fast-recover schedule, `bb1640b` C2/L5 escalation, `b0aa68b` + `9f82ec7` C1 ACK_UNRESOLVED and admin link/replay, `11e8d03` UI (`9d6a491` records Q10–Q12) | 415 pass, 0 fail (386 + 29 new) on Node 20.20.2; frontend build passes (18 existing warnings) | New env vars, read in `config/env.js`; unset keeps today's behaviour. `OUTBOUND_RETRY_POLICY=classified`: backoff from 2 min to 6 h with ±20% jitter, honouring the dealer's Retry-After; AUTH and PERMANENT failures, and retries past `OUTBOUND_RETRY_MAX_ATTEMPTS` (default 10) or `OUTBOUND_RETRY_MAX_AGE_HOURS` (default 48), stop as `RETRY_EXHAUSTED`. Also `FAST_RECOVER_HONOUR_SCHEDULE=true` and `ESCALATION_TRANSIENT_ONLY=true` (C2/L5). Deploy: fast-recover (every 2 min) is the only live retry cron, so set `FAST_RECOVER_HONOUR_SCHEDULE` together with the classified policy; otherwise the 10 attempts are used up in about 20 minutes. These vars are not yet in the runbook's production checklist, because .md files were left untouched. Always on, Fusion only: a create answered 2xx without a lead id becomes `ACK_UNRESOLVED` (Unhappy 11, one alert, payload sha256 in the log) and is never created again. GENERIC_REST and ZOHO_CRM keep today's retry (Q12). From the lead detail, admins link the dealer's lead id for an `ACK_UNRESOLVED` lead, or retry a `RETRY_EXHAUSTED` one. These use new admin-only routes `POST /admin/dealers/:dealerCode/integration/link-lead` and `/replay`; replay refuses a DISABLED integration, as a manual sync does. No schema change. A read-only check (13 Oct) found `lead_integrations.sync_status` is varchar 25, and `failure_streak_started_at` and `leads.sync_status` are text. The stop reason goes in the failure log's `retry` entry. Pre-existing: `routes/dealerCrmIntegrationRoutes.js` contains a literal NUL byte, so git diffs it as binary (use `git diff --text`); left as is. |
| 4 | Done (13 Oct 2026); Q14, Q15 open | `fusion/batch-4-mapping-contract`: `f8f5fc8` H2 outbound-only status rows and D1 preset, `6ec7816` H1 Fusion payload rules and 32 KB, `b8f63db` Q2 enquiry type, origin and source, `6942b95` Q2 name split, `4000616` Q6 parking, `d87db98` token-timeout label, `5e0cb4e` happy-path acceptance tests (`0ad53b3` records the answers) | 449 pass, 0 fail (415 + 34 new) on Node 20.20.2; frontend build passes (18 existing warnings) | Fusion only. ZOHO_CRM and GENERIC_REST payloads and mapping checks are unchanged (covered by tests). Nothing changes for a dealer until an admin re-saves its mappings. For every Fusion dealer (725001 Buckby MG, now on production; 568026; AU001 and AU013 once configured), in Dealer CRM config: on the Field Mapping tab, "Load Fusion default map" then Save; on the Status Mapping tab, "Load Fusion default map" then "Save Status Mapping". This replaces 568026's hand-made rows (`enquiry_outcome` → `activity.subType`, `lead_department` → `origin`). Until then, Buckby's live status map (re-saved at 11:57 on 13 Oct) still sends Contacted as "Lost". Loading today's preset fixes that now, without a deploy. After the re-save, Fusion receives: enquiryType Internet, Phone or Walk In; origin "Manufacturer Lead"; leadSource = Nature of Enquiry; no campaign; marketing consent as `contact.marketingOptinEmail` (old `optinEmail` values stay in Fusion for existing leads); an unknown consent left out; empty optional fields left out of creates; lostReason only with Prospect Lost or Lost; bodies over 32 KB trimmed; D1 statuses (Contacted etc. → Open, Lost etc. → Prospect Lost). Update Pending is still left out. New env var `LEAD_NAME_PARTS` (default off). Add `first_name` and `last_name` (text) to `leads` in the Catalyst console first, or every lead write fails. Don't turn it off afterwards. Existing leads get their name parts on their next OEM sync, without a dealer update. Until the flag is on, Fusion gets the full name as the first name, as before. Q6: a refused update on a lead waiting to retry is parked HELD; one Batch 2 test was changed on purpose. A Fusion token timeout is now `EXTERNAL_CRM_ERROR`, not AUTHENTICATION_FAILED. Happy 1, 4 and 5 are verified end to end with the new presets. Happy 3 is MG-side and unchanged. Happy 2 for Fusion needs Batch 5. Batch 5 note: with the new preset, Fusion's leadSource would map back to MG's Nature of Enquiry (dealer-writable by default), and contact.firstName/lastName to first_name/last_name (not written to MG). The Batch 5 translator must choose which webhook fields come back. The Fusion spec dated 13 Oct (`lead-api-mg-motors-openapi 3.yaml`, repo root, untracked) documents the webhook format for Batch 5. No schema change in code. |
| 5 | Done (13 Oct 2026); Q20, Q21 open | `fusion/batch-5-fusion-inbound`: `d63dc43` flag and signing secret, `0642591` Standard Webhooks verifier, `505474b` webhook-id event id, `4f80c25` translator (Q16–Q18), `bde01bd` Open guard and Won/Delivered, `7bdfee2` end-to-end and capability, `3bc8e5e` status echo (`a300631` records Q16–Q21) | 532 pass, 0 fail (449 + 83 new) on Node 20.20.2; frontend build passes (18 existing warnings) | Everything is behind the new env var `FUSION_INBOUND_V2` (default off) and applies to FUSION_SD only. With it unset, inbound, the X-Webhook-Token check and AU008 (ZOHO_CRM) are unchanged (covered by tests). With it on, for a Fusion dealer: a request carrying `webhook-signature` is verified the Standard Webhooks way (HMAC-SHA256 over `id.timestamp.body`, any `v1,` entry, constant-time, 300 s window) with the dealer's `WEBHOOK_SIGNING_SECRET`; an `X-Webhook-Token` sent alongside must also match (Q19); a request without the signature keeps today's token check. `webhook-id` is the dedupe key. The flat PushedLead body is translated by `adapters/fusionSdInbound.js`: `lead_id` is the dealer lead id and only the status comes back (Q16); a null value is unknown, not a clear; a body with no status (notes, activities) is answered 200 with nothing written or held. Status rules (Q1): a Fusion status equal to what MG's current status is sent as changes nothing (so Fusion Open never rolls a progressed lead back to Not Contacted, and an echoed Prospect Lost never turns MG Lost into Not Qualified); Open moves only a lead still at Update Pending; Won and Delivered leave MG unchanged without a hold unless an admin adds an inbound row; any other unmapped status is held as Unhappy 4, as today. An unknown `lead_id` (a dealer-created lead) is held as Unhappy 7 (Q17); Fusion holds cannot be replayed before Batch 6. A `dealer_id` naming a different MG dealer is refused with 401; Fusion's own id is only logged (Q18). `fusionSdAdapter.capabilities.webhook` follows the flag. Admin UI: a Fusion-only "Webhook Signing Secret" field (stored encrypted as `WEBHOOK_SIGNING_SECRET`; `whsec_<base64>` is decoded, a bare value is tried as given and base64-decoded until Q20 confirms the encoding). Before turning the flag on, for each Fusion dealer: (1) re-save the Batch 4 presets. Buckby's live status map (read 13 Oct) still maps MG Contacted → Fusion Lost **and Fusion Lost → MG Contacted**, so with the flag on a lead Buckby loses would show as Contacted in MG; (2) paste the signing secret Fusion issues into the new field and keep "send updates back" on; (3) give Fusion the webhook details below. Webhook for Fusion: `POST https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function/webhooks/dealers/<dealerCode>` (725001 for Buckby MG), Standard Webhooks signing, events `lead.updated` (status block is enough; the whole lead also works) and optionally `lead.pushed`; leave conversation, test drive, trade-in and activity events off. Then check one real signed sample (Q20) before relying on it. No schema change. `catalyst-config.json` and the runbook were left untouched (they hold live secrets / are .md). |
| 6 | Not started (after 5) | | | |
| 7 | Not started (Q4 answered) | | | |
| 8 | Not started (Q5: safe defaults) | | | |
| 9 | Skipped for now (no isolated Catalyst project) | | | |
| 10 | Not started (after 3, 8) | | | |
