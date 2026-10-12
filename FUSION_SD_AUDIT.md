# Fusion SD Lead Exchange: Verified Audit and Improvement Plan

| | |
|---|---|
| Reviewed | 9 October 2026 |
| Source revision | `bd76283` |
| Scope | Lead Exchange scalability, API limits, concurrency, duplicate prevention, retries, errors, database access, Fusion field mapping and dealer-to-OEM updates |
| Changes made | This audit document only. No application code, CRM records, credentials, schedules or infrastructure were changed. |
| Validation | Current source review, all three supplied documents, 319 existing backend tests, and isolated probes with synthetic data and mocked HTTP/credentials |
| Not verified | Deployed revision/configuration, live database schema/indexes, current CRM UI/storage, account quotas, production traffic or performance at lakh-scale |

## 1. Assessment

**The current implementation cannot yet be certified to process lakhs of leads without lag or stability issues.** Successful initial delivery proves connectivity and part of the mapping. It does not prove sustained throughput, recovery capacity or bidirectional correctness.

There are useful foundations: incremental OEM reads, paginated lists, bounded dealer API concurrency, persistent failure records, unique-key-based claims, duplicate matching and echo suppression. However, the application does not enforce Fusion's documented per-credential request rate across instances. It processes webhooks synchronously, has unbounded retry lifetimes, and has several delivery-state and mapping defects. The Fusion return workflow is documented by the vendor but is not implemented compatibly here.

Distinguish **1–2 lakh stored leads** from **1–2 lakh leads arriving in a day or burst**. The former requires measured database/UI performance; the latter also requires queues and sufficient CRM API capacity. Neither has been load-tested in this audit. [SCALABILITY_TEST_PLAN.md](SCALABILITY_TEST_PLAN.md) explicitly describes its load tests as unexecuted.

### Evidence and source conventions

Backend paths below are relative to `functions/mg_motors_au_function/`. Frontend paths begin with `mg-motor-web/`. Code line references apply to `bd76283`.

| Reference | Source and scope |
|---|---|
| D1 | [CRM fields for Exchange.xlsx](../CRM%20fields%20for%20Exchange.xlsx), sheets **MG CRM Matrix** and **Fusion SD Map**. MG requirements and proposed business mappings; not evidence of the deployed configuration. |
| D2 | [lead-api-mg-motors-guide 7.pdf](../lead-api-mg-motors-guide%207.pdf), generated 8 October 2026, 17:42:14, for MG Motors — Sandbox. Page references below use physical PDF pages 1–14; printed footers differ. |
| D3 | [lead-api-mg-motors-openapi 3.yaml](../lead-api-mg-motors-openapi%203.yaml), OpenAPI 3.1, API version 1.0.0, for the same sandbox. Relevant sections: `paths`, `webhooks`, `AmsProLead`, `PushedLead`, `LeadAccepted`, `LeadUpdated`. |

D2/D3 describe that sandbox's configuration when exported. Production hosts, enabled triggers, field values and limits must be checked against the production contract. No authenticated live vendor calls were made in this audit.

### Corrections to the previous audit

| Previous statement | Verified correction |
|---|---|
| Fusion has no webhook documentation/support | **Incorrect.** D2 pp. 11–13 and D3 `webhooks` document it. The current adapter/configuration disables it. |
| Create responses do not contain an ID | D3 documents `201` JSON with required `lead_id`; the adapter already reads it. Empty responses are mentioned in an older code comment, but no raw live response was provided for this review. Treat missing ID as a conditional anomaly, not normal Fusion behavior. |
| `refID`, source, type and campaign field names are unknown | These fields are documented. Unrecognised dealer-specific values are retained for later mapping; rejection must not be assumed. |
| `contact.areaCode` probably means phone area code | Withdrawn. It is a supported contact field, `contact.phoneCode` is separate, and the user reports successful area-code visibility. No evidence establishes this mapping as defective. |
| Add raw enquiry outcome to `activity.subType` | Unsafe as a general fix. Activities are scheduled records requiring `activity.startDate`; their type enum cannot represent all MG outcomes. |
| Every delivered Fusion lead breaches after 24h | Overstated. Breach depends on scope, status, integration health, last-sync time, scheduler execution and configured SLA. Local configuration uses a two-minute SLA scoped to `AU008`; live values were not checked. |
| A bare 403 error code needs tolerant matching | The documented `type` URI ends in `/updates_not_enabled` and matches existing code. Alternative undocumented formats are not a confirmed defect. The confirmed defect is ignoring `result.skipped`. |
| `lead_not_ready` is documented as transient | D2's error table and final page advise against unchanged 4xx retries, including this 409. Any special transient exception needs Fusion confirmation. |
| OAuth scopes must be requested explicitly | D3 says omission grants all scopes held by the credential. Lack of scope validation is a diagnostic gap; omitting `scope` is not an authentication bug. |
| Duplicate prevention is guaranteed by existing guards | It depends on deployed unique constraints and working claim storage. Claims deliberately fail open on storage errors; their leases can also expire during processing. |
| All Fusion secrets are secure because they are encrypted | Stored dealer credentials use AES-GCM. This alone does not establish deployment secret hygiene. The local config contains plaintext secrets and is not currently tracked by Git; the old repository guidance's claim that it is currently committed was not substantiated. No secret values are reproduced here. |

## 2. Confirmed API contract and capacity implications

| Item | Documented contract | Current implementation / implication |
|---|---|---|
| API base | `{dealerHost}/api/leadapi` | Configure `base_url` with this prefix; adapter appends `/oauth2/token` and `/v1/leads`. D2 p. 1. |
| Authentication | OAuth client credentials; Basic access-key/secret-key pair; form body `grant_type=client_credentials`; opaque token valid for 600 seconds | Request format is correct. Cached per integration and process; refreshes five minutes before expiry. D3 `/oauth2/token`; `fusionSdOAuthHelper.js:42–113`. |
| Create | `POST /v1/leads`, JSON, `leads:write` | Implemented with a 10-second HTTP timeout. D3 `/v1/leads`; `fusionSdAdapter.js:147–175`. |
| Create response | `201 {lead_id, status: "received", received_at}` | `lead_id` extraction works. Receipt does not itself establish visibility in the dealer's live enquiry. |
| Update | `PATCH /v1/leads/{lead_id}`, `application/merge-patch+json`, only changed fields, `leads:update` | Method/content type are correct, but the orchestrator supplies the full mapped lead. D3 PATCH; `crmIntegrationService.js:705–733`. |
| Ownership | A credential can update only leads it submitted | Credential/provider changes can produce 404 even for an existing ID. Do not automatically recreate that lead. D3 PATCH description. |
| Rate limit | **300 requests per credential per 60 seconds, shared between POST and PATCH** | Approximately 5 requests/second averaged over a minute; this is not a guarantee of a particular burst algorithm. Current semaphore does not enforce this rate. D3 POST description, line 115. |
| Throttling | 429 supplies `Retry-After` | Wrapper discards response headers; scheduler cannot honour this value. D3 `RateLimited`; `fusionSdAdapter.js:104–119`. Token endpoint also documents 429; its separate allowance is not specified. |
| Body size | POST bodies above 32 KB are refused | No Fusion-specific byte-size check; large mapped notes/transcripts can exceed it. D3 POST description. |
| Idempotency | Same key retries the same request; different body with the same key gives 409 `idempotency_conflict` | Key is the OEM record ID. Suitable for repeated identical creation, but current retries rebuild the payload from mutable local state. Retention window is not specified. D3 `IdempotencyKey`. |
| PATCH diagnostics | `updated_fields`, optional `ignored_fields`, `update_mode`, `enquiry_linked` | Available in `raw`, but not interpreted by the orchestrator. `manual` means held for a person; ignored fields were not applied. D3 `LeadUpdated`. |
| Read/reconciliation | No lead GET/list/search operation is supplied | `getLead` is correctly disabled for this adapter. Do not invent an endpoint. This does not mean webhooks are unsupported. |

For **one credential**, a first-order capacity estimate is `N × (1 + updates per lead + extra attempts per lead) / 300` minutes. This is API quota arithmetic, not an application benchmark; window alignment, latency, other callers and operational headroom change the actual time.

| Work through one credential | Nominal minimum at the published allowance |
|---|---:|
| 100,000 creates, no updates/retries | About 333 minutes / 5h 33m |
| 200,000 creates, no updates/retries | About 667 minutes / 11h 7m |
| 100,000 creates plus three updates each | About 1,333 minutes / 22h 13m |

Independent dealer credentials may increase aggregate capacity, but shared OEM CRM quotas, middleware storage, and any vendor-wide limits still constrain it. A hot dealer must not consume every worker slot.

Zoho CRM separately applies rolling credit allowances and per-organisation/app concurrency limits. Its published concurrent-call limits are 5 for Free, 10 for Standard/Starter, 15 for Professional, 20 for Enterprise/Zoho One and 25 for Ultimate/CRM Plus; selected operations also share a sub-concurrency limit of 10. The exact OEM edition, licences, available credits and competing integrations were not supplied, so the deployment's available budget remains unverified. [Zoho CRM v8 API limits](https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html).

## 3. Field mapping verification

The user's observation that five fields are visible is accepted as the test report. The actual request/response and Fusion record were not available to this audit. Therefore, the table confirms **schema support and code behavior**, not that each value was sent or persisted in that particular test. UI section names and field visibility permissions need a dealer-side check.

| MG field → configured Fusion target | Verified result and action |
|---|---|
| Accept Privacy Policy → `privacy` | **Not a documented `AmsProLead` field.** The frontend explicitly uses it as an ignored placeholder for mandatory middleware mapping. Keep MG's privacy gate; do not equate this key with stored Fusion consent. D1 says privacy transfer is not required in phase 1. Separate internal mandatory policy from external field mapping. |
| Vehicle Model → `requirement.model` | Supported; vehicle requirement block. User reports it visible. |
| Enquiry Outcome → `activity.subType` | Supported field, **wrong general meaning**. Allowed codes: `appointment`, `testdrive`, `call`, `email`, `delivery`. An activity needs `activity.startDate`; subtype alone does not create a calendar item. MG Retail/Fleet Order, Lost and Outcome Pending are not activity types. Use an approved outcome transformation; send Test Drive as `testdrive` only with valid scheduling data. Not present in the default Fusion preset. D2 p. 10; D1 `Fusion SD Map` D7:E12. |
| Customer Name → `contact.firstName` | Supported, but source concatenates first and last names. Preserve the original OEM parts and map `contact.firstName`/`contact.lastName` separately in a future change. Current full-name-in-first-name format meets the documented name-presence rule; it is a data-quality issue. |
| Mobile Number → `contact.phone` | Supported; Fusion normalises digits/country code. User reports it visible. |
| Postcode → `contact.areaCode` | Supported string field. User reports it visible; no confirmed mapping defect. Verify leading zero preservation and its display label in QA. |
| Lead Source → `leadSource` | Supported. Dealer-configured values; unknown values are retained for later mapping. Inspect source/reporting configuration instead of assuming the field name is invalid. D2 p. 4. |
| Dealer Rejected Reason → `lostReason` | Supported, but D2 p. 11 says it is applied only with a lost status. Empty source values currently pass through as `""`. Confirm the OEM source exists and the business meaning of rejection versus commercial loss. D3's webhook schema does not explicitly expose `lostReason` in the return payload. |
| Enquiry ID → `refID` | Supported provider reference. Middleware falls back to the OEM record ID if `enquiry_id` is empty. It is distinct from Fusion `lead_id` and Fusion's internal `enquiry_id`. No evidence of a schema-name mismatch. |
| Lead Status → `enquiryStatus` | Supported. Standard values: Open, Won, Delivered, Lost, Prospect Lost. Current code omits it for OEM-only states such as Update Pending, on **either create or update**; it sends translated values for other mapped states. Missing status mappings hold the whole delivery. |
| Dealer Code → `campaign` | `campaign` is supported, but means campaign attribution, not dealer routing. Dealer routing comes from the configured host/provider credentials. Only overload campaign with a dealer code if explicitly agreed; request the dealer's expected campaign values. |
| Email Address → `contact.email` | Supported. Fusion silently drops malformed email; a usable phone can still let the lead succeed. User reports it visible. D2 pp. 3, 5. |
| Nature of Enquiry → `enquiryType` | Supported, but different vocabulary. This sandbox lists Internet/Web, Phone, Walk In; MG has Test Drive, Finance Enquiry, Service Booking, etc. Unknown values are retained, not necessarily mapped to the live enquiry. D1 asks to share MG values; agree the destination mapping. |
| Receive Marketing Updates → `contact.optinEmail` | Both this field and **`contact.marketingOptinEmail`** exist. D1 specifically maps marketing consent to the latter (`Fusion SD Map` I7). Current preset selects general email opt-in instead. Do not assume these consents are interchangeable. Preserve unknown versus false. |

Sources: D3 `AmsProLead` and `x-ams-pro-fields`; D2 pp. 3–6, 10–11; `leadSyncService.js:102–158`; `leadMappingService.js:22–49`; `crmIntegrationService.js:456–491`; `mg-motor-web/src/pages/Dealers/DealerCRMConfig.jsx:174–201`.

### H1 — Mapping and payload gaps [High, confirmed]

`mapZohoLeadToExternal` copies values without using `data_type`, and sends most optional empty strings/nulls. The source mapper defaults missing marketing consent to `false`. This can turn an unrecorded answer into a refusal, while D2 explicitly distinguishes unknown consent. This is more substantial than the previous audit's unproven claim that string booleans explain the missing fields: Fusion documents acceptance of several boolean string forms.

Use a tri-state boolean parser that rejects invalid values and preserves unknown. Do not use the current `isTrue()` as a generic coercer: every unrecognised input would become false. For PATCH, distinguish absent fields from **intentional clears**; blanket removal of every null would prevent valid merge-patch deletions. Preserve original name parts rather than guessing a split of a combined name.

`Dealer_Rejected_Reason` is read in `leadSyncService.js`, but the OEM writeback map comments say it does not exist. D1 does not settle this. Check live OEM metadata before promising that rejected reasons round-trip. Also review required-by-MG fields missing from the preset, including department, variant and powertrain; their business destinations are not resolved merely by the 14 mappings above.

**Acceptance:** a captured synthetic request matches the agreed contract, consent remains true/false/unknown correctly, and each intended value is confirmed in Fusion's stored lead or its accepted enquiry. Do not require every supported field to appear on the same CRM screen.

### H2 — Workbook status mapping cannot be represented by current configuration [High, confirmed]

| D1 MG status | D1 Fusion status | Current code discrepancy |
|---|---|---|
| Update Pending | Open | Explicitly treated as OEM-only and omitted; save route rejects it as a status mapping. |
| Not Contacted | Open | Present in preset. |
| Contacted / Contact in Future | Open | Absent from preset. |
| Not Qualified / Dropped / Lost | Prospect Lost | Only Not Qualified matches; Dropped is absent; current Lost maps to Lost. |
| PMA Unassigned / Dealer Unavailable | No value | Keep internal workflow states separate from dealer progress. Workbook spelling of PMA Unassigned also needs normalisation. |

The save route enforces one-to-one reversible status pairs (`dealerCrmIntegrationRoutes.js:319–365`). Adding multiple MG statuses mapped to Open or Prospect Lost is rejected as `STATUS_MAPPING_AMBIGUOUS`. Thus this is **not just a missing preset entry**.

Implement separate directional mappings, allowing many MG states to map to one Fusion state while requiring an explicit reverse rule. Fusion Open alone cannot reveal whether MG should be Not Contacted, Contacted or Contact in Future. Prefer preserving current MG progress unless a richer dealer event justifies change. D1's outcomes also propose Won → Delivered for order outcomes, which needs MG business rules rather than inference from enquiry status alone.

D1 and current internal policy disagree on Update Pending and Lost. Reconcile that policy before changing behavior. Do not silently bypass MG's status validation because Fusion allows an optional status.

## 4. Dealer-to-OEM webhook workflow

### H5 — Fusion supports webhooks; the current implementation is incompatible [High, confirmed]

| Requirement from D2/D3 | Current behavior |
|---|---|
| Enable receiver for Fusion | Saving Fusion sets `inbound_enabled: false`; route returns 404. Adapter advertises `webhook: false`. `dealerCrmIntegrationRoutes.js:150–152`, `webhookRoutes.js:63–68`, `fusionSdAdapter.js:75–81`. |
| Standard Webhooks signature | Verifier reads `x-signature`/`x-webhook-signature`, computes hex HMAC of body only. Fusion uses `webhook-signature` and base64 HMAC of `id.timestamp.rawBody`. `webhookVerificationService.js:30–31,110–116`. |
| Timestamp replay protection | No Fusion `webhook-timestamp` freshness check. |
| Deduplicate `webhook-id` | Route reads `x-webhook-id`/`x-event-id` or body IDs, not the documented header. `webhookRoutes.js:94–99`. |
| Identify lead by `lead_id` | Generic handler accepts only `id`/`leadId`. `crmIntegrationService.js:1353–1366`. Configured `webhook_id_field` is not used here. |
| Read flat fields: `status`, `name`, `email`, `phone`, `postcode`, `model` | Current reverse mapper looks for outbound targets such as `enquiryStatus` and literal `contact.firstName`; it does not translate Fusion's return shape. `leadMappingService.js:58–68`, `crmIntegrationService.js:1684–1690`. |
| Process partial updates | Generic mapping already omits absent keys, but the Fusion translator and explicit null/consent handling are missing. `pushed_at` is delivery time, not a documented record version. |
| Handle first-time dealer-originated leads | Generic flow requires an existing `lead_integrations` mapping and otherwise holds Unhappy 7. Define the phase-2 create/routing/consent policy before subscribing to these. `crmIntegrationService.js:1532–1555`. |

Enabling the flag alone would expose successive authentication, identity and mapping failures. Implement and test a Fusion-specific inbound translator/verifier before enabling delivery.

### Endpoint and dealer setup

Fusion sends updates **to an HTTPS endpoint we supply**. There is no vendor-hosted URL to poll for dealer-to-OEM events in these documents. The existing relative receiver is:

```text
POST {middleware-public-base}/webhooks/dealers/{dealerCode}
```

The actual public base, including the deployed function prefix, must be supplied from the deployment. This route is **not currently ready for Fusion**. The reverse-direction API, for middleware-to-Fusion updates, is:

```text
PATCH {dealerHost}/api/leadapi/v1/leads/{lead_id}
Authorization: Bearer <Fusion access token>
Content-Type: application/merge-patch+json
```

D2 pp. 11–13 says setup is performed by the dealer, not self-service. Give the dealer the final HTTPS URL on port 443 (no redirects), desired authentication method, and our dealer identifier to return as `dealer_id`. Fusion offers API key header, bearer token, Basic auth or OAuth client credentials, as well as no extra endpoint authentication; choose an agreed authenticated option and validate the signature. OAuth setup also needs token URL, client credentials, credential placement and body encoding. These are vendor capabilities, not all implemented receiver options.

Fusion supplies the **webhook signing secret**. Store it separately from an optional bearer/API-key credential; the present generic verifier assumes one `WEBHOOK_SECRET` for its signature/token choices. Confirm secret encoding and rotation behavior with a signed test fixture. Use Standard Webhooks-compatible verification, including multiple signatures during rotation, constant-time comparison and a five-minute freshness window with controlled clock skew. The guide specifically requires rejection of timestamps older than five minutes.

### Documented events and triggers

| OpenAPI event | Meaning / exported setting |
|---|---|
| `lead.pushed` | Lead first handed to the provider. |
| `lead.updated` | Existing lead changed. |
| `conversation.message` | Salesperson note/message; context, not an instruction to change workflow. D2 also describes an optional separate conversation endpoint. Confirm its routing. |
| `testdrive.added`, `tradein.added`, `activity.added`, `activity.completed` | Available but explicitly **off** in this sandbox export; dealer can enable them. |

The dealer independently chooses **when** to notify (status, pipeline, stage, customer details, any lead change) and **which blocks** to send. Request status changes and enough accompanying data to map MG outcomes/rejections accurately. D3 does not define a distinct `dealer.rejected` event or a rejection-reason field in `PushedLead`; obtain a real example and agree its representation.

D3's event names are specification keys, **not an `event` property in the JSON**. The body is flat for core fields, while lists and trade-in/test-drive blocks can be nested. Missing fields in partial updates mean leave unchanged. Null consent means unknown, never automatically yes or no.

### Illustrative incoming status update

This is synthetic and uses documented field names; it is not a captured production payload or a signature test vector. Incoming status values are dealer-defined free text, even though the standard outbound statuses are Open/Won/Delivered/Lost/Prospect Lost.

```http
POST /webhooks/dealers/AU_TEST
Content-Type: application/json
webhook-id: evt_example_001
webhook-timestamp: <current Unix timestamp in seconds>
webhook-signature: v1,<base64 signature>
Authorization: Bearer <receiver token, if configured>
```

```json
{
  "lead_id": "lead_example_001",
  "dealer_id": "AU_TEST",
  "status": "Open",
  "pushed_at": "2026-10-09T10:00:00Z"
}
```

The signed bytes are `webhook-id + "." + webhook-timestamp + "." + rawBody`, using HMAC-SHA256, base64 encoding and the `v1,` signature prefix. Verify the original bytes before parsing or modifying JSON.

Fusion accepts any 2xx acknowledgement; no mandatory response JSON is specified. A future durable receiver could return `202 {"received":true}` **after safely storing the event**. Do not acknowledge work that exists only in process memory. Duplicate events may receive 2xx only when already completed or durably scheduled for recovery. Non-2xx deliveries are retried by Fusion with backoff; repeated failure suspends delivery pending intervention. Exact retry counts, delay schedule and resume procedure are not documented.

### C4 — Failed event redelivery can be discarded without recoverable payload [Critical for enabling Fusion inbound]

`checkAndRecordWebhookEvent` stores a dedupe key, payload hash and status, but no payload (`crmIntegrationService.js:2059–2091`). A repeated key is always treated as duplicate, irrespective of whether the first attempt is RECEIVED, FAILED or PENDING. The route acknowledges duplicates with 200 before further processing (`webhookRoutes.js:104–105`).

If processing fails or the function dies after the insert, provider redelivery may be discarded. Existing recovery fetches the dealer record through `adapter.getLead` (`crmIntegrationService.js:1479`), which Fusion does not support. Simply adding `webhook-id` deduplication without fixing this would make the failure mode reachable for Fusion.

**Recommendation:** persist the verified event body with appropriate access controls and retention, an atomic unique `(integration,eventId)` key, processing state, lease and retry metadata. Replay unfinished events from stored data; treat SUCCESS separately from FAILED/RECEIVED. Serialise changes per lead and define ordering/version rules. Preserve updates arriving before their outbound mapping exists. Capability-check GET-based recovery and use stored-event replay for Fusion.

**Acceptance:** crash after receipt, failed OEM write, duplicate while processing and later redelivery all recover exactly once at the business level; no successful acknowledgement can permanently discard unapplied work.

## 5. Delivery correctness and retry findings

### C1 — Missing-ID responses re-enter create indefinitely [Critical, conditional trigger confirmed]

`crmIntegrationService.js:726–751` throws `DEALER_ACK_MISSING_ID` when a successful create response has no recognised ID. Failure tracking creates a FAILED mapping without `external_crm_lead_id` (`252–317`), so the next attempt sends POST again. There is no overall retry-count/age ceiling. The existing missing-ID tests explicitly assert failure tracking; passing them does not establish safe recovery.

**Correction:** D3 requires `lead_id` and the adapter recognises it. This issue occurs only when the live response deviates, is unreadable, or an accepted create cannot be durably linked. Actual duplicate creation is conditional on Fusion's idempotency enforcement/retention; the documents specify no retention window. Do not state that duplicates are already occurring or that keys expire after 24h.

An OEM edit before linking changes the rebuilt payload while reusing the same key, causing the documented 409 conflict. A storage failure after a valid Fusion response can produce a similar uncertainty.

**Recommendation:** persist creation intent, immutable submitted payload/hash and operation key; retain a distinct proposed `ACK_UNRESOLVED` state for an apparently accepted response without a trustworthy ID. Keep it out of ordinary create retries, preserve diagnostics, and reconcile/link it through an agreed vendor mechanism. This state means linkage/business acceptance needs confirmation, not that the live enquiry definitely exists. Retry ambiguous network requests only with the same immutable payload/key under the documented guarantee. Never generate a fresh key merely to silence a conflict for a potentially accepted lead.

**Acceptance:** missing-ID responses cannot cause uncontrolled POST loops, false delivery success or automatic recreation. A normal D3 `201` response links successfully and later edits use PATCH.

### C2 — Generic escalation can overwrite valid business status [High; previous Critical finding narrowed]

All retryable failures share the same streak, including missing IDs, local queue saturation and update failures for already-delivered leads. Once the configured window passes, `crmIntegrationService.js:920–938` writes OEM/local `Dealer Unavailable`. That can mislabel a working dealer and replace an active lead's business state.

The default is 24 hours, but **the local deployment file overrides escalation to two minutes**. Live environment was not inspected. Separate integration health/delivery state from customer progress. Escalate configuration, local saturation, unknown acknowledgement and failed updates distinctly; only change OEM business status under an approved rule. Do not describe every failure as a dealer outage.

### C3 — SLA logic can report unobservable dealer action as a breach [High, configuration-dependent]

`slaMonitorService.js:78–108,181–234` checks age, healthy integration and a waiting MG status, but not whether a return channel is operational. Fusion inbound is disabled, so dealer action may never reach MG. If the Fusion dealer is in SLA scope and the lead remains waiting long enough, it can be marked Unattended Alert despite dealer action. This is a risk, not proof every alert is false.

The **local** file sets `DEALER_ACTION_SLA_MINUTES=2` and scopes it to `AU008`; the previous blanket all-Fusion/24-hour claim is withdrawn. `last_synced_at` is also reset on outbound updates and some sweep rotations, so it is not an immutable acknowledgement timestamp.

**Recommendation:** use explicit acknowledgement and last-dealer-action timestamps; gate automated action-based SLA decisions on a verified return channel or an approved manual process. Record channel-health exceptions separately. Restore intended production timing through configuration review, not assumed defaults.

### H4 — Skipped, ignored and manually held updates are recorded as delivered [High, confirmed]

For documented 403 `updates_not_enabled`, `fusionSdAdapter.js:253–285` returns `skipped:true`. The orchestrator ignores it, marks SYNCED/ACTIVE and writes success/recovery (`crmIntegrationService.js:754–887`). The documented error URI matches the adapter; no alternative format is needed to reproduce this defect.

For 200 PATCH responses, it also ignores `ignored_fields`, `updated_fields`, `update_mode` and `enquiry_linked`. A manual-mode update is a valid recorded submission, but not an applied enquiry update; a 200 with ignored fields is not field-level success. The previous audit's `enquiry_updated:false` wording reflects old code/tests, not D3's current response schema.

**Recommendation:** distinguish submitted, applied, awaiting dealer acceptance, unsupported fields and disabled updates. Do not retry a valid manual-mode submission simply because the enquiry did not change. Raise a configuration exception for disabled updates and report field-level rejection diagnostics.

### S1 — API concurrency control does not enforce rate limits [High, confirmed]

`crmApiConcurrencyLimiter.js:78–169` defaults to **10 active operations plus 60 waiters per CRM type, per warm process**. It is neither per credential nor distributed. Ten slots with 100 ms responses could start roughly 100 calls/second for one credential; multiple instances multiply that. Conversely, one dealer can occupy all ten Fusion slots with slow requests—the comment claiming at most one slot per dealer is not enforced by code.

OEM requests in `zohoCrmService.js` bypass this limiter and specify no timeout; no shared Axios timeout setup was found. Portal traffic, sync, SLA, retries and dealer return updates can compete for the same OEM quota. A hung OEM request also occupies a worker/claim longer than the dealer adapter's 10-second limit suggests.

**Recommendation:** shared per-credential Fusion rate budgets for POST/PATCH, per-dealer fairness, and separate shared OEM organisation/app budgets. Reserve capacity for updates and recovery, honour vendor cooldowns, add request/deadline timeouts to OEM calls and measure quota consumption. Configure against actual purchased quotas; do not just raise the semaphore count.

### S2 — Retries bypass scheduling and discard actionable errors [High, confirmed]

The normal retry interval is a fixed 15 minutes by default (`crmIntegrationService.js:62–67,256`), not exponential backoff with jitter. `/cron/fast-recover` uses `ignoreSchedule:true` (`cronRoutes.js:219–222`), bypassing `next_retry_at`. FAILED_CRITICAL rows remain candidates and have no terminal attempt/age limit.

`wrapFusionError` preserves only HTTP status on `response`, losing `Retry-After` and problem `type`. The orchestrator treats 401/403/404/409 as retryable except the special skipped-update case; 400/422 become a generic field-validation hold. Token endpoint network/429/5xx errors are all relabelled `AUTHENTICATION_FAILED`. D2 pp. 13–14 advises retrying 429/5xx and fixing 4xx; its `lead_not_ready` advice needs clarification if Fusion intends a transient exception.

**Recommendation:** preserve safe structured status/type/instance/retry-after diagnostics; retry only transient failures with capped exponential backoff and jitter. Use credential-level cooldown/circuit breaking, stop permanent errors until configuration/data changes, and park exhausted work with an owner/replay action. Every automatic recovery path must honour the same due time and rate budget. On ambiguous create timeouts apply C1's immutable idempotency rule. A 401 may justify one token invalidation/refresh attempt, not indefinite use of revoked credentials.

### S3 — HTTP request lifetimes are coupled to entire sync/sweep workloads [High, confirmed]

OEM and dealer webhook routes await CRM/database processing before responding (`webhookRoutes.js:38–46,108–134`). Incremental jobs form one process-local promise chain across dealers (`leadSyncService.js:880–885`) with no ingress depth/deadline bound. No durable OEM webhook inbox was found. A burst or slow dealer delays acknowledgement and can prompt provider retries.

Outbound recovery starts up to 50 attempts in batches of six (`outboundRetryScheduler.js:17–40,231–235`). With all dealer requests taking ten seconds, these batches alone take about **90 seconds**, before database work, token refreshes or other fast-recover stages. The 60-waiter semaphore can itself cause waits longer than a normal HTTP function budget; its queue-depth cap is not an execution-time guarantee. Only selected stages such as SLA have a time budget.

This deployment is configured as Advanced I/O. Zoho documents 30-second Basic/Advanced I/O and 900-second Event/Cron execution limits. A scheduled HTTP call to this Express route remains an Advanced I/O request; the `/cron/` name does not grant Cron-function runtime. Verify the actual deployed behavior, especially because older local notes report longer runs. [Catalyst timeout documentation](https://forums.catalyst.zoho.com/portal/en/kb/articles/catalyst-functions-and-timeout-10-11-2022).

**Recommendation:** verify/authenticate → durably store work → promptly acknowledge → process in bounded workers. Checkpoint imports, dispatch and retries, use per-lead ordering, and stop starting new work before the worker deadline. Existing failure rows provide partial persistence but are not a complete queue for all accepted work.

### S4 — Claims and competing updates have residual correctness gaps [High, confirmed design risks]

`outboundSyncClaimService.js:164–193` deliberately proceeds without a claim when claim storage errors. Effective exclusivity depends on an actual UNIQUE constraint on `outbound_sync_claims.claim_key`; an ordinary column is insufficient. The five-minute lease has no heartbeat or fencing token. A live operation outlasting the lease can overlap its replacement. Sweep guards and token single-flight caches are process-local.

An outbound edit arriving while a lead is claimed can return `CONCURRENT_SYNC_IN_PROGRESS` without a durable pending version. The local lead is updated before dispatch (`leadSyncService.js:757–772`); a later incremental read may see no change, while the previous worker writes an older payload and leaves the mapping SYNCED. This can lose propagation of an edit, not merely delay it. Ordinary outbound processing builds from the passed `leadRow`, rather than re-reading that lead under its claim.

**Recommendation:** verify unique constraints, fail safely into a durable retry queue when claims are unavailable, and use a lease/fencing strategy matched to real execution budgets. Persist a pending revision or dirty marker, re-read/revalidate current state under the claim and drain newer revisions before completing. Test multi-instance OEM edits against inbound dealer updates and SLA workers. Fingerprint echo suppression is useful, but it is not version-based conflict resolution.

## 6. Database and backlog scalability

| Finding | Evidence and impact | Recommended change / verification |
|---|---|---|
| S5 — Full sync materialises large datasets and can perform quadratic duplicate comparisons [High] | `zohoCrmService.js:145–190` accumulates OEM pages. `leadSyncService.js:187–201,230–235,474–485,538` loads local rows into memory and serially processes records; new-record duplicate checks scan known rows. Local full-sync read stops at **500,000 rows** (`FULL_SYNC_LEAD_ROW_BOUND`); truncation is logged, not treated as an incomplete snapshot failure. | Keep normal incremental reads. Move bulk recovery/import to checkpointed pages; use indexed/persisted business fingerprints plus time-window checks, and fail visibly on partial snapshots. Measure memory and duration at 100k/200k; do not run this synchronously as a production load experiment. |
| S6 — Repeated per-lead database operations [High at scale] | Each outbound attempt loads field mappings, status mappings and existing mapping (`crmIntegrationService.js:687–691`), acquires/releases a claim, updates lead/mapping/integration and inserts/mirrors logs (`761–850,1205–1265`). Retry adds lookups. UI/query throttling does not govern all direct ZCQL callers. | Instrument query/write count per lead and 429s. Cache immutable mapping versions per batch/worker, batch compatible reads/writes and coordinate datastore concurrency. Keep configuration invalidation explicit. |
| S7 — Bounded retry/reconciliation sweeps may drain too slowly [High for outage recovery] | Retry: at most 50 attempts/run; inbound replay: 20, normally at most 5/dealer; reconciliation: 40 by default. Sampling/rotation reduces starvation but does not establish recovery time. Full database counts and offset slices still cost work. | A 100k retry backlog needs **at least 2,000 fully productive retry sweeps**; at a hypothetical two-minute cadence and no other workers, about **66h 40m**, before new arrivals/failures. Actual schedules are unknown. Set a recovery objective, measure drain rate and scale durable workers within downstream quotas. |
| S8 — UI lists are paged, but database query cost is unmeasured [Medium / benchmark required] | `leadListService.js:349–361,423,489–491` uses offset pages plus COUNT/GROUP BY; searches include wildcard matches. `dashboardStatsService.js` uses aggregate queries and a local three-query limiter. These bound returned data/concurrency, not database scan cost. | Benchmark first/deep pages, search, facets and log reports at target size. Use cursor pagination where supported, stable ordering, cached summaries and appropriate query access paths. Do not claim current indexes are present/absent without schema inspection. |
| S9 — Retention and diagnostic growth [Medium] | Integration logs and webhook-event metadata accumulate; no automatic retention job for these or notifications was found. Timeline helper defaults to a **3,000-row cap** and logs truncation (`dashboardStatsService.js:363–374`; `crmIntegrationService.js:2127–2136`). | Define retention/archive rules, with event dedupe retention covering the vendor retry horizon. Paginate timelines and expose truncation. Repeated failure loops can dominate storage far faster than lead growth. |
| S10 — Alert batch query exceeds the repository's stated ZCQL bound [High if current platform bound applies] | `integrationAlertBatchService.js:22,38–40,134–135` requests `LIMIT 0,500`. Other services and the in-memory ZCQL test helper enforce a maximum of 300. A default timed flush can therefore fail regardless of backlog size. | Page the queue in supported batch sizes and test actual project behavior. Reproduced with the existing ZCQL emulator; not re-probed against live Catalyst. |
| S11 — Incremental recovery checkpoint can move past older missed work [High, conditional] | `leadSyncService.js:951–965` searches only the latest 20 Incremental logs for a successful checkpoint, then falls back to the preceding 24 hours (bounded by `LEAD_SYNC_SINCE`). A prolonged run of failures can push the last good checkpoint out of that window; unresolved OEM changes older than the fallback then fall outside automatic recovery. | Store a durable checkpoint independently of rotating logs. Advance it only after all covered work is durable, retain failed/deferred IDs, and test an outage longer than 24 hours with more than 20 failed runs. |

Hot logical lookup keys to inspect include `leads.crm_record_id`, `(dealer_code, status, timestamp)`, integration/lead identity, external lead identity, due retry state, log lead/time, and notification recipient/read/time. Enforce identity uniqueness through supported constraints or synthetic unique keys after inspecting the deployed schema. Do not prescribe unsupported composite indexes or migrations blindly.

Catalyst's **Search Index** setting is documented for its Search service; that does not demonstrate it accelerates every ZCQL WHERE/ORDER BY. The existing scalability plan's proposed index experiment is not a proven fix. Confirm relevant query-index support with Catalyst and measure actual queries before choosing a database change. [Catalyst Search indexing documentation](https://docs.catalyst.zoho.com/en/cloud-scale/help/search-integration/key-concepts/).

## 7. Additional verified findings retained from the earlier audit

| ID / severity | Verified issue, scope and recommendation |
|---|---|
| H3 — High | **Token URL bypasses endpoint safety checks.** `fusionSdOAuthHelper.js:54–65` sends keys to the configured URL without `assertSafeUrl`; config save accepts raw `base_url` (`dealerCrmIntegrationRoutes.js:137`). Create/PATCH validate their URLs first, but Test Connection goes straight to token acquisition. Validate/allowlist the correct HTTPS dealer host at save time and at token use. An admin-configured HTTP/private endpoint is a concrete risk. |
| M1 — High | **Prototype pollution through mapping paths.** `fusionSdAdapter.js:129–145` follows inherited properties. Synthetic `__proto__.auditProbe` altered `Object.prototype` in an isolated probe. Mapping save is admin-only but does not reject these segments. Block `__proto__`, `prototype`, `constructor`; use safe object construction and validate targets. No deployed exploit was attempted. |
| M2 — Medium | **Parent/child target collisions drop fields.** `contact` and `contact.firstName` can overwrite each other; reproduced. Exact duplicate checks do not cover prefix collisions. Reject conflicting paths on save and during nesting. |
| M3 — Medium | **URL safety is incomplete.** `genericRestAdapter.js:36–103` checks a limited set of IP ranges, resolves before Axios resolves again, and Fusion requests do not disable redirects. Missing IPv6/private ranges and DNS/redirect behavior need a hardened, address-pinned allowlist. The prior claim that Axios follows exactly five redirects and always forwards bearer credentials is withdrawn; actual redirect behavior is dependency-dependent. |
| M4 — High | **Already-delivered lead status overwritten after update failures.** Covered by C2. This is not a separate proof of dealer unavailability. |
| M5 — Medium | **Actionable vendor diagnostics disappear from persisted logs.** `wrapFusionError` retains title/reference in its message but not structured `type`, `detail` or headers; the orchestrator normally logs only the code (`crmIntegrationService.js:958–981`). Keep redacted/truncated structured diagnostics and correlation `instance`; do not log secrets/raw customer payloads. |
| M6 — Medium | **Loose ID extraction can save prose as a lead ID.** A mocked 201 body `OK` became the external ID; `Location` parsing also takes the final slash segment without validating resource type or stripping query data. D3 defines `lead_id`: validate that contract and quarantine anomalous responses. `fusionSdAdapter.js:192–228`. |
| M7 — Medium | **Token cache can mask changed credentials.** Keyed only by integration ROWID; Test Connection can reuse a cached token; neither credential save nor a 401 invalidates it. Missing `expires_in` defaults to 3,600 seconds, although D3 requires it and documents 600. Validate token responses, invalidate on config/401, and bypass cache for credential testing. Refresh margin should scale to lifetime. No explicit scope is required if the credential already holds both scopes. |
| M8 — High for Fusion inbound | **Replay/read UI assumes GET support.** `replayInboundLead:1479` and `adminDashboardRoutes.js:140–158` call `getLead`; UI treats an exception as record missing. Reconciliation correctly checks capabilities, but these paths do not. Capability-check them, avoid false missing-record claims, and retain failed webhook payloads for Fusion replay (C4). |
| M9 — High | **Timeline route lacks role/dealer ownership check.** `dealerCrmIntegrationRoutes.js:596` has no role middleware; `index.js:39–54,391` only ensures login for this mount. A logged-in dealer can request another lead's integration timeline if its ID is known. Add admin/view authorisation or validated dealer ownership; role-scoped alternative routes do not protect this separate route. |
| M10 — Medium, runtime-dependent | **Timestamp parsing is inconsistent.** Alert batching sends `CREATEDTIME` to `parseTimestamp`, which handles UTC seconds but otherwise uses native parsing; other services explicitly parse Catalyst system timestamps with project offset. Milliseconds/timezone differences can change digest timing. No fixed 5.5-hour delay is claimed without deployed timestamp/runtime evidence. Centralise explicit parsing. |
| L1 — High | **Concurrent edit can be skipped without requeue.** Elevated and covered by S4. |
| L2 — Low | **Token-check failures often show HTTP 0.** OAuth wrapping discards `.response`, while Test Connection reads it (`fusionSdOAuthHelper.js:75–77`; `fusionSdAdapter.js:313–317`). Preserve the safe HTTP status and distinguish network failure. |
| L3 — Low | **Comments/docs are stale.** OAuth helper says PATCH is unsupported; adapter/config comments say no webhook. Update these in the eventual implementation. The old assertion that no Markdown file mentions Fusion is withdrawn. |
| L4 — Low | **Unused update endpoint is required.** `validateIntegrationConfiguration:498` requires `update_lead_endpoint`, while Fusion derives PATCH from its create path. Validate adapter-specific requirements. |
| L5 — High | **Local queue-full error escalates as dealer failure.** Covered by C2/S1. |
| L6 — Medium, schema-dependent | **Credential save is read-then-insert.** `integrationAuthService.js:63–78` can race without a deployed unique key; actual constraints were not inspected. Enforce atomic identity uniqueness. AES-GCM uses a random IV but no integration/type-bound AAD. Review that separately from the concurrency issue. |
| L7 — Low | **Replay rows lacking integration/external IDs remain waiting.** `inboundReplayScheduler.js:198–200` skips them indefinitely. Separate portal-only events from CRM replay or close unreplayable work with a reason. |

No changes to these behaviors were made during this document update.

## 8. What was verified to work

- A documented `201` response with `lead_id` is read correctly; outbound nested contact/requirement mapping works for normal dotted paths.
- OAuth uses Basic authentication and the correct form grant. Single-flight refresh prevents duplicate refreshes for the same integration within one process.
- Dealer adapter calls have a 10-second timeout; semaphore release is in `finally` and the waiting queue is bounded. These protections do not establish distributed rate limiting or total request deadlines.
- Ordinary OEM webhook processing reads named IDs, with a modified-since fallback, rather than routinely fetching all lead history.
- The dealer-ID mapping is persisted before OEM acknowledgement writeback. After that mapping is saved, a writeback retry uses update rather than another create.
- Consent/validation/routing holds precede dispatch. Canonical fingerprints suppress recognised echoes, and business duplicate detection uses a configured 15-minute default window plus normalised identity fields.
- Database claim keys coordinate lead processing when the required table/unique constraint is present and available. Some sweeps rotate candidate windows and apply per-dealer budgets.
- Lead-list/log paging and aggregate dashboard queries are implemented. They are preferable to materialising all rows for normal screens, but live latency remains unmeasured.
- GET-based reconciliation already excludes Fusion using both `inbound_enabled` and adapter capability checks.

## 9. Validation performed and its limits

### Existing tests

From `functions/mg_motors_au_function/`:

```bash
npm test
```

**Result: 319 tests passed; 0 failed, skipped or cancelled.** Final run used Node `v26.4.0` / npm `11.17.0`; the local deployment declares `node20`, so this is not a production-runtime compatibility certification. Run the same suite on the supported deployed runtime before release.

The first sandboxed run had 290 passes and 29 failures involving blocked local HTTP listeners/DNS. The authorised rerun outside the sandbox passed all 319. CRM requests in these tests are mocked; some Fusion tests still perform public-host DNS resolution. No live CRM lead creation/update was performed. Logs are at `/private/tmp/mg-lead-exchange-audit-tests.log` and `/private/tmp/mg-lead-exchange-audit-tests-unrestricted.log` for this session.

### Additional isolated checks

No repository test files were changed. Synthetic, process-local probes verified:

| Probe | Observed current behavior |
|---|---|
| Correct documented Standard Webhooks signature headers | Rejected as `MISSING_AUTH`. |
| Fusion flat return fields through current reverse mapper | Produced no mapped fields for name/email/status outbound target mappings. |
| Repeat provider event ID after its initial insert | Reported duplicate without examining processing status. |
| 429 with `Retry-After: 60` | Wrapped response contained only status; header lost. |
| 201 JSON with `lead_id` | Correct ID extracted. |
| 201 plain string `OK` | Incorrectly accepted as external lead ID. |
| `data_type:boolean` mapping of string `"true"` | Remained a string. This alone is not proof Fusion rejected it. |
| Parent/child dotted paths | Parent assignment overwrote nested contact fields. |
| `__proto__` dotted path | Polluted an object prototype in the isolated process; removed immediately after the check. |
| Default timed alert flush against existing ZCQL emulator | Rejected `LIMIT 500` under the emulator's 300-row bound. |

These are functional observations, not load measurements. No production metrics, database latency traces, distributed load test, live UI validation or vendor support confirmation was obtained.

## 10. Recommended implementation order and release evidence

1. **Stop unsafe retries and false success:** handle missing-ID uncertainty, immutable creation idempotency, terminal errors, `Retry-After`, skipped/ignored/manual updates and status-safe escalation. Correct unsafe mapping paths and timeline access control alongside this work.
2. **Align the contract:** correct marketing consent, preserve name/consent semantics, resolve status/outcome mappings and implement changes-only PATCH with field ownership. A full stale PATCH must not overwrite dealer-maintained fields during concurrent edits.
3. **Build durable inbound/outbound work processing:** verified event persistence, recoverable dedupe states, per-lead ordering, shared per-credential rate budgets, per-dealer fairness, finite retry lifetimes and dead-letter review. Resolve claim failure/expiry and lost-edit behavior.
4. **Implement Fusion return support:** Standard Webhooks verification, flat-payload translator, explicit directional mappings and stored-event replay. Obtain the signing fixture, enable agreed dealer triggers, and verify the full dealer → middleware → OEM → echo-suppression round trip.
5. **Harden datastore/background work:** inspect constraints and query plans/support where available; reduce repeated mapping reads; page imports/alerts/timelines; implement retention; set deadlines/checkpoints and monitor queue age/drain rate.
6. **Measure before sign-off:** perform the existing scalability plan in an isolated Catalyst project, with synthetic leads and CRM stubs. Preserve normal traffic capacity while replaying an outage backlog.

Suggested acceptance targets below are **proposals**, not measured results or existing commitments:

| Test | Dataset/workload | Evidence required |
|---|---|---|
| Storage/UI scale | 25k → 100k → 200k leads; ~1M integration logs; representative dealer skew and notification/event growth | p50/p95/p99 first/deep-page, search, facets and dashboard latency; query counts, storage size and memory. Proposed list p95 <3s. |
| Steady-state and bursts | Expected peak rate, 2× expected peak, and a 10× short burst with 1/5/20 concurrent senders | Durable acceptance count equals eventual processed/held count; no unexplained loss; proposed webhook acknowledgement p95 <1s once queued. |
| Provider throttling | Shared create/update traffic across 2–5 worker instances, 429 with Retry-After, slow responses and token failures | Aggregate calls obey each credential's documented window; cooldowns hold; other dealers continue processing. |
| Recovery | At least 10k queued events; 100k backlog if that is the agreed outage scenario; 429/5xx/timeouts | Measured drain rate exceeds sustained new arrival rate; maximum queue age and completion time meet an agreed recovery objective. |
| Duplicates/conflicts | Repeated events, changed create payload under same key, simultaneous OEM/dealer edits, before-mapping events | Zero duplicate business leads and zero silently lost changes; field ownership and ordering decisions are auditable. |
| Worker/storage failure | Terminate after event receipt, after remote create, before local mapping; claim table failure; lease expiry; datastore 429 | Work remains recoverable, no false applied status, no unbounded retry storm, and operators can inspect/replay parked work. |
| Contract/UI acceptance | Synthetic values for all agreed mappings; manual update mode; disabled updates; null consent; rejected reason and activities | Captured redacted requests/responses plus dealer-side evidence of stored/applied fields and OEM return updates. |

Track at minimum accepted/completed/held counts, oldest pending age, retry/dead-letter counts, rate-limit responses by credential, API quota consumption, duplicate/conflict counts, p95/p99 CRM/datastore latency, function timeouts and alert-delivery failures. A one-lead success and passing mocked tests are insufficient release evidence for lakh-scale.

## 11. Remaining questions for Fusion/MG/deployment owners

These are unresolved details, not requests to resend documentation already supplied:

1. **Production contract:** host, provider credential scope, whether the 300/60s limit differs from sandbox, rate-window/burst behavior, token-endpoint allowance and any dealer-wide/shared caps.
2. **Create anomalies:** if an empty/non-JSON 2xx is still observed, provide redacted status, content type, body shape and correlation ID. D3 specifies JSON `lead_id`; establish why the observed response differs. Confirm idempotency retention and a safe lookup/recovery mechanism for an accepted-but-unlinked lead.
3. **Mapping/storage/UI:** confirm where source/reference/campaign/type/consent values are stored/displayed, manual update settings, and the actual ignored/updated-field diagnostics for the test lead. Reconcile D1 with current MG status policy and define reverse mappings/outcome rules.
4. **Webhook activation:** dealer-configured destination, signing-secret encoding/rotation test fixture, selected triggers/blocks, retry/suspension/resume details, ordering guarantees, stable source-change version/timestamp and payload-size/truncation behavior.
5. **Return gaps:** exact dealer rejection/lost-reason and marketing-specific consent fields/events; D3's `PushedLead` has general `optin_email`, not an explicit marketing equivalent or lost-reason field. Confirm Phase 1 existing-lead updates versus Phase 2 dealer-originated lead creation.
6. **409 policy:** is `lead_not_ready` ever transient? If so, obtain a bounded retry contract correcting the guide's current no-4xx-retry instruction; keep idempotency conflicts distinct.
7. **Runtime and database:** deployed commit/environment, actual function limit/runtime, active cron frequencies, OEM account quotas, unique constraints, supported ZCQL limits/access paths and measured current workload. Local two-minute demo settings must not be assumed to be production settings.

**Sign-off position:** continue controlled functional verification, but defer any claim of lag-free lakh-scale operation until the confirmed correctness gaps are addressed and representative load/recovery tests pass.
