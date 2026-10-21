# MG Motor AU — remediation of the 11 re-verification findings

**Date:** 14 October 2026  
**Scope:** Local fixes for E2E-01 through E2E-11 in [the end-to-end re-verification](MG_Motor_AU_End_to_End_Reverification.md). Earlier authorized changes in this working tree were preserved.  
**Status:** The 11 reproduced defects have code fixes and regression coverage. This is local validation, not production deployment or live end-to-end certification.

## 1. Delivered changes

| Finding | What changed | Regression evidence |
|---|---|---|
| **E2E-01 — Zoho watch destination bypass** | Watch registration and deregistration validate official Zoho HTTPS destinations before retrieving secrets, use the shared pinned transport, and disable redirects/proxies. Configuration saves enforce the same official-host policy. Manual and scheduled renewal reject ineligible integrations and missing/Removed dealers. | Unsafe destinations produce no secret-bearing HTTP calls; valid official destinations use the protected transport. Manual and cron eligibility checks are exercised. |
| **E2E-02 — stale ownership/consent/configuration** | Outbound dispatch reads the current lead, integration and dealer under a lead-wide claim. Consent and delivery validation use that current row. Failed authoritative reads stop delivery and retain retry work as a local failure. Inbound updates verify current assignment, consent, explicit integration state and dealer lifecycle before an MG write. Old mapping retirement does not overwrite the new owner's lead state or badge. | Revoked consent, reassignment, missing/failed reads, invalid current data, disabled integration and removed dealer all block unauthorized calls. Old/new integrations contend for the same OEM lead claim. |
| **E2E-03 — deleted leads retried/revived** | OEM deletion takes the same lead claim and parks associated mappings as HELD/LEAD_REMOVED. Common outbound/inbound processing refuses removed leads. Proposed OEM mirror mutations refresh the source record under the claim, preventing an older import from restoring a deleted lead or undoing newer consent. Full-import absence is rechecked before removal. SLA and reconciliation also reject removed/reassigned leads. Terminal obsolete inbound replay groups are expired rather than revisited forever. | Failed create and failed update mappings remain removed after retry. Tests exercise source fetch → intervening deletion/consent change → older import → dispatch. Removed/reassigned replay groups stop generating subsequent replay reads. |
| **E2E-04 — view-only mutation** | Dealer lead PATCH requires the current Catalyst **Dealer role ID** before mapping or lead access. Role names and retained dealer mappings do not grant mutation permission by themselves. | Dealer succeeds; View User, Admin, unknown/removed role and anonymous cases are rejected as appropriate. Existing mapped reads retain their scoped behavior. |
| **E2E-05 — partial Zoho batch loss** | Each failed dealer fetch retains its external ID in durable replay work before a successful hold response. Fresh inbound FAILED logs that justify acknowledgement must persist. A failure to store work produces a non-success response. Failed/PENDING event IDs can be processed again; only completed IDs are successful duplicates. Batch error precedence prevents a later mapping hold from hiding an earlier persistence failure. | Mixed timeout/429 batches, all-fetch failure, persistence failure, no-event-ID mapping/claim holds, ordering of mixed errors, same-event redelivery and replay from reconstructed persisted state are covered. Already applied OEM changes are not repeated during recovery. |
| **E2E-06 — stage/window rotation aliasing** | Fast recovery supplies candidate rotation with a complete four-stage cycle index, decoupling the tail window from the stage's first-priority slot. Outbound, inbound and SLA sweeps consume the supplied sequence. Dedicated sweeps retain their own time rotation. | The actual fast-recovery router and retry selector now progress through the valid tail behind an undrainable prefix under repeated budget exhaustion. |
| **E2E-07 — stale Zoho token generation** | Token cache entries and pending refreshes use a fingerprint of persisted OAuth credentials and authoritative API/accounts configuration. Refresh completion rechecks the generation; an older refresh cannot populate the new generation. Saves invalidate local state. Account identity changes with linked lead mappings return **409 CRM_ACCOUNT_MIGRATION_REQUIRED**. | Rotation, independent warm instances, official datacenter changes, pending-refresh races, stale callers and linked-account changes are tested. Client-secret-only rotation remains allowed. |
| **E2E-08 — notification tab race** | Refresh callbacks use the currently selected filter. A filter epoch prevents obsolete responses and rollback snapshots from replacing the selected tab. Existing actor/session protections remain. | Partial/full bulk completion, error paths, switching away and back, row-action failure and out-of-order list responses preserve the selected filter and its data. |
| **E2E-09 — repeated unresolved mapping holds** | Replay records which mapping generation was attempted in bounded metadata in the existing error_message field. An irrelevant mapping edit triggers one attempt, rather than making the same holds eligible on every run. Transient failures retain timed retry behavior. | Unresolved holds no longer consume every replay slot after one irrelevant edit; newer valid work progresses, and a relevant later correction releases held work. |
| **E2E-10 — global SLA preflight starvation** | Signed-channel proof is checked only for overdue candidate integrations and cached within the sweep. Current lead/integration/dealer eligibility is checked under each lead claim; positive dealer eligibility is not cached across later batches. Missing/unreadable proof still fails closed. | Large Fusion catalogs no longer prevent an unrelated overdue dealer from being checked. Coverage includes >300 integrations, failed proof reads, mid-sweep dealer removal, withdrawn/unknown consent and disabled directions. |
| **E2E-11 — sent-alert cleanup stalls new mail** | Durable sent receipts exclude accepted rows from new batches while unrelated unsent alerts continue. Cleanup handles one due receipt with exponential backoff and a sub-budget of at most two seconds or one-quarter of the remaining dispatch budget. Receipt evidence is retained until cleanup succeeds. | Persistent and slow deletion failures do not duplicate accepted mail or suppress new alerts. Tests also cover >300 receipts and failure to read receipt inventory. |

## 2. Shared lifecycle changes and why they matter

The original lock key included the integration ID. After a reassignment, the old and new integrations could therefore act on the same OEM lead under different locks. The key is now `lead:<OEM lead ID>` for delivery, inbound writes, SLA, reconciliation repair and OEM mirror mutations. The separate `leadSync:<dealer code>` namespace still protects business-duplicate classification.

Nested dispatch from a claimed OEM mirror mutation reuses the held claim through an asynchronous execution context. Another request or instance must acquire the datastore claim normally. The context is marked inactive on release, so a detached continuation cannot reuse an expired in-process claim. Real cross-instance exclusion still depends on the deployed UNIQUE constraint.

A lock alone was insufficient: a full import can fetch a record before a delete or consent change, then acquire the lock afterward. The import now obtains a fresh OEM version under the claim before a proposed new/changed/Removed-row mutation. A missing source row is not recreated. An unreadable source leaves the mutation incomplete and the incremental checkpoint unable to advance past it.

Unchanged rows take a cheap path: if the loaded snapshot requires no business or maintenance mutation, the loop skips the per-lead claim and additional read. Duplicate notifications therefore do not perform a second authoritative mutation refresh unnecessarily.

A removed or reassigned inbound event is terminally retired. Its replay audit rows become EXPIRED, its webhook can be acknowledged as processed without applying it, and it cannot establish Fusion return-channel proof merely because it was safely discarded. Temporarily disabled configurations remain held so they can be reconsidered after an authorized correction.

## 3. Validation

The complete validation run finished successfully. The tests use synthetic actors, records, credentials, clocks and mocked vendor/email responses. No real customer record or email recipient was used.

| Check | Result |
|---|---|
| Complete backend suite, Node 20.20.2 | **916 passed, 0 failed** |
| Complete frontend Jest suite | **28 passed, 0 failed**, three suites |
| Frontend production build | **Passed**, 18 existing lint warnings |
| Whitespace/diff check | `git diff --check` passes |

The backend suite requires loopback listeners and DNS for some mocked HTTP fixtures, so the complete run used the approved access needed by those tests. Earlier intermediate runs exposed fixtures that omitted persisted dealer/integration rows or expected the old unsafe behavior. Those fixtures now model authoritative reads; security checks were not weakened to make them pass.

Main new or extended regression files:

- `functions/mg_motors_au_function/test/leadLifecycleDispatch.test.js`
- `functions/mg_motors_au_function/test/oemSnapshotLifecycleRace.test.js`
- `functions/mg_motors_au_function/test/zohoBatchDurability.test.js`
- `functions/mg_motors_au_function/test/schedulerRecoveryRegression.test.js`
- `functions/mg_motors_au_function/test/dealerLeadMutationRole.test.js`
- `functions/mg_motors_au_function/test/zohoCredentialGeneration.test.js`
- `functions/mg_motors_au_function/test/zohoWatchDestinationSafety.test.js`
- `functions/mg_motors_au_function/test/dealerZohoConfiguration.test.js`
- `functions/mg_motors_au_function/test/fusionReturnChannelProof.test.js`
- `mg-motor-web/src/layouts/MainLayout/Navbar/NotificationBell.test.jsx`

Validation logs:

- `/private/tmp/mg-e2e-remediation-backend-tests.log`
- `/private/tmp/mg-e2e-remediation-frontend-tests.log`
- `/private/tmp/mg-e2e-remediation-frontend-build.log`

Reproduce from the backend directory:

```sh
/Users/fristineinfotech/.nvm/versions/node/v20.20.2/bin/node --test test/*.test.js
```

Reproduce from the frontend directory:

```sh
CI=true npm test -- --watchAll=false --runInBand
npm run build
```

## 4. Cost implications

The supplied bill totaled approximately **₹6,396.77**, including **₹4,740.30 in datastore fetches**, about **74.1%**. Function execution was approximately **₹12.46**, about **0.2%**. The relevant optimization target remains repeated datastore activity, not changing the function's 256 MB memory allocation without measurements.

This pass removes several identifiable sources of wasted work:

1. Unresolved mapping holds no longer repeat after the same ineffective mapping generation.
2. Removed/reassigned inbound replay groups stop after terminal retirement; deleted outbound mappings leave the retry candidate set.
3. SLA no longer reads signing credentials/proofs for the entire dealer catalog before considering actual candidates.
4. Cleanup faults no longer produce an ever-growing unsent alert backlog, and cleanup retries back off.
5. Correct scheduler rotation allows valid backlog to drain rather than repeatedly revisiting the same candidate slice.

Security checks have a cost too. A warm dealer-Zoho token lookup now deliberately uses **one current integration-row read plus one batched credential read** to detect changes on other instances. A refresh repeats that generation check before returning its token. Proposed OEM mutations also incur a fresh OEM fetch while holding the lead claim. These are correctness costs and must not be presented as savings. Unchanged import rows avoid that extra mutation work.

No production billing period, route-level usage or before/after traffic sample was available. Consequently, there is **no verified rupee saving or percentage reduction yet**. Measure datastore requests, retry/replay attempts, queue age, processed leads and dealer API calls over comparable traffic windows after deployment. Count actual billed operations rather than assuming each returned database row is one billed fetch.

## 5. Deployment requirements and changed behavior

These are operational prerequisites for a later deployment; no deployment or production changes were performed here.

1. **Drain old executions before the claim-key change.** Old code uses `<integration ID>:<OEM lead ID>` and new code uses `lead:<OEM lead ID>`. Mixed versions do not coordinate. Pause scheduled ingress as appropriate, let active old workers finish, then switch the function and resume. Apply the same drain discipline for rollback. Retained historical claims/receipts/proofs must not be deleted indiscriminately.
2. **Verify actual datastore constraints and column capacity.** The existing `outbound_sync_claims.claim_key` UNIQUE constraint is essential. Existing receipt storage, webhook dedupe constraints and required columns must be present. This pass introduces no new table or column, but mocks cannot prove live constraints or access rules.
3. **Review Zoho account changes explicitly.** With existing mappings, changing CRM identity, API/accounts host, client ID or refresh token is blocked because existing external record IDs may belong to another organization. Unchanged identity values and client-secret-only rotation are allowed. A replacement refresh token may be for the same org, but this application has no verified org-ID migration workflow; it must be reviewed/migrated rather than silently accepted. No mapping migration was performed.
4. **Confirm schedules and flags.** Fast-recovery candidate fairness assumes the documented two-minute schedule and complete four-stage cycles. It is not a durable general-purpose job cursor and does not guarantee progress under arbitrarily skipped invocations. Keep signed-channel proof and claim failure behavior fail closed; test the actual deployed flags and scheduled routes.
5. **Run controlled staging transactions.** Exercise MG → dealer → MG, consent revocation, reassignment, deletion with queued work, partial webhook failure, token rotation, SMTP cleanup failure, and role downgrade. Confirm persistence, ACLs, event redelivery and recovery across separate function instances.

## 6. What remains outside these 11 fixes

The prior report's broader limitations remain open. This delivery should not be described as “no gaps remain.” In particular:

- **Live verification:** no real end-to-end vendor transaction, staged load test, production schema/ACL inspection or billing comparison was performed.
- **Frontend tooling:** the prior dependency audit reported 100 affected frontend package entries; this pass did not change dependency manifests/lockfiles further or rerun the advisory audit. The build still reports 18 existing warnings. Those entries are not 100 independently demonstrated browser exploits.
- **Create idempotency and recovery architecture:** immutable create intent, a general durable/resumable OEM import cursor, and propagated request cancellation remain separate work.
- **Credentials and rates:** multi-row credential saves remain nontransactional; key/AAD migration, historical secret rotation verification and a shared distributed rate limit are not established by this patch.
- **Email:** SMTP acceptance followed by a crash before receipt persistence is still ambiguous. A corrupt, unreadable or excessively large sent-receipt inventory fails closed within the dispatch budget; evidence is not discarded to force delivery. A single network call already in flight cannot be cancelled merely by the cleanup sub-budget.
- **Upload/AI bounds:** isolated workbook parsing and stronger AI/provider timeouts and database limits remain the previously documented work.
- **Business decisions:** production SLA duration, inactive dealer-stage rules, status/consent ownership nuances, timezone behavior and remaining CRM field/AutoPlay decisions still require the recorded owner inputs.

Application code, tests and this report are prepared locally. Production deployment, credential changes, database migrations and real outbound messages were not performed.
