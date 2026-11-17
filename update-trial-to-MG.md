# Update: Trial → MG (Catalyst migration, fixes and data clean-up)

Working notes for **16–17 Nov 2026**. They cover everything done in this working session: the plan and
status of moving the Lead Exchange from the trial Catalyst account to MG Motor's AU account, the
investigations, the code changes (deployed to the trial project), the live data fixes in MG Zoho, and
what is still open.

> No secrets are recorded here. Where a secret matters it is named, never quoted.

## At a glance: what has been updated, and what has not

**Updated (done and verified)**

| Area | What changed | Where |
|---|---|---|
| Code | Dealer CRM ID and Middleware ID written to MG Zoho on delivery; Fusion webhook waits out a busy lead lock; Fusion Lost also sets Enquiry Outcome = Lost | commit `a7d153c` on `main`, **deployed to the trial project** |
| Function settings | `ESCALATION_TRANSIENT_ONLY=true`, `INBOUND_EVENT_STORE=true` | trial function (via `catalyst-config.json`, 39 variables) |
| MG Zoho data | 3 leads reset from "Dealer Unavailable"; Connected CRM, Dealer CRM ID, Middleware ID on all 138 pushed Fusion leads; Lead Exchanged on all 138; Enquiry Outcome "Lost" on 12 Lost leads; First Action Date (7) and Closed Date (5) | MG Zoho CRM, read back after writing |
| Tooling | AU Catalyst MCP added to the Claude config (user-scope server `catalyst-au-dc`); a read-only monitor for Fusion updates on the 32 leads | Claude Code, this session |
| Documents | `Fusion_SD_32_Leads.xlsx` (outside git); this file | `C:\Users\surya\OneDrive\Desktop\catalyst\` and the repo root |

**Not updated yet**
- The **AU (MG) project**: no code deployed, no data copied, nothing configured.
- The wipe-vs-merge decision for the existing AU rows.
- Fusion-side settings (lead updates for Hillcrest and Indooroopilly), the "pendingLost" status mapping, and two leads with an empty email.
- About 250 delivered Dealer Studio / AU008 leads have none of the Leads Exchange Activity fields filled.

---

## 1. The two environments

| | **Trial (source, live today)** | **MG account (target, AU DC)** |
|---|---|---|
| Project | MG-motors-au | MG-motors-au |
| Project ID | `37148000000359003` | `818000000022001` |
| Catalyst org | `60069659585` | `7007717417` |
| Data centre | India (`.in`) | Australia (`.com.au`) |
| Owner | trial account (`suryastillz073@gmail.com`) | `webmaster@mgmotor.com.au` (MG ANZ Development) |
| Environment | Development | Development (the only one) |
| Timezone | Asia/Kolkata | Australia/Sydney |
| Base URL | `https://mg-motors-au-60069659585.development.catalystserverless.in` | `https://mg-motors-au-7007717417.development.catalystserverless.com.au` *(expected, not yet tested)* |
| Function | `mg_motors_au_function` (id `37148000000358002`) | **not deployed yet** |
| Code deployed | latest (commit `a7d153c`, 17 Nov) | none |

The CLI is currently logged in as the **trial** account and `.catalystrc` points at the **trial**
project. Nothing has been deployed to the AU project.

### MCP access
- The AU Catalyst MCP was added to Claude Code at **user scope** as `catalyst-au-dc` (the URL contains a
  key, so it is kept in `~/.claude.json`, not in the repo's `.mcp.json`).
- The trial project is reached through the existing `catalyst-mcp` server.
- Every MCP call needs the right pair: trial = project `37148000000359003` / org `60069659585`; AU =
  project `818000000022001` / org `7007717417`.

---

## 2. Data Store: state on 16 Nov

Both projects have the **same 19 tables**, so no schema creation is needed. **The AU tables are not
empty**, so this is not a load into a blank project.

| Table | Trial table id | AU table id |
|---|---|---|
| leads | 37148000000442417 | 818000000027847 |
| dealers | 37148000000425015 | 818000000029087 |
| dealer_integrations | 37148000000735014 | 818000000026261 |
| integration_credentials | 37148000000735405 | 818000000025881 |
| integration_field_mappings | 37148000000735770 | 818000000025497 |
| integration_status_mappings | 37148000000750140 | 818000000025115 |
| lead_integrations | 37148000000750507 | 818000000024711 |
| webhook_events | 37148000000750882 | 818000000024319 |
| webhook_channels | 37148000000513014 | 818000000027459 |
| integration_logs | 37148000000751257 | 818000000023550 |
| sync_logs | 37148000000425411 | 818000000028687 |
| outbound_sync_claims | 37148000000899910 | 818000000023954 |
| integration_alert_queue | 37148000000899036 | 818000000018780 |
| oem_status_picklist | 37148000000850070 | 818000000023166 |
| notifications | 37148000000712035 | 818000000026679 |
| admin_user_mapping | 37148000000645020 | 818000000027071 |
| dealer_user_mapping | 37148000000442812 | 818000000028297 |
| cost_daily | 37148000001162178 | 818000000018389 |
| cost_usage_hourly | 37148000001160164 | 818000000018022 |

Row counts measured (only these were counted):

| Table | Trial | AU |
|---|---|---|
| leads | 6,460 | 2,964 |
| dealers | 242 | 238 |
| dealer_integrations | 13 | 8 |
| lead_integrations | 508 | not counted |
| sync_logs | 44,392 | not counted |
| integration_credentials | 31 | not counted |

**Open decision:** wipe-and-reload the AU tables, or merge only the missing rows (matched on business
keys such as the CRM lead id, never on `ROWID`). The 2,964 AU leads have not been compared with the trial
data yet, so it is unknown whether they overlap.

---

## 3. Dealers and integrations (trial project)

| Dealer | Code | CRM type | Push enabled |
|---|---|---|---|
| Tynan MG | 223201 | Fusion SD | no |
| Hillcrest MG | 411802 | Fusion SD | no |
| Buckby MG | 725001 | Fusion SD | no |
| Indooroopilly MG | 406802 | Fusion SD | no |
| Fusion Test Dealer | 568026 | Fusion SD (QA, `qa.fusionamspro.com`) | **yes** |
| AU001, AU013 | – | Fusion SD, **not configured** | – |
| Dealer Studio dealers | 654321, 421501, 302901, 315602, 275002, 215402 | Dealer Studio | only 654321 |
| AU008 | AU008 | Zoho CRM | – |

Since 1 Nov, 129 leads were assigned to the four live Fusion dealers but only 32 were actually pushed
(Push is OFF for all four). The last push to them was on 6 Nov.

### Fusion webhook URLs (per dealer)
```
POST <function base URL>/server/mg_motors_au_function/webhooks/dealers/<dealerCode>
```
- Trial (today): `https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function/webhooks/dealers/<dealerCode>`
- AU (after deploy, to confirm): `https://mg-motors-au-7007717417.development.catalystserverless.com.au/server/mg_motors_au_function/webhooks/dealers/<dealerCode>`
- Requests are signed with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`); the shared `FUSION_WEBHOOK_SECRET` is accepted for the dealers listed in
  `FUSION_WEBHOOK_DEALER_CODES` (currently `568026`).
- The body carries `lead_id` (or `leadId`) and the status as `enquiryStatus`.
- Hillcrest and Indooroopilly have sent no webhook since 28 Oct.

---

## 4. Investigations and findings

1. **Fusion webhook / secret check (dealer 568026).** No request from Fusion reached us for the lead
   under test. A signed test event sent to our endpoint returned `200`, scenario **Happy 2**, and applied
   correctly, so our URL and secret work. Fusion's side (registration, trigger, signing secret) was the
   gap. Later Fusion tests worked.
2. **Fusion cannot be read.** Fusion documents no GET/list endpoint, so `getLead` is off by design.
   Their current state can only be learned from webhooks (or an export from Fusion).
3. **"Dealer Unavailable" on 3 leads.** Cause: an *update* to Fusion timed out twice in a row, which
   escalated to **Unhappy 3** and set MG's status to "Dealer Unavailable". Fusion then answered the next
   update with **403 "updates not enabled"** (Indooroopilly and Hillcrest have lead updates switched off
   for MG), which is only logged and never clears the status. The leads had in fact been delivered and had
   dealer record IDs. Other leads were not flagged because their failures were a create (later cleared by
   the delivery write-back) or a single timeout.
4. **A lead stuck at "Update Pending" (Indooroopilly).** Not a middleware fault: MG staff set
   "PMA Unassigned" then "Update Pending" by hand in Zoho after delivery. The middleware treats
   "Update Pending" as an MG-only status and keeps it.
5. **Unhappy 4 "another update already in progress".** One save in Fusion posted two webhooks in the same
   second; the second lost the per-lead lock and was parked. Without `INBOUND_EVENT_STORE` there was no
   stored body to replay, so that status change was lost.
6. **Enquiry Outcome never set for Lost.** Fusion "Lost" set the status and lost reason only.
7. **Leads Exchange Activity gaps.** Fields were empty on leads delivered before the code that fills them
   existed (6 Nov), and `Dealer CRM ID` / `Middleware ID` were never written by any code before today.

---

## 5. Code changes (commit `a7d153c`, on `main`, deployed to the trial project)

All in `functions/mg_motors_au_function/services/integrations/crmIntegrationService.js`, with tests.

1. **Dealer CRM ID and Middleware ID written to MG Zoho on delivery.** At first delivery (and when an
   admin links an unresolved lead) the lead gets `Dealer_CRM_ID` (the dealer's lead id) and
   `Middleware_ID` (our `leads` row id). Written in a separate best-effort call so a rejected write
   never affects delivery or the "Lead Exchanged" write-back.
2. **Fusion webhook lock-wait.** A Fusion SD webhook that finds the lead's lock busy now waits and retries
   (700 / 1200 / 1500 ms, about 3.4 s) like Dealer Studio, instead of being parked. A lock that never
   frees still ends as a held webhook, as before.
3. **Fusion "Lost" sets Enquiry Outcome = "Lost".** Only when the lead really moves to Lost Lead, never
   over an order outcome (Purchase, Fleet, On-Sold), and not for a lead already Lost or an echo.
   Consequences worth knowing: (a) MG's outbound rule sends a Lost outcome to Fusion as "Lost", so
   reopening a Lost lead in Zoho by changing only the status sends nothing to Fusion; the outcome must be
   cleared too; (b) a later Fusion "Won" no longer replaces a Lost outcome. Both are covered by tests.

Tests: backend suite is **1,294 of 1,294**; frontend build succeeds; ESLint 0 errors. About 20
expectations were updated and new tests added for the lock-wait, the failed ID write and the
Lost-outcome behaviour.

### Deploy
- `catalyst deploy --only functions` to the **trial** project: successful. A post-deploy check confirmed
  the new event store is live.
- Function env variables come from the **git-ignored** `functions/mg_motors_au_function/catalyst-config.json`
  (`deployment.env_variables`). A deploy applies that file, so a variable added only in the console can be
  overwritten. Two variables were added there: `ESCALATION_TRANSIENT_ONLY=true` and
  `INBOUND_EVENT_STORE=true` (39 variables now).
- Do not use the MCP "Update/Create Environment Variable" tools to add one variable: they **replace the
  whole list**.

---

## 6. Live data fixes made in the MG Zoho CRM (trial flow)

All were done through the middleware's own Zoho service, with read-back verification.

| Change | Leads | Result |
|---|---|---|
| Reset "Dealer Unavailable" to "Not Contacted" | 3 | done (dealer IDs preserved, nothing resent) |
| `Connected_CRM`, `Dealer_CRM_ID`, `Middleware_ID` | 138 pushed Fusion leads (includes the new test lead; 3 deleted test leads excluded) | done |
| `Enquiry_Outcome` = Lost on existing Lost leads | 12 | done; 1 skipped (already Retail Order), 3 skipped (deleted in Zoho) |
| `Lead_Exchanged` ticked | 80 | done, all 138 now ticked |
| `First_Action_Date`, `Closed Date` | 7 and 5 | done, from the dealer-update dates in the logs |

Still not filled: 2 leads without a First Action Date (no dealer-update record exists), the 3 leads
deleted from Zoho, the 4 never-delivered AU001/AU013 leads, and about 250 delivered **Dealer Studio / AU008**
leads (not part of the Fusion scope).

Deliverable: `Fusion_SD_32_Leads.xlsx` in `C:\Users\surya\OneDrive\Desktop\catalyst\` (the 32 leads pushed
to the four dealers since 1 Nov; contains customer names, kept out of git).

---

## 6a. Checks and monitoring after the fixes (17 Nov)

- **The 32 leads pushed 1-6 Nov (Fusion).** All 32 are SYNCED with 0 retries and no error, and each has its
  dealer record ID; no failed entries on their logs. Nine of them (6 at Hillcrest, 3 at Indooroopilly) had
  later MG edits refused by Fusion with **403 "dealer updates disabled"** (13 refused attempts): those
  dealers must switch lead updates on for MG. No dealer status update has come back for any of the 32
  (31 are still "Not Contacted"; one is "Update Pending", set by MG staff).
- **Activity log, four Fusion dealers, last 24 hours.** Tynan: 12 inbound entries, all expired (6
  dealer-created leads with no MG enquiry, logged twice). Buckby: 4 outbound updates accepted (HTTP 200)
  plus 2 expired inbound entries. Hillcrest and Indooroopilly: 2 refused (403) each. Nothing newly pushed and
  no inbound change applied. All-time log rows: Tynan 154, Hillcrest 123, Indooroopilly 114, Buckby 111.
- **Older entries still open:** Tynan received the status "pendingLost" (lead `…61053150`, 14 Nov), which has
  no MG mapping (held as Unhappy 4); two leads were never delivered because the customer email is empty
  (`…61221830` Indooroopilly, `…61219568` Buckby).
- **Latest sync log (11:04 IST).** Incremental cron run: 103 records fetched, 5 inserted (Unhappy 5: the
  postcode resolved to no dealer), 3 updated (Happy 5), 0 failed, status "Partial" because the run had two
  outcomes, not because of errors.
- **Monitor.** A read-only job (id `3de98665`, session-only, expires after 7 days) checks every 15 minutes
  for any Fusion update on the 32 leads and reports only new ones. As of about 12:05 IST it had found
  nothing new for the 32.
- **Dealer Studio location id.** It is stored per dealer in `dealer_integrations.dealership_location_id`
  (set on the Dealer CRM Config screen) and sent as `location_id` with every lead. Five of the six Dealer
  Studio dealers have one (421501: 1231, 302901: 1989, 315602: 4878, 275002: 1095, 215402: 6033); the MG
  test dealer 654321 (slug `mg-test`) has none. MG's Zoho `Dealers` module has no such field, so the dealer
  sync cannot fill it, and the main `dealers` table has no column for it.

---

## 7. Still to do: move the project to the MG (AU) account

**Before anything else**
- [ ] `catalyst login` with the AU account, then repoint `.catalystrc` at project `818000000022001`
  (org `7007717417`). Keep a backup of the current file.
- [ ] Decide: wipe-and-reload vs merge for the existing AU rows (section 2).
- [ ] Pause crons and webhooks on the **trial** project during cutover so leads are not synced twice.

**Data**
- [ ] Copy in dependency order: dealers → dealer_integrations / integration_credentials / mappings →
  leads → lead_integrations → logs. `ROWID`s change on insert, so every column that points at another
  table by `ROWID` (for example `lead_integrations.integration_id`) must be rewritten.
- [ ] `sync_logs` (about 44k rows) should use bulk read/write jobs; ask whether full history is needed.
- [ ] `integration_credentials` are encrypted with `INTEGRATION_CREDENTIALS_KEY`. Either the AU function
  uses the **same key**, or the credentials are re-saved in the AU admin screen.
- [ ] `admin_user_mapping` / `dealer_user_mapping` reference Catalyst user ids that differ per project:
  users must be invited again and the mappings remapped.
- [ ] `webhook_channels` hold Zoho watch channels tied to the old URL: re-register, do not copy.

**Code and config for AU**
- [ ] Set `PUBLIC_FUNCTION_BASE_URL` to the AU function URL. The code falls back to the old `.in` address
  in `services/zohoWebhookService.js` (about lines 31 and 121) and a portal link in
  `services/integrations/emailTemplates.js:52`: update these defaults.
- [ ] Catalyst role ids are hard-coded in **both**
  `functions/mg_motors_au_function/constants/roles.constants.js` and
  `mg-motor-web/src/constants/auth.constants.js`; they differ in the AU project and both files must be
  updated together.
- [ ] Recreate the Catalyst Scheduler jobs for the `/cron/*` endpoints (see `CLAUDE.md`), each sending
  `X-Cron-Secret`.
- [ ] Re-register Zoho CRM notifications (`/webhooks/crm-notify`) and dealer webhooks to the new URL.
- [ ] Give every Fusion dealer the new webhook URL, the signing method and each `dealer_id`; make sure
  each dealer's secret exists in the AU credentials.
- [ ] Carry across `ESCALATION_TRANSIENT_ONLY=true` and `INBOUND_EVENT_STORE=true`.
- [ ] Deploy the frontend (`catalyst deploy --only client`) with the AU environment values.

**Security**
- [ ] The function's environment variables (Zoho client secret and refresh token, SMTP password,
  `CRON_SECRET`, Fusion keys and webhook secret, `INTEGRATION_CREDENTIALS_KEY`, other API keys) were
  printed in full in this session's transcript by an MCP function listing. Rotate them. Rotating
  `INTEGRATION_CREDENTIALS_KEY` means re-saving all stored dealer credentials, so plan it with the AU
  cutover.

---

## 8. Practical notes (gotchas met today)

- Backend tests: run `node --test test/*.test.js` from a shell. The `npm test` glob does not expand on
  Windows. `crmApiQueueFullRetryable` / "request beyond the maximum queue depth" is a known flaky test.
- A bad MG Zoho field name never breaks delivery any more (the ID write is best-effort), but check a new
  field's API name against the live Leads module before relying on it.
- Writing a field that is part of the lead fingerprint (status, outcome) makes the middleware send an
  update to Fusion; writing `Lead_Exchanged`, `Connected_CRM`, the IDs or the activity dates does not.
- Pasting multi-line PowerShell into a terminal can join the lines: use `;`-separated one-liners.
- MG staff changing a lead's status by hand in Zoho is respected by the middleware ("Update Pending",
  "PMA Unassigned" are MG-only statuses).
- `UNHAPPY_7_RETENTION_MINUTES` is 5 and `UNHAPPY_3_ESCALATION_WINDOW_MINUTES` is 2 on the function: both
  look like test values and make held events expire and failures escalate very quickly. Review before go-live.
- Time columns differ by table: `webhook_events.received_at` and `lead_integrations.last_synced_at` are UTC,
  while `integration_logs`, `leads` and `sync_logs` `CREATEDTIME` show IST (UTC+5:30). Convert before
  comparing; Git Bash's `date` ignores `TZ`, so add 19,800 seconds to UTC by hand.
- When writing IDs to MG Zoho in bulk, validate the format first (Zoho lead ids are 17 digits). One run used
  ids with a dropped zero; Zoho rejected all of them as invalid and wrote nothing, but it was avoidable.
