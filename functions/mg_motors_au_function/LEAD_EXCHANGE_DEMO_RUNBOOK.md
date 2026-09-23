# MG Lead Exchange — 15-path demo runbook

## Scope used

The concrete Pilot scope is **Happy 1–5 plus Unhappy 1–10 (15 paths)**. The supplied draft also contains Unhappy 11–12, while the enhanced workbook's Read Me refers to proposed Happy 6 / Unhappy 13–14. The implementation retains safe handling for Unhappy 11–12, but this runbook does not silently substitute those proposed paths for the requested 15.

## Synchronisation faults fixed

1. Outbound status was copied raw into the configured target and then translated into a separate hard-coded `status` property. Dealer APIs could receive two contradictory statuses.
2. Inbound mapping left the raw dealer status in the update after a mapping failure, so an unapproved value could reach MG.
3. Echo prevention compared a hash of the mapped outbound payload with a hash of the dealer's entire webhook record. Those shapes can never match, so the loop guard was dead.
4. Webhook dedupe treated the dealer lead ID as an event ID. After the first webhook, later updates for the same lead were discarded.
5. Payload-hash dedupe was unsafe for Zoho notifications: two rapid changes can have identical notification bodies (`ids` plus `affected_fields`). Only a provider event ID is now used for event-level dedupe; business-state fingerprints make no-ID retries idempotent.
6. The OEM webhook returned before lead/dealer synchronisation completed. A serverless runtime could freeze the unfinished work.
7. `fetchDealerMaster()` referenced undefined variables before making the CRM call, breaking dealer synchronisation.
8. Status rows were stored in both directions, but the mapper ignored the `direction` column. Reversed rows and query order could therefore choose a value from the wrong CRM. Direction is now enforced and ambiguous mappings are held.
9. The code queried and wrote MG fields that do not exist (`Customer_Name`, `Dealer_Remarks`, `Assigned_Date`, `Last_Status_Update`). Live metadata confirms names are `First_Name` + mandatory `Last_Name`, and `Lead_Status_Modified_Time`; unsupported writes are now blocked.

## Production configuration checklist

Configure these Catalyst environment variables before deployment:

- `CRON_SECRET`: long random secret sent as `X-Cron-Secret` by every scheduler job.
- `PUBLIC_FUNCTION_BASE_URL`: deployed function base URL, without a trailing slash.
- `INTEGRATION_CREDENTIALS_KEY`: encryption key already required by dealer credential storage.
- `INTEGRATION_ALERT_FROM_EMAIL`: verified Catalyst sender.
- `INTEGRATION_ALERT_TO_EMAILS`: comma-separated MG and FI Digital immediate-alert recipients.
- `DAILY_ERROR_REPORT_TO_EMAILS`: comma-separated 12pm report recipients.
- `DUPLICATE_WINDOW_MINUTES=15` (15 is also the default).
- `UNHAPPY_3_ESCALATION_WINDOW_MINUTES=1440` or omit it in production.
- `DEALER_ACTION_SLA_MINUTES=1440` or omit it in production.
- `OUTBOUND_RETRY_INTERVAL_MINUTES=15` or omit it.
- `DEALER_WRITABLE_FIELDS`: comma-separated, MG-approved ownership matrix. The conservative default is `lead_status,enquiry_outcome,purchase_classification`. Do not add `dealer_remarks` unless MG first approves a real destination field; `Dealer_Remarks` does not exist.
- `ALLOW_INSECURE_WEBHOOKS` must be absent/false in production.

For each external dealer, complete and test the connection, generate a webhook secret, map every mandatory field shown in the UI, map every dealer status MG has approved, then register the webhook. Do not map `Junk Lead` to `Not Qualified`; both live AU008 and MG picklists contain the exact value `Junk Lead`.

For every dealer Zoho org, the field targeted by the mandatory `enquiry_id` mapping must be marked **unique / external ID**. Zoho delivery uses its supported [`/Leads/upsert`](https://www.zoho.com/crm/developer/docs/api/v8/upsert-records.html) endpoint with that field, so a timeout followed by retry resolves to the same dealer record. Do not substitute Email or Mobile: the register requires separate enquiries for the same customer when model, variant, or nature differs.

After deploying this build, open AU008's Connection tab and click **Renew Dealer Webhook** once. The renewal uses Zoho's 48-character derived callback token (the API maximum is 50), subscribes to `Leads.edit`, and enables affected-field details. Existing stored webhook credentials do not need to be exposed or replaced. Confirm the returned channel expiry and keep the 12–20 hour renewal schedule enabled.

For the AU008 demo, open Status Mapping, click **Load verified AU008 map**, review, and save. The canonical pairs are:

| MG | AU008 dealer |
|---|---|
| Not Contacted | Received / Acknowledged |
| Follow-up 1 | Follow-up 1 / In progress |
| Follow-up 2 | Follow-up 2 |
| Contacted | Contacted |
| Contact in Future | Nurture / Future |
| Not Qualified | Not Qualified |
| Dropped | Dropped |
| Lost | Lost (final) |
| Attempted to Contact | Attempted to Contact |
| Junk Lead | Junk Lead |
| Lost Lead | Lost Lead |
| Pre-Qualified | Pre-Qualified |

Saving also creates the reverse rows, so `Received / Acknowledged` writes MG `Not Contacted`. `Update Pending` is deliberately not sent to the dealer; it is MG's pre-delivery state. `Dealer Unavailable` and `Unattended Alert` are also MG-only scheduler states.

Confirm these datastore capabilities before deploy:

- `webhook_events.dedupe_key` has a unique constraint.
- `lead_integrations` has no duplicate `(integration_id, zoho_lead_id)` or `(integration_id, external_crm_lead_id)` pairs.
- `lead_integrations` supports `PENDING`, `FAILED`, `FAILED_CRITICAL`, `SYNCED`, `HELD`, `CONSENT_HOLD`, and `SLA_BREACH`, plus the retry/fingerprint columns used in code.
- `integration_logs` and `leads` include `happy_unhappy_path_name`, `happy_unhappy_path_message`, and preferably `happy_unhappy_path_priority`.
- `integration_logs.field_changes` can hold the JSON audit detail.

Create scheduler calls (all `POST`, all with `X-Cron-Secret`):

| Frequency | Endpoint | Purpose |
|---|---|---|
| Every 5–15 min | `/cron/retry-outbound-syncs` | Unhappy 1 retries; Unhappy 3 escalation; Happy 4 recovery |
| Every 5–15 min | `/cron/replay-inbound-events` | Replays Unhappy 4/7/9 held inbound events |
| Every 15 min | `/cron/check-lead-sla` | Unhappy 10 |
| Daily | `/cron/reconcile-dealer-leads` | Happy 2/5 missed-event reconciliation |
| Daily at 12pm | `/cron/daily-error-report` | MG error report (confirm the business timezone) |
| Every 12–20 hr | `/cron/renew-webhook` and `/cron/renew-dealer-webhooks` | Renew 23-hour Zoho channels |

## Demo matrix

| Path | Demo action | Expected evidence |
|---|---|---|
| Happy 1 | Submit one fully valid, unique enquiry to an active/configured dealer. | One dealer record and record ID; MG changes to Not Contacted only after acknowledgement; Happy 1 in timeline/log. |
| Happy 2 | Dealer changes status through Contacted, Not Qualified, Dropped, or Lost. | Approved MG status writes back; negative sales outcomes still show Happy 2. |
| Happy 3 | Submit every mandatory value identically within 15 minutes. Then change model or nature and submit again. | Exact repeat is `DUPLICATE_LINKED` and not sent; changed enquiry is sent. |
| Happy 4 | Make the dealer endpoint fail, restore it, then run retry cron. | Same idempotency key, one dealer record, prior failure retained, recovery shown as Happy 4. |
| Happy 5 | Dealer changes an approved dealer-owned field such as outcome or purchase classification. | MG receives the change, old/new values are audited, and no echo loop follows. |
| Unhappy 1 | Return timeout/5xx from dealer API for less than 24 hours. | `DELIVERY_FAILED`, retry metadata, immediate alert, Unhappy 1. |
| Unhappy 2 | Use a blank surname, all-zero/over-length mobile, malformed email, invalid postcode, or missing mandatory value. | `VALIDATION_HOLD`; no dealer API call; immediate alert and Unhappy 2. |
| Unhappy 3 | Keep a transport failure beyond the configured escalation window and run retry cron. | `FAILED_CRITICAL`, MG status Dealer Unavailable, P1 alert, Unhappy 3. |
| Unhappy 4 | Send an unmapped dealer status or make MG write-back fail. | Raw value is retained in the log, MG is not overwritten, event is held/replayed, Unhappy 4. |
| Unhappy 5 | Use no dealer, removed dealer, disabled/unconfigured integration, or incomplete mandatory maps. | `ROUTING_HOLD`; no dealer API call; Unhappy 5. |
| Unhappy 6 | Dealer attempts to change an MG-owned identity/contact/privacy field. | Change is not applied; both masked values and ownership decision are audited; Unhappy 6. |
| Unhappy 7 | Send dealer update before its `lead_integrations` mapping exists, then create the mapping and run replay cron. | Event remains PENDING, then re-fetches and applies after prerequisite exists. |
| Unhappy 8 | Set privacy consent false/missing/untranslatable while marketing is independently optional. | `CONSENT_HOLD`, no PII sent to dealer, P1 alert; missing marketing alone still delivers. |
| Unhappy 9 | Dealer sets exact `Junk Lead`. Also test `Lost (final)`. | Junk maps to MG `Junk Lead` and alerts as Unhappy 9; Lost maps to MG `Lost` and is Happy 2. |
| Unhappy 10 | Leave a successfully acknowledged Not Contacted lead unchanged beyond the SLA and run SLA cron. | Integration health is checked first; MG becomes Unattended Alert; dealer/admin alert and Unhappy 10. |

## Verification

```bash
cd functions/mg_motors_au_function
npm test

cd ../../mg-motor-web
BUILD_PATH=/private/tmp/mg-motor-web-build node node_modules/react-scripts/bin/react-scripts.js build
```

For production, do not use shortened demo timers. Reset the Unhappy 3 and SLA windows to 1440 minutes before deployment.

## Demo go/no-go gate

Do not start the customer demo until all of these are green:

1. Deploy the function and web build from the same revision.
2. Set the production-safe environment variables above; confirm both 24-hour timers are `1440`.
3. Use **AU008**, not AU001; test the connection successfully.
4. Verify every mandatory dealer field API name, and make the mapped Inquiry ID field unique/external in AU008.
5. Click **Load verified AU008 map**, save, reload the page, and confirm the 12 canonical pairs remain exactly as listed.
6. Renew the AU008 webhook and confirm its channel registration succeeds.
7. Run one smoke sequence: valid new lead (Happy 1), dealer status `Contacted` (Happy 2), and dealer status `Junk Lead` (Unhappy 9). Confirm MG, AU008, Catalyst, and the activity log agree after each step.
8. Keep the four retry/replay/SLA/reconciliation schedulers enabled; confirm the daily-report recipient and timezone.

## Items that still require MG / environment confirmation

- Exact target field API names and field types for each dealer CRM.
- The complete MG-approved per-field ownership matrix; the code deliberately uses a conservative allow-list until sign-off.
- Whether MG approves mapping dealer remarks to the standard `Description` field; until then remarks are held as an ownership conflict rather than written to a nonexistent field.
- Whether the 24-hour SLA uses calendar hours or dealership trading hours.
- Production alert recipients, verified sender, business timezone, and Catalyst scheduler creation.
- Actual end-to-end testing against each dealer sandbox and MG's production-like Zoho environment.
