# Verified CRM Facts — Lead Exchange

Environment-specific statements below were read from a **live system**, not
inferred from code. The notification/upsert protocol statements are verified
against Zoho's official V8 API documentation.

| Source | Access |
|---|---|
| MG OEM CRM | `mg-motor-crm-catalyst` MCP, org `1378627…` |
| Dealer CRM (AU008) | `mg-motor-dealer-crm` MCP, org `1405726…` |
| Catalyst datastore | `mg-motor-catalyst` MCP, project `37148000000359003`, org `60069659585` |

---

## 1. Fields that DO NOT EXIST on MG's Leads module

Verified via `getFields(module=Leads)` — 100 fields returned.

| Code referenced | Reality |
|---|---|
| `Customer_Name` | **Does not exist.** Name is `First_Name` + `Last_Name`. `Full_Name` exists but is Zoho-derived / read-only — never write it. |
| `Dealer_Remarks` | **Does not exist.** Nearest home is standard `Description` textarea — needs an MG mapping decision. |
| `Assigned_Date` | **Does not exist.** No equivalent. |
| `Last_Status_Update` | **Does not exist.** Real api_name is `Lead_Status_Modified_Time`. |

Zoho **silently drops** unknown names from the `fields` query param (no error), so these
came back absent on every record and the columns were permanently blank. On **write**,
Zoho rejects unknown fields — so a dealer remarks update was a hard failure.

The local `leads.assigned_date` column is now populated from Zoho's real,
read-only `Created_Time` solely as the stable submission timestamp for the
15-minute duplicate rule; the code does not query or write an `Assigned_Date`
CRM field.

`Last_Name` is `system_mandatory = true`. A single-token name must go to `Last_Name`.
MG `Postcode` is **text, max length 4** (Australian format).

## 2. Status picklists — authoritative

**MG OEM `Lead_Status` (16)**
`-None-`, `Update Pending`, `Not Contacted`, `Follow-up 1`, `Follow-up 2`, `Contacted`,
`Contact in Future`, `Not Qualified`, `Dropped`, `Lost`, `Dealer Unavailable`,
`Unattended Alert`, `Attempted to Contact`, `Junk Lead`, `Lost Lead`, `Pre-Qualified`

**Dealer `Lead_Status` (15)**
`-None-`, `Received / Acknowledged`, `Follow-up 1 / In progress`, `Follow-up 2`,
`Contacted`, `Nurture / Future`, `Dropped`, `Lost (final)`, `Not Qualified`,
`Attempted to Contact`, `Contact in Future`, `Junk Lead`, `Lost Lead`, `Not Contacted`,
`Pre-Qualified`

`Dealer Unavailable` and `Unattended Alert` DO exist in MG — Unhappy 3 and Unhappy 10
can legitimately write them. There is **no** `Consent Hold` value; Unhappy 8's MG-side
hold status has nowhere to go until MG adds one.

## 3. `integration_status_mappings` — 8 of 14 rows broken (AU008, `37148000000739047`)

`source_status` must be an MG value; `target_status` must be a dealer value.

| source | target | verdict |
|---|---|---|
| `Lost (final)` | `Lost` | BROKEN — reverse row, neither side valid |
| `Follow-up 1 / In progress` | `Follow-up 1` | BROKEN — reverse row, neither side valid |
| `Junk Lead / Spam` | `Junk Lead` | BROKEN — source not an MG value |
| `Junk Lead` | `Junk Lead / Spam` | BROKEN — target not a dealer value |
| `Not Contacted` | `Not Contacted` | duplicate (x2) |
| `Contacted` | `Contacted` | duplicate (x2) |
| `Follow-up 2` | `Follow-up 2` | duplicate (x2) |
| `Contact in Future` | `Nurture / Future` | duplicate (x2) |

**`Junk Lead / Spam` exists in NEITHER CRM.** With the broken live row, Unhappy 9
cannot sync in either direction. The implemented AU008 repair profile uses the correct
pair: `Junk Lead` -> `Junk Lead`.

Reverse rows matter because `mapStatus` used a plain `.find()` — inbound `Lost` could
resolve to `Lost (final)`, which MG rejects with `INVALID_DATA`.

Per the register's mapping table: dealer `Received / Acknowledged` -> MG `Not Contacted`.

## 4. Catalyst schema

`happy_unhappy_path_priority` was **missing** from `integration_logs` AND `leads`.
`writeLog` set it for P1 scenarios, Catalyst rejected the whole insert, the `catch`
swallowed it — so **Unhappy 3 and Unhappy 8 produced 0 log rows across 511 entries**,
while the DB held 4 `FAILED_CRITICAL` and 3 `CONSENT_HOLD` rows proving the logic ran.

Added to both tables as `varchar(10)` on 2026-09-23.

Provisioned but unused: `dealer_integrations.dedupe_window_days` (default **30 days** —
register requires **15 minutes**), `dedupe_match_email`, `dedupe_match_mobile`.

## 5. Integrations

| Dealer | ROWID | Status | Notes |
|---|---|---|---|
| AU008 | `37148000000739047` | ACTIVE | Working demo dealer. Has `WEBHOOK_SECRET`. `dealer_code -> Company` confirmed correct. |
| AU001 | `37148000000843255` | **ERROR** | `AUTHENTICATION_FAILED`. No `WEBHOOK_SECRET`. Field map is test junk: `vehicle_model -> Twitter` (**`Twitter` does not exist on the dealer module**), `dealer_code -> City`. |

## 6. The echo loop

Outbound stored `sha256(mapped external payload)`; inbound compared
`sha256(dealer's whole record)`. Structurally different objects, so `LOOP_PREVENTED` was
unreachable dead code. Confirmed in `integration_logs`: every outbound `Happy 1` followed
within <1s by an inbound `Happy 5`/`Happy 2` on the same dealer, repeatedly, all day.

Fixed by `services/integrations/leadFingerprintService.js` — a canonical internal-state
fingerprint both directions compute identically over the same key set.

## 7. Dealer status classification

`pathPolicyService.PROGRESS_STATUSES` originally listed bare words (`received`,
`nurture`, `lost`) but the dealer uses compound values — **6 of 14 real dealer statuses
were unclassified**. Fixed via `statusComponents()`, which matches the whole value, each
`/`-separated part, and each with parentheticals stripped. Now 0/14 unclassified.

## 8. Configuration repair implemented in code

The status mapper now honors each row's `direction`, validates dealer -> MG results
against the verified MG picklist, and refuses ambiguous results. The admin save path
upserts complete forward/reverse pairs before removing orphaned or duplicate rows.
For AU008, the UI exposes a reviewed profile using exact live values, including
`Received / Acknowledged` -> `Not Contacted`, `Lost (final)` -> `Lost`, and
`Junk Lead` -> `Junk Lead`.

## 9. Zoho notification contract

Zoho's [V8 Enable Notifications documentation](https://www.zoho.com/crm/developer/docs/api/v8/notifications/enable.html)
returns `token`, `channel_id`, `module`, `ids`, and `affected_fields`
in the callback body. Its configured callback token is limited to 50
characters; the application previously generated a 64-character hexadecimal
secret and sent it directly, so dealer watch registration could be rejected as
`INVALID_DATA`. Registration now sends a deterministic 48-character token
derived from the encrypted credential, and verification accepts both that form
and legacy short direct tokens.

Dealer watches now request affected-field details and subscribe to `Leads.edit`
only. An empty `affected_fields` array safely falls back to comparing the fetched
full dealer record instead of being treated as “nothing to map.” The deployed
AU008 watch channel must be renewed once for these subscription settings to take
effect.
