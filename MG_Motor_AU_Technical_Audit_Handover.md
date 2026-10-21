# MG Motor AU Lead Exchange Middleware

## Technical Audit, Integration & Scalability Handover

**Audience:** Internal developer / technical team\
**Purpose:** Audit the existing application, document verified behaviour
and risks, and plan safe improvements without disrupting live
integrations.

------------------------------------------------------------------------

## 1. Project Context

The MG Motor Australia Lead Exchange Middleware connects MG Motor's Zoho
CRM with dealer CRM platforms.

**Expected flow**

`MG Motor Zoho CRM → Webhook/API → Middleware → Dealer-specific CRM adapter → Dealer CRM`

Where supported, dealer-side lead updates and status changes must
synchronize back through the middleware to MG Motor's CRM.

The current routing approach uses **Dealer Code** to identify the
destination dealer.

### Current understanding (verify against the actual codebase)

-   MG Motor Zoho CRM webhook-based lead ingestion is reported to be
    working.
-   Fusion SD / AMS Pro is connected for integration testing, and API
    credentials have been configured.
-   AutoPlay CRM is a planned integration, subject to confirmation,
    documentation, and API access.
-   Additional dealer CRM platforms may be required in the future.
-   Backend synchronization is a critical part of the application.
    Concurrent API calls, retries, status updates, and scheduled tasks
    must not cause crashes, data loss, duplicate leads, or cross-dealer
    data leakage.

**Audit rule:** Treat the points above as project context, not proof
that every implementation detail is correct. Inspect the current working
tree, configuration, data tables, logs, and tests. Record evidence
before marking anything verified.

## 2. Audit Principles

1.  Inspect the current working tree and latest changes before editing
    anything.
2.  Do not assume a prior audit or test report proves the current
    implementation is correct.
3.  Separate confirmed defects, suspected risks, and items requiring
    external confirmation.
4.  Do not change production data or disrupt live integrations during
    the initial audit.
5.  Never place real API keys, tokens, passwords, client secrets, or
    other secrets in this document.
6.  Preserve existing dealer configurations, lead records, mappings,
    retry state, and synchronization history.
7.  Make changes in small, reviewable steps and add regression tests.
8.  Do not claim load capacity without measured load-test evidence.
9.  Record repository paths, test commands, logs, sanitized
    request/response evidence, and relevant timestamps.
10. If something cannot be verified, mark it **Not Verified** and state
    what evidence is missing.

## 3. CRM Integration Inventory

  -----------------------------------------------------------------------
  Platform                Current understanding   Required audit
  ----------------------- ----------------------- -----------------------
  MG Motor Zoho CRM       Connected;              Verify webhook
                          webhook-based lead      validation, API limits,
                          ingestion reported      field mapping, event
                          working                 deduplication,
                                                  retry/reconciliation,
                                                  and status updates

  Fusion SD / AMS Pro     Connected for testing;  Verify adapter,
                          API credentials         authentication/token
                          configured              refresh, create/update
                                                  flows, API limits,
                                                  timeouts, retries,
                                                  status mapping, and
                                                  duplicate prevention

  AutoPlay CRM            Planned                 Confirm dealer list,
                                                  official API
                                                  documentation, sandbox
                                                  credentials,
                                                  authentication, field
                                                  requirements, rate
                                                  limits, and status
                                                  behaviour before
                                                  implementation

  Future CRM platforms    Future requirement      Verify that a new
                                                  adapter can be added
                                                  without breaking
                                                  existing live
                                                  integrations
  -----------------------------------------------------------------------

For each integration, document the actual adapter implementation,
supported operations, configuration source, test coverage, known
limitations, and production readiness.

## 4. CRM Adapter Architecture and Safe Onboarding

Inspect the existing adapter architecture, including any adapter
factory/registry, generic adapter, CRM-specific adapters, configuration
tables, and dealer-to-CRM association.

Verify that the architecture supports:

-   Dealer-specific CRM selection and configuration.
-   CRM-specific authentication and token refresh.
-   CRM-specific payload construction and response parsing.
-   Field and status mapping.
-   Normalized errors and retry classification.
-   CRM-specific timeouts and rate-limit handling.
-   Safe webhook registration/renewal, where supported.
-   Adapter-level unit and integration tests.
-   Backward compatibility and safe rollout/rollback.

### New CRM onboarding scenario

The application currently connects to Fusion SD and may add AutoPlay.
Later, MG Motor may request another CRM.

Before enabling a new adapter, establish that the change cannot
unintentionally:

-   Break Fusion synchronization.
-   Modify existing dealer configurations or mappings.
-   Redirect a dealer's leads to the wrong CRM.
-   Change the meaning of existing statuses.
-   Interfere with queued retries or in-flight synchronization.
-   Create duplicate leads.
-   Leak credentials, records, or state across dealers.

Recommended approach:

1.  Add the new adapter behind explicit configuration/feature
    enablement.
2.  Keep existing adapter behaviour unchanged by default.
3.  Validate required configuration before enabling the integration.
4.  Test using sandbox credentials and representative payloads.
5.  Run regression tests against existing Zoho and Fusion flows.
6.  Test failure, timeout, retry, duplicate, and recovery paths.
7.  Enable for a controlled dealer/test scope before broader rollout.
8.  Document migration, rollback, and operational monitoring.
9.  Do not migrate existing dealers automatically unless the migration
    is explicitly approved.

## 5. API Credentials and Configuration Security

Audit where every credential type is currently stored and how it is
accessed. Do not choose a storage approach before inspecting the actual
Zoho Catalyst environment and its supported secure
configuration/secret-management facilities.

Compare appropriate options such as environment configuration,
Catalyst-supported secure configuration/secrets, and a Data
Store/database record where justified. Do not assume that putting
secrets in a normal database table is appropriate.

Inventory credential types:

-   Application-wide credentials.
-   Dealer-specific API credentials.
-   OAuth client IDs and client secrets.
-   Access and refresh tokens.
-   Webhook verification secrets.
-   Non-sensitive CRM settings and field mappings.

Verify:

-   Secrets are not present in frontend bundles or browser responses.
-   Secrets are not committed to Git.
-   Development, sandbox, and production credentials are separated.
-   Dealer-specific credentials cannot be accessed by another dealer's
    integration.
-   Logs redact credentials, authorization headers, tokens, and
    sensitive payload values.
-   Token refresh is secure and handles concurrent refresh attempts
    safely.
-   Permissions follow least-privilege principles.
-   Rotation and revocation can be performed without exposing secrets.

**Evidence to record:** storage mechanism and key names only---not
secret values---plus access controls, runtime usage, and any identified
exposure paths.

## 6. Lead Synchronization and Data Integrity

Audit the full lifecycle:

`Zoho webhook → validation → event deduplication → lead lookup/creation → Dealer Code validation → CRM adapter → dealer CRM → status/update synchronization`

Check:

-   Webhook authentication and payload validation.
-   Event deduplication and idempotency.
-   Lead create versus update decisions.
-   Stable external identifiers and CRM record IDs.
-   Dealer Code validation and routing.
-   Missing, blank, invalid, or unconfigured Dealer Codes.
-   Duplicate lead detection.
-   Partial failures and retry bookkeeping.
-   Out-of-order events and concurrent updates.
-   Status mapping in both directions.
-   Recovery after transient errors.
-   Permanent-failure handling and manual recovery.
-   Audit trail and correlation IDs.
-   Reconciliation for missed webhook events, if supported/required.

### Missing Dealer Code

Some incoming leads may not include a Dealer Code, while the current
routing design depends on it.

Do not silently discard these leads or route them to an arbitrary
dealer. Preserve the event and record a clear exception. Ask MG Motor to
approve the business rule for quarantine/manual assignment, another
authoritative routing field, or an explicitly approved default
destination.

Also verify behaviour when the Dealer Code is invalid, the dealer is not
onboarded, or the dealer CRM is not configured/enabled.

## 7. Known Fusion Outcome Sequence: Unhappy 1 → Happy 4 → Happy 1

**Observed behaviour:** A lead sent to Fusion initially appears as
**Unhappy 1**, then **Happy 4 (Recovery)**, and finally **Happy 1**.
Fusion is connected, so investigate why the initial attempt is
classified as unhappy before later recovery.

Do not assume timeout is the root cause until evidence confirms it.

Inspect and record:

-   Middleware request start/end timestamps.
-   Actual HTTP status and sanitized response body.
-   Connection timeout versus response timeout.
-   Actual API latency and available server-side processing time.
-   Authentication and token-refresh timing.
-   Rate-limit responses and `Retry-After`, if present.
-   Retry classification, delay/backoff, attempt count, and final
    outcome.
-   Whether Fusion received and processed the initial request despite a
    delayed response.
-   Whether the lead was created even though the middleware did not
    receive confirmation.
-   Duplicate-creation risk on retry.
-   Correlation/request IDs and final Fusion lead ID.
-   Whether recovery bookkeeping and status transitions accurately
    reflect the real outcome.

**Expected outcome:** Healthy requests should not be incorrectly
classified as failures. Genuine transient failures should recover
safely; permanent failures should remain actionable. Retrying an
ambiguous create request must not create duplicates where reliable
idempotency or lookup is available.

## 8. MG Zoho CRM API Limits and Webhook Reliability

Verify actual limits using official documentation and available
account/API configuration. Do not invent quotas.

Check applicable limits for:

-   Zoho CRM API requests and concurrency.
-   Webhook delivery, retries, and payload size.
-   Middleware/Catalyst function execution and resource limits.
-   Data Store operations and query/pagination limits.
-   Outbound CRM API calls and scheduled processing.

Determine whether limits apply per account, user, OAuth client,
endpoint, or other scope.

Inspect handling for throttling, HTTP 429, timeouts, token expiry,
network failures, duplicate events, missed events, and prolonged
outages. Confirm whether reconciliation/backfill is available or
required.

## 9. Timezone, Cron Jobs, and Scheduled Tasks

The application serves Australian operations, but Australia has multiple
timezones. Confirm the required timezone with MG Motor and use an
appropriate IANA timezone identifier. `Australia/Sydney` is only an
example for locations where that timezone is applicable; do not assume
it applies to every dealer.

Audit **every** existing scheduled/cron job, including where applicable:

-   Retry/recovery processing.
-   Access-token refresh.
-   Webhook registration or renewal.
-   Cleanup and retention.
-   Notifications and summaries.
-   Reconciliation.
-   Health checks and monitoring.

For every job, record its purpose, schedule, runtime timezone semantics,
enabled/registered state, last successful run, last failure, logs, error
handling, retry behaviour, overlap protection, and alerting.

Verify daylight-saving transitions and whether schedules follow the
intended business timezone or UTC. Check Catalyst's actual
scheduler/runtime semantics rather than assuming a timezone setting is
honoured.

Do not mark a job working without execution evidence.

## 10. Concurrency, Synchronization, and Scalability

Inspect the application under concurrent inbound webhooks, outbound CRM
calls, and status updates across dealers and CRM platforms.

Check for:

-   Duplicate processing and race conditions.
-   Token-refresh races.
-   Retry-worker races.
-   Webhook renewal races.
-   Concurrent create/update conflicts.
-   Database contention and unsafe read-modify-write sequences.
-   Queue depth, backpressure, and starvation.
-   Unhandled promise rejections.
-   Function execution limits and memory pressure.
-   Rate-limit coordination.
-   Lost or out-of-order updates.
-   Cross-dealer data leakage.
-   Safe recovery after worker/function failure.

Verify whether existing locking, claims, unique constraints, or
idempotency mechanisms are correctly applied to every relevant path.

Test increasing dealer counts and event volumes with defined acceptance
criteria. Do not claim the system can support a specific dealer count or
lead volume without measurements.

## 11. Data Store and Large-Data Performance

Inspect relevant Catalyst Data Store tables, schemas, indexes/search
support, unique constraints, query patterns, and growth.

Check for:

-   Queries that load all rows when only a page is required.
-   Missing pagination or unbounded result processing.
-   Large scans and inefficient filtering.
-   Batch operation limits.
-   Retry/event/log tables growing without retention policies.
-   Duplicate detection becoming expensive as records increase.
-   Index/unique constraint requirements.
-   Safe migrations and rollback.

Record actual table names and observed row counts only after inspecting
the environment. Do not delete history or change constraints without an
approved migration and regression plan.

## 12. Sync Logs and Notifications UI

The Sync Logs page should be understandable to MG Motor staff who may
not be technical.

Show, where available:

-   Lead reference and source/destination CRM.
-   Dealer name and Dealer Code.
-   Current outcome in plain English.
-   Event timestamp with timezone.
-   Failure reason and recommended next action.
-   Retry count and recovery state.
-   Correlation/reference ID.
-   Search, filters, and pagination.
-   Status history.
-   An expandable technical-details section for developers.

Audit mandatory notifications and verify each trigger, recipient,
severity, channel, deduplication/suppression, escalation, timestamps,
delivery logs, and actionable next steps.

Potential events to check (do not assume they already exist):

-   Lead sync failure or repeated failure.
-   Authentication/token failure.
-   API rate limit exceeded.
-   Missing/invalid Dealer Code.
-   Dealer CRM not configured.
-   Retry exhaustion.
-   Scheduled job failure.
-   Webhook failure.
-   Queue backlog.
-   Recovery after a previous failure, where useful.

## 13. Testing and Regression Requirements

Create and run appropriate unit, integration, end-to-end, and load tests
for:

-   Zoho lead ingestion.
-   Fusion lead creation and update.
-   Fusion timeout and recovery.
-   Ambiguous create timeout and duplicate prevention.
-   Missing/invalid Dealer Code.
-   Invalid credentials and expired tokens.
-   API throttling and retry behaviour.
-   Status and field mapping.
-   AutoPlay adapter onboarding.
-   Adding a future CRM without affecting existing adapters.
-   Concurrent webhooks and status updates.
-   Retry scheduling and scheduled-job failures.
-   Timezone/daylight-saving behaviour.
-   Mandatory notifications and sync logs.
-   Large dataset pagination and query performance.
-   Cross-dealer isolation.
-   Safe deployment and rollback.

Record test command, environment, result, timestamp, and evidence.
Distinguish code review from executed tests and load tests.

## 14. Suggested Priority Levels

-   **P0 -- Critical:** Security exposure, cross-dealer leakage, data
    loss, duplicate creation, broken live synchronization.
-   **P1 -- High:** Incorrect status, unreliable retry/recovery, missing
    mandatory alerting, scheduled jobs not running.
-   **P2 -- Medium:** AutoPlay onboarding, adapter extensibility,
    field/status mapping improvements.
-   **P3 -- Improvement:** Performance optimisation, large-data
    handling, observability, UI clarity.

Adjust priority based on verified impact and agreed business
requirements.

## 15. Developer Audit Record

For each finding, record:

  -----------------------------------------------------------------------
  Field                               Details
  ----------------------------------- -----------------------------------
  Finding ID                          Unique reference

  Component                           Backend, adapter, Data Store,
                                      scheduler, UI, etc.

  Finding                             Clear description

  Classification                      Confirmed defect / suspected risk /
                                      external clarification

  Severity/Priority                   Critical/High/Medium/Low and P0--P3

  Evidence                            Code path, test, sanitized log, or
                                      measurement

  Impact                              Business and technical impact

  Recommended action                  Specific proposed fix

  Regression tests                    Tests needed to protect existing
                                      behaviour

  Owner                               Responsible person

  Status                              Not Started / In Progress /
                                      Verified / Failed / Blocked / Needs
                                      External Confirmation

  Verification evidence               Proof the fix works
  -----------------------------------------------------------------------

## 16. Definition of Done

The audit is complete only when:

-   The actual architecture and active integrations are documented.
-   The Fusion outcome sequence has a root-cause investigation supported
    by evidence.
-   Credential storage and access controls have been reviewed.
-   All scheduled jobs have been inventoried and execution checked.
-   Timezone and daylight-saving behaviour are confirmed.
-   API limits and failure handling are documented using reliable
    evidence.
-   Missing Dealer Code handling and status mapping have explicit
    stakeholder decisions.
-   Adapter onboarding is shown to preserve existing live integrations
    through regression tests.
-   Scalability claims are supported by measurable tests and stated
    limitations.
-   Sync logs and mandatory notifications are verified.
-   Open risks and external dependencies are clearly handed over.
