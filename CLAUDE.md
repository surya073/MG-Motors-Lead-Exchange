# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MG Motor AU Lead Exchange — a Zoho Catalyst project that syncs sales leads bidirectionally
between MG's OEM Zoho CRM and dealer CRMs (currently AU008, a Zoho org). It is a two-project
monorepo glued together by `catalyst.json`:

- `functions/mg_motors_au_function` — an Express app deployed as a single Catalyst "advancedio"
  serverless function (`node20`). All backend logic lives here.
- `mg-motor-web` — a Create React App (CRA) admin/dealer portal, deployed as a Catalyst client
  via `zcatalyst-cli-plugin-react`.

There is no root `package.json`; each project has its own and is developed independently.

## Commands

Backend (`functions/mg_motors_au_function`):
```bash
npm install
npm test                              # node --test test/*.test.js
node --test test/pathPolicyService.test.js   # run a single test file
```

Frontend (`mg-motor-web`):
```bash
npm install
npm start                             # react-scripts dev server
npm run build                         # react-scripts build
npm test                              # react-scripts test (CRA/Jest)
```

Full local build check used before a demo/deploy (see `LEAD_EXCHANGE_DEMO_RUNBOOK.md`):
```bash
cd functions/mg_motors_au_function && npm test
cd ../../mg-motor-web && npm run build
```

Deploy is via the Zoho Catalyst CLI (`catalyst` — installed globally, config in `.catalystrc` /
`catalyst.json`), not scripted in this repo. There is no lint command configured for the backend;
the frontend uses CRA's built-in `eslintConfig` (`react-app`, `react-app/jest`).

## Architecture

### Backend: one Express app, mounted as Catalyst function routes

`functions/mg_motors_au_function/index.js` builds the Express `app` and mounts route modules
under `/`. Route mounting order matters:

1. `webhookRoutes` (inbound dealer/Zoho webhooks) and `cronRoutes` are mounted **before** the
   global auth middleware, because callers there are Zoho/Catalyst schedulers or external
   dealers authenticating via `X-Cron-Secret` / webhook signatures, not logged-in Catalyst users.
2. A global middleware then calls `catalyst.initialize(req)` +
   `userManagement().getCurrentUser()` and stores `res.locals.catalystApp` /
   `res.locals.currentUser`, 401'ing anything without a session. Everything mounted after this
   (dealer/admin/lead/dashboard routes) can assume both are set.
3. Legacy inline `/dealers` and `/leads` CRUD lives directly in `index.js` (pre-dates the
   route-module split); newer functionality is added as its own file under `routes/` +
   `services/`.

Role checks (`middleware/requireAdminRole.js`, `requireSuperAdminRole.js`) compare
`currentUser.role_details.role_id` against hardcoded Catalyst role IDs. **These role IDs and the
`APP_ROLES` mapping are duplicated by hand** in `functions/mg_motors_au_function/constants/roles.constants.js`
(backend) and `mg-motor-web/src/constants/auth.constants.js` (frontend) — they are two separate
deployables with no shared code, so a role added/changed in the Catalyst console must be updated
in both files or role-based access/notifications silently break.

Environment variables are the only backend config surface — always add new ones through
`config/env.js` (`getZohoConfig`, `getIntegrationCredentialsKey`) rather than reading
`process.env` ad hoc elsewhere, and document them in `catalyst-config.json` /
`LEAD_EXCHANGE_DEMO_RUNBOOK.md`'s "Production configuration checklist".

### CRM adapter pattern

`services/integrations/crmAdapterFactory.js` resolves `crm_type` → adapter module. Every adapter
implements `createLead`, `updateLead`, `getLead`, `testConnection`. V1 only has
`services/integrations/adapters/genericRestAdapter.js`, used for both `GENERIC_REST` and
`ZOHO_CRM` dealer types. Add a new CRM by dropping a new file under `adapters/` and registering
it in the `ADAPTERS` map — no changes needed to `crmIntegrationService.js`.

### Lead exchange sync engine (`services/integrations/`)

This is the core of the product: a 15-scenario "Happy 1–5 / Unhappy 1–10" protocol (see
`LEAD_EXCHANGE_DEMO_RUNBOOK.md` for the full demo matrix and `VERIFIED-CRM-FACTS.md` for
ground-truth facts pulled live from both CRMs — field names, status picklists, and known data
bugs). Key pieces:

- `crmIntegrationService.js` — orchestrates outbound sync (MG lead → dealer) and classifies
  results into `lead_integrations` states: `PENDING`, `FAILED`, `FAILED_CRITICAL`, `SYNCED`,
  `HELD`, `CONSENT_HOLD`, `SLA_BREACH`.
- `leadSyncService.js` — inbound sync (dealer → MG) field ownership and status mapping.
- `pathPolicyService.js` — classifies a lead event into one of the Happy/Unhappy scenario codes;
  `statusComponents()` matches dealer status strings by whole value, `/`-separated parts, and
  parenthetical-stripped parts, since dealer statuses are compound (e.g. `Follow-up 1 / In progress`).
- `leadFingerprintService.js` — computes a canonical fingerprint of business-relevant lead state,
  used both for outbound/inbound echo-loop prevention and for retry idempotency. Do not compare
  raw payload hashes between outbound and inbound directions — they are structurally different
  shapes and will never match (this was a real bug: see "echo loop" in `VERIFIED-CRM-FACTS.md`).
- `outboundRetryScheduler.js` / `inboundReplayScheduler.js` — cron-driven retry/replay sweeps for
  failed outbound deliveries and held inbound events respectively.
- `slaMonitorService.js` — flags leads stuck without a dealer status change within
  `DEALER_ACTION_SLA_MINUTES` for `DEALER_ACTION_SLA_DEALERS`.
- `dealerReconciliationService.js` — periodic full reconciliation pass against dealer CRMs to
  catch missed webhook events; throttled by `RECONCILE_EVERY_MINUTES` (floor 60 min — it's one
  CRM API call per dealer record, so running it too often burns API quota).
- `integrationAlertService.js` / `dailyErrorReportService.js` / `emailTemplates.js` /
  `alertContext.js` — email alerting. `alertContext.runInBackground(next)` marks a request as a
  background cron sweep so alerts raised during it are logged but not emailed immediately (only
  the daily digest and the explicit `/cron/test-alert` route send mail outside that pattern).
- `webhookVerificationService.js` / `integrationAuthService.js` — inbound webhook signature
  verification and encrypted-at-rest dealer credential storage (`INTEGRATION_CREDENTIALS_KEY`).
- `pathPolicyService`, `leadFingerprintService`, and the mapping logic in `leadSyncService.js`
  are the parts most worth reading before changing sync behavior — most historical bugs in this
  system were subtle mismatches here (raw vs. mapped status values, wrong field names, hash
  comparisons across incompatible shapes).

When touching anything under `services/integrations/`, cross-check field/status assumptions
against `VERIFIED-CRM-FACTS.md` rather than trusting variable/field names in older code — several
previously "obvious" field names (`Customer_Name`, `Dealer_Remarks`, `Assigned_Date`,
`Last_Status_Update`) don't actually exist on MG's Zoho Leads module.

### Cron endpoints (`routes/cronRoutes.js`)

All cron routes are authenticated via a shared `X-Cron-Secret` header checked against the
`CRON_SECRET` env var (not user auth — Catalyst Scheduler calls these with no session). Routes:

| Endpoint | Purpose |
|---|---|
| `POST /cron/retry-outbound-syncs` | paced outbound retry sweep (Unhappy 1/3, Happy 4) |
| `POST /cron/fast-recover` | frequent (every couple minutes) unthrottled recovery: outbound retry + inbound replay + SLA check + throttled reconciliation, all in one pass |
| `POST /cron/replay-inbound-events` | replays held inbound events (Unhappy 4/7/9) |
| `POST /cron/check-lead-sla` | SLA sweep (Unhappy 10) |
| `POST /cron/reconcile-dealer-leads` | daily full reconciliation (Unhappy 11) |
| `POST /cron/daily-error-report` | daily error digest email |
| `POST /cron/renew-webhook` / `/cron/renew-dealer-webhooks` | renew Zoho watch channels (~23hr expiry) |
| `POST /cron/test-alert` | sends one test alert to prove SMTP config end-to-end |

`/cron/fast-recover` intentionally duplicates work also done by the slower dedicated cron
endpoints — it is meant to run *alongside*, not instead of, the paced sweeps.

### Frontend structure (`mg-motor-web/src`)

- `routes/AppRoutes.jsx` — single `createHashRouter` tree. Route access is gated per-branch via
  `<RequireRole allowedRoles={[...]}>` wrapping child routes (`APP_ROLES.SUPER_ADMIN`, `ADMIN`,
  `DEALER`), and `<ProtectedRoute>` for auth generally. Check this file to see which roles can
  reach which page before adding a new route.
- `services/api/axiosInstance.js` — shared axios client. Every request fetches a fresh short-lived
  Catalyst auth token via `authService.generateAuthToken()` and attaches it as `Authorization`
  (Catalyst Advanced I/O functions need this explicitly; the session cookie alone isn't enough
  server-side). A 401 response emits `AUTH_EVENTS.SESSION_EXPIRED` via `authEvents.js` rather than
  redirecting directly — listen for that event instead of handling 401s ad hoc in components.
  Note: this file currently has `[AUTH-DEBUG]` `console.log` statements marked `TEMP DEBUG` around
  an auth loop investigation — check whether they're still needed before adding new ones.
- `services/api/*.js` — one file per backend route group (`dealerCrmIntegrationService`,
  `dealerInviteService`, `syncService`, `adminDashboardService`, etc.), mirroring the backend's
  `routes/` split.
- `config/env.js` — the only place that should read `process.env.REACT_APP_*`; CRA only exposes
  vars with that prefix.
- `constants/auth.constants.js` — frontend half of the role-ID mapping described above; must stay
  in sync with the backend's `roles.constants.js`.
- `ui/` — shared presentational components (Table, Modal, Dropdown, Badge, Skeleton, etc.);
  `common/` — small shared page-level pieces (EmptyState, LoadingPage); `pages/` — one folder per
  route, each with its own co-located `.css`.

## Known sharp edges

- `functions/mg_motors_au_function/catalyst-config.json` currently has real credentials
  (Zoho client secret/refresh token, SMTP password, cron secret) committed in plaintext. Treat
  any value in that file as already-compromised/rotatable, not as a template to copy secrets into
  going forward — new secrets should go through Catalyst Console env vars, not this file.
- Table/field IDs in `index.js` (e.g. `DEALERS_TABLE_ID`, `LEADS_TABLE_ID`) are hardcoded numeric
  Catalyst datastore IDs specific to this project's environment.
