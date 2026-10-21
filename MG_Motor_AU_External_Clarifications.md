# MG Motor AU Lead Exchange Middleware

## External Clarifications & Decisions

**Audience:** MG Motor stakeholders, Fusion SD / AMS Pro team, and
internal developers\
**Purpose:** Track business rules and technical information that must be
confirmed externally before implementation or production rollout.

This document is separate from the internal technical audit. Questions
that can be answered by inspecting our code should be investigated
internally rather than unnecessarily sent to MG Motor or Fusion.

Do not treat a recommendation as an approved decision. Record the
confirmed response, decision owner, date, and implementation impact.

------------------------------------------------------------------------

# Part A --- Questions for MG Motor

## A1. Leads Without Dealer Code

### MG-001 --- What should happen when an incoming lead has no Dealer Code?

**Context:** The middleware currently uses Dealer Code to decide which
dealer CRM receives a lead. Some leads may arrive without one.

**Options to discuss:** - Hold the lead for manual review. - Route it to
an MG team for assignment. - Resolve the dealer using another
authoritative field approved by MG. - Use a default destination only if
MG explicitly approves the rule.

**Decision required:** Confirm the business rule and the team
responsible for unresolved leads.

### MG-002 --- What should happen when the Dealer Code is invalid, inactive, or not configured?

Confirm whether the lead should be held for review, retried after
configuration, or handled through another approved process.

### MG-003 --- Should unresolved leads be retained and automatically processed after the Dealer Code or dealer configuration is corrected?

Confirm whether automatic reprocessing is required and who can release
the lead for processing.

### MG-004 --- Who should receive notifications for leads that cannot be routed?

Confirm recipients, escalation rules, and expected response time.

## A2. Lead Status Mapping

### MG-005 --- What is the approved mapping between MG and Fusion lead statuses?

MG has approximately 7--8 statuses, while Fusion appears to have
approximately 5. Please confirm the complete status list and
business-approved mapping.

The actual values must be retrieved from both systems; do not guess
status names.

  ------------------------------------------------------------------------
  MG status / Fusion      Business    Allowed      MG approval Fusion
  API value   status /    meaning     transition               approval
              API value                                        
  ----------- ----------- ----------- ------------ ----------- -----------
  To be       To be       To be       To be        Pending     Pending
  confirmed   confirmed   confirmed   confirmed                

  ------------------------------------------------------------------------

### MG-006 --- What should happen when an MG status has no exact Fusion equivalent?

Should it map to an approved broader status, remain unchanged in MG, or
follow another business rule?

### MG-007 --- What should happen when Fusion returns a status that does not exist in MG Zoho CRM?

Confirm whether to reject the update, map it to an agreed fallback, or
flag it for review.

### MG-008 --- Which system is authoritative if MG and dealer CRM statuses differ?

Confirm the source of truth and how conflicts should be resolved.

### MG-009 --- Are all status transitions allowed?

Please identify any prohibited or conditional transitions.

### MG-010 --- Should all dealer status changes synchronize immediately to MG?

Identify any status changes that require validation or additional
business steps.

## A3. Dealer and CRM Onboarding

### MG-011 --- Can a dealer have more than one active CRM integration?

Confirm whether one dealer must have exactly one active CRM or whether
multiple destinations are supported.

### MG-012 --- Who confirms which CRM platform each dealer uses?

Identify the responsible MG contact/team and the authoritative
dealer-to-CRM list.

### MG-013 --- What is the approved dealer onboarding process?

Confirm who approves a dealer, provides the Dealer Code, verifies CRM
details, and authorizes production activation.

### MG-014 --- What should happen if a live dealer changes CRM platforms?

Clarify how pending leads, existing record IDs, status mappings, retry
jobs, and historical logs should be handled.

### MG-015 --- Can a CRM configuration be changed while leads are being processed?

If not, confirm the expected maintenance/pausing procedure.

### MG-016 --- What approval is required before a new CRM adapter is enabled in production?

Confirm test evidence, stakeholder sign-off, and rollout expectations.

## A4. AutoPlay CRM

### MG-017 --- Which dealers use AutoPlay CRM?

Please provide the confirmed dealer names and Dealer Codes.

### MG-018 --- Is AutoPlay approved for integration with the MG Motor middleware?

Confirm the business approval and any contractual or security
prerequisites.

### MG-019 --- Who will provide AutoPlay API documentation, sandbox access, and technical contacts?

Identify the owner and expected availability.

### MG-020 --- Are there AutoPlay-specific field requirements or business rules?

Confirm any differences in lead creation, required fields, statuses, and
dealer updates.

## A5. Duplicate Leads and Record Ownership

### MG-021 --- What is MG's business definition of a duplicate lead?

For example, should duplicate detection use the MG lead ID, customer
details, or another stable identifier?

### MG-022 --- Which unique identifier should be used to match a lead across MG and dealer CRMs?

Confirm the authoritative external reference that should be preserved.

### MG-023 --- If the lead already exists in a dealer CRM, should the middleware update the existing record instead of creating a new one?

Confirm the expected behaviour and exceptions.

### MG-024 --- How should intentionally cloned or resubmitted leads in MG be handled?

Confirm whether they should be treated as new enquiries or linked to an
existing lead.

### MG-025 --- If the dealer CRM creates a lead but the middleware times out before receiving the response, what business outcome is expected?

The technical team will investigate safe lookup/idempotency options.
Confirm any business rules for reconciliation or manual review.

## A6. API Limits, Volumes, and Service Expectations

### MG-026 --- What lead volume should the middleware support?

Please provide expected daily volume, peak hourly volume, and peak
concurrent updates if known.

### MG-027 --- What are the expected lead-delivery and status-sync service levels?

Confirm any maximum acceptable delay and support expectations.

### MG-028 --- Are there MG Zoho CRM API quotas, concurrency limits, or webhook restrictions we must observe?

Please provide applicable account/API details or official documentation.

### MG-029 --- What should happen when Zoho CRM or webhook delivery is temporarily unavailable?

Confirm any business requirements for delayed processing and escalation.

### MG-030 --- Is a reconciliation process required to identify leads missed by webhooks?

Confirm whether periodic comparison/backfill is expected and which
system is authoritative.

## A7. Timezone, Notifications, and Retention

### MG-031 --- Which Australian timezone should be used for central MG reporting and scheduled operational tasks?

Please specify the state/region or IANA timezone identifier. Australia
has multiple timezones.

### MG-032 --- Should dealer-facing schedules follow each dealer's local timezone while central reporting uses a designated MG timezone?

Confirm the desired behaviour, including daylight-saving changes.

### MG-033 --- Who should receive notifications for sync failures, missing Dealer Codes, repeated errors, and long processing delays?

Provide role/team ownership rather than personal credentials.

### MG-034 --- Which notification channels are required?

Confirm email, in-application notifications, or other approved channels.

### MG-035 --- Which failures require immediate escalation versus a periodic summary?

Confirm severity and escalation expectations.

### MG-036 --- How long should synchronization logs and historical records be retained?

Confirm business, audit, and compliance requirements.

------------------------------------------------------------------------

# Part B --- Questions for Fusion SD / AMS Pro

## B1. Documentation and Authentication

### FUS-001 --- Please provide the official API documentation.

We need the supported operations and request/response formats for lead
creation, retrieval, update, and search.

### FUS-002 --- Please confirm the authentication flow.

Include required scopes, token lifetime, refresh procedure, and
recommended renewal timing.

### FUS-003 --- Are sandbox and production authentication settings different?

Please confirm endpoints, scopes, credential requirements, and any
payload differences.

### FUS-004 --- Are credentials and API limits scoped per dealer, per credential, per account, or per endpoint?

This determines safe credential isolation and rate-limit handling.

## B2. Lead Creation and Contact Validation

### FUS-005 --- What fields are mandatory for creating a lead?

Please provide the required fields and exact API property names.

### FUS-006 --- What is the expected structure for contact information?

Please confirm the required format for first name, last name, email,
phone, and any nested contact object.

### FUS-007 --- Why might the API return HTTP 422 `missing_contact` when contact details are included?

During testing, the request included contact details but received a
`missing_contact` response. Please confirm the expected payload
structure and validation rules. A sanitized example of a valid request
would help.

### FUS-008 --- Do required fields or validation rules differ between sandbox and production?

Please identify any differences.

### FUS-009 --- How should the middleware retrieve the Fusion lead ID after successful creation?

Please confirm where the record ID appears in the response or which
follow-up lookup should be used.

### FUS-010 --- What is the recommended procedure if a lead is created but the response does not contain a record ID?

We need to locate the created record without creating a duplicate.

## B3. Status and Field Mapping

### FUS-011 --- Please provide all supported Fusion lead statuses and their exact API values.

Include the business meaning of each status.

### FUS-012 --- Which status transitions are allowed or restricted?

Please provide any transition rules.

### FUS-013 --- What mapping approach do you recommend when MG has more statuses than Fusion?

The final business mapping will also require MG approval.

### FUS-014 --- Please provide the exact API field names and allowed enum values for Enquiry Type, Origin, Source, and Campaign.

Please confirm whether these values are case-sensitive.

### FUS-015 --- Are these fields mandatory, optional, or conditionally required?

Include validation rules and dependencies.

### FUS-016 --- How should unsupported or unmapped values be handled?

Please clarify whether the API rejects them, ignores them, or supports
another safe representation.

### FUS-017 --- Does Fusion support webhooks for dealer lead/status changes?

If yes, please provide event types, payloads, authentication
requirements, delivery retries, and duplicate-event behaviour.

## B4. Rate Limits, Timeouts, and Retry Behaviour

### FUS-018 --- What are the official API rate limits and concurrency limits?

Please specify limits for lead creation, update, and retrieval,
including the scope to which each limit applies.

### FUS-019 --- What connection and response timeout values do you recommend?

Please clarify normal response-time expectations and any
endpoint-specific differences.

### FUS-020 --- Which HTTP statuses and error types are considered transient and safe to retry?

Please include any retry guidance.

### FUS-021 --- Which errors should be treated as permanent until configuration or data is corrected?

Please provide examples.

### FUS-022 --- Does Fusion return `Retry-After` or equivalent information for rate-limited requests?

If yes, please document its format.

### FUS-023 --- Does Fusion support idempotency keys or another duplicate-prevention mechanism for lead creation?

Please provide the supported mechanism and retention/expiry rules.

### FUS-024 --- If Fusion receives a create request but the middleware times out before receiving the response, what is the recommended recovery process?

We need to determine whether the lead was created before safely
retrying.

### FUS-025 --- Can the API search for a lead by an external MG lead ID or another stable unique reference?

Please provide the endpoint and query requirements.

## B5. Current Outcome Sequence: Unhappy 1 → Happy 4 → Happy 1

### FUS-026 --- Can you help verify what Fusion receives and processes during the initial request?

In our middleware, a lead follows this sequence:

`Unhappy 1 → Happy 4 (Recovery) → Happy 1`

Fusion is connected, but the first attempt is classified as unhappy
before recovery succeeds.

Please help us establish: - Whether Fusion received the initial
request. - Whether Fusion created the lead despite a delayed response. -
Whether a server-side error occurred or the middleware simply did not
receive a response in time. - The actual server-side processing time, if
available. - Whether authentication, validation, rate limiting, or
another condition affected the request. - Whether request IDs/timestamps
can be matched with Fusion logs.

Our internal team will separately inspect middleware timeout
configuration, retry classification, recovery bookkeeping, and duplicate
prevention. We are not assuming Fusion is the root cause without
evidence.

## B6. Updating Existing Records

### FUS-027 --- What is the recommended API operation for updating an existing lead by Fusion record ID?

### FUS-028 --- Can status and dealer remarks be updated without overwriting unrelated fields?

Please confirm whether partial updates are supported.

### FUS-029 --- If partial updates are not supported, which fields must be included in every update request?

### FUS-030 --- How should concurrent updates to the same lead be handled?

Does Fusion support versioning, ETags, optimistic concurrency, or
another conflict-detection mechanism?

### FUS-031 --- Does Fusion expose a stable external lead reference and authoritative last-modified timestamp?

## B7. Sandbox and Production Readiness

### FUS-032 --- Are sandbox and production API endpoints, payloads, and validation rules identical?

### FUS-033 --- What sandbox rate limits and testing practices should we follow?

### FUS-034 --- Can you provide sanitized examples of successful and failed lead create/update responses?

### FUS-035 --- Are there known sandbox limitations that can cause behaviour different from production?

### FUS-036 --- Which request IDs, logs, or diagnostic details can Fusion provide for troubleshooting failed API calls?

### FUS-037 --- What is the recommended approval and rollout process for enabling a newly onboarded dealer in production?

------------------------------------------------------------------------

# Part C --- Decision Register

Use this section to track every unanswered question and the
implementation it affects.

  ------------------------------------------------------------------------------------------------------------------
  Decision   Related    Owner     Decision needed    Blocks               Blocks        Status    Due     Final
  ID         Question                                implementation?      production?             date    decision /
                                                                                                          evidence
  ---------- ---------- --------- ------------------ -------------------- ------------- --------- ------- ----------
  DEC-001    MG-001     MG Motor  Missing Dealer     Yes, for final       Potentially   Pending   TBD     
                                  Code rule          routing behaviour                                    

  DEC-002    MG-005     MG        Approved status    Yes, for final       Yes, if       Pending   TBD     
                        Motor +   mapping            mapping              statuses are                    
                        Fusion                                            required for                    
                                                                          go-live                         

  DEC-003    MG-017     MG Motor  Confirm AutoPlay   Yes, for AutoPlay    Yes, for      Pending   TBD     
                                  dealers            scope                AutoPlay                        
                                                                          onboarding                      

  DEC-004    FUS-007    Fusion    Contact payload    Yes, if current      Potentially   Pending   TBD     
                                  requirements       create failures                                      
                                                     remain unresolved                                    

  DEC-005    FUS-018    Fusion    API                Required for         Potentially   Pending   TBD     
                                  rate/concurrency   verified capacity                                    
                                  limits             design                                               

  DEC-006    FUS-019    Fusion    Recommended        Required for timeout Potentially   Pending   TBD     
                                  timeout behaviour  tuning                                               

  DEC-007    MG-031     MG Motor  Central timezone   Required for         Potentially   Pending   TBD     
                                                     schedule/reporting                                   
                                                     configuration                                        
  ------------------------------------------------------------------------------------------------------------------

Suggested status values: **Pending, Awaiting MG Motor, Awaiting Fusion,
Internal Review, Approved, Rejected, Implemented, Verified**.

A recommendation from the development team must not be recorded as an
approved stakeholder decision until the responsible stakeholder confirms
it.

------------------------------------------------------------------------

# Part D --- Dealer CRM Onboarding Checklist

  --------------------------------------------------------------------------------------------------------------------------------------------
  Dealer Code Dealer Name CRM        CRM          Documentation   Sandbox   Create    Update    Status      Limits       Production   Open
                          Platform   confirmed?   received?       access    tested?   tested?   mapping     confirmed?   approved?    issues
                                                                  ready?                        approved?                             
  ----------- ----------- ---------- ------------ --------------- --------- --------- --------- ----------- ------------ ------------ --------
  To be       To be       Fusion SD  Verify       Verify          Verify    Verify    Verify    Pending     Pending      Pending      
  confirmed   confirmed   / AMS Pro                                                                                                   

  To be       To be       AutoPlay   Pending      Pending         Pending   Pending   Pending   Pending     Pending      Pending      
  confirmed   confirmed                                                                                                               

  To be       To be       Future CRM Pending      Pending         Pending   Pending   Pending   Pending     Pending      Pending      
  confirmed   confirmed                                                                                                               
  --------------------------------------------------------------------------------------------------------------------------------------------

Do not invent dealer names or Dealer Codes. Populate them only from
confirmed records.

------------------------------------------------------------------------

# Meeting Outcome Template

For each MG Motor or Fusion discussion, record:

-   **Meeting date:**
-   **Participants:**
-   **Questions answered:**
-   **Decisions confirmed:**
-   **Questions still open:**
-   **Implementation work unblocked:**
-   **Implementation still blocked:**
-   **Action owner and due date:**
-   **Supporting documentation / evidence:**

## Completion Criteria

The clarification process is complete when each question has a
documented response or is explicitly marked as not applicable, the
decision owner is identified, the implementation impact is understood,
and approved decisions have been implemented and verified through
appropriate tests.
