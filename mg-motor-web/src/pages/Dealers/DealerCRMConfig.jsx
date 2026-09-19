import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plug,
  ShieldCheck,
  ArrowLeftRight,
  ListChecks,
  ScrollText,
  RefreshCw,
  Loader2,
  Lock,
  CheckCircle2,
  ChevronDown,
  AlertTriangle,
  XCircle,
  Clock,
  Hash,
  Globe,
  X,
} from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { dealerCrmIntegrationService } from "../../services/api/dealerCrmIntegrationService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import Skeleton from "../../ui/Skeleton/Skeleton";
import { useAlerts } from "../../ui/Alerts/Alerts";
import mgLogo from "../../assets/images/mg-logo-single.png";
import "./DealerCRMConfig.css";
import "../../ui/Skeleton/Skeleton.css";

/**
 * DealerCRMConfig.jsx
 * -----------------------------------------------------------------------
 * Admin-only. Dealers are NEVER created here — this page only lets an
 * Admin pick an EXISTING dealer (synced from Zoho CRM, same source as
 * DealerListPage) and configure how that dealer's leads flow: through
 * our Catalyst Portal (existing behaviour, default) or out to the
 * dealer's own External CRM via a generic REST adapter.
 *
 * Two-pane layout:
 *   left  — searchable, paginated list of synced dealers as collapsible
 *           cards (name + code always visible, chevron reveals
 *           connection status + region)
 *   right — the selected dealer's integration config, as a guided
 *           sequence: connect -> map fields/status -> monitor activity.
 *           Field/Status Mapping only unlock once the connection has
 *           been verified with "Test Connection" — mapping fields for a
 *           CRM we haven't confirmed we can reach isn't useful, and
 *           gating it avoids admins configuring mappings against a typo'd
 *           endpoint. Logs is always open — an admin should be able to
 *           see history/errors regardless of current connection state.
 *
 * Credentials UX: once a credential is saved, we never re-display the
 * real value. The field renders as masked dots and disabled; an
 * "Edit credentials" action unlocks fresh input fields. This applies to
 * both the Zoho OAuth trio (Client ID / Client Secret / Refresh Token)
 * and the single generic-REST credential field.
 *
 * ?dealerCode= in the URL deep-links directly to a dealer's config.
 *
 * SAVE ACTIONS ARE SPLIT ON PURPOSE (handleSaveConnection vs
 * handleSaveMappings) — they used to be one combined handleSave that
 * always PUT the full connection config (including credentials) before
 * ever touching mappings. The backend's PUT /integration route demotes
 * status from CONNECTED back to CONFIGURING on every save (so admins
 * re-verify after a connection-affecting edit) — but that demotion was
 * firing even when the admin only clicked "Save Field Mapping" or "Save
 * Status Mapping", since handleSave always hit the connection endpoint
 * first. loadIntegration() would then pull the demoted status back in,
 * mappingsLocked would flip true, and whichever mapping tab the admin
 * was on would immediately show its own "test the connection first"
 * locked state right after saving — so mappings could never accumulate
 * past the first save. Splitting these means a mapping save only ever
 * calls saveMappings(), and never touches connection status.
 *
 * ACTIVITY LOG SCENARIO CLASSIFICATION
 * -----------------------------------------------------------------------
 * Each row in integration_logs (written by crmIntegrationService.js) is
 * ONE lead-level push/pull attempt, not an aggregate batch — so unlike
 * the sync-logs scenario matrix, this classifies per-row using the
 * ACTUAL err.code strings the backend writes into error_message, not a
 * keyword guess:
 *
 *   - ZOHO_TO_EXTERNAL_CRM + CREATE_LEAD/UPDATE_LEAD + SUCCESS -> Happy 1
 *   - EXTERNAL_CRM_TO_ZOHO + UPDATE_LEAD + SUCCESS             -> Happy 2
 *   - error_message === FIELD_MAPPING_INVALID
 *       or STATUS_MAPPING_NOT_FOUND                            -> Unhappy 2
 *   - EXTERNAL_CRM_TO_ZOHO + FAILED (any other reason)         -> Unhappy 4
 *       (the OEM-write-back is the only thing that can fail and get
 *       logged on this branch, per processInboundWebhook's try/catch)
 *   - ZOHO_TO_EXTERNAL_CRM + FAILED (anything else — timeouts,
 *       5xx, 401/403, etc.)                                    -> Unhappy 1
 *   - TEST_CONNECTION                                          -> not a
 *       lead scenario; shown as a plain Connection Test badge.
 *
 * KNOWN GAP: processInboundWebhook throws LEAD_MAPPING_NOT_FOUND and an
 * early FIELD_MAPPING_INVALID (missing external lead id / no mapped
 * fields) BEFORE it calls writeLog — those never produce a row here at
 * all. LEAD_MAPPING_NOT_FOUND in particular is the client's Unhappy 7
 * (out-of-order event) and currently can't be shown by this table no
 * matter how it's classified, since the backend never logs it.
 */

const AUTH_TYPES = [
  { value: "API_KEY", label: "API Key" },
  { value: "BEARER_TOKEN", label: "Bearer Token" },
  { value: "BASIC_AUTH", label: "Basic Auth" },
  { value: "OAUTH2", label: "OAuth 2.0" },
  { value: "CUSTOM_HEADER", label: "Custom Header" },
];

const HTTP_METHODS = [
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
];

const OUR_FIELDS = [
  "dealer_code",
  "customer_name",
  "mobile_number",
  "email_address",
  "vehicle_model",
  "lead_source",
  "lead_status",
  "assigned_date",
  "last_status_update",
  "dealer_remarks",
  "crm_record_id",
  "next_followup_date",
  "enquiry_status",
  "nature_of_enquiry",
  "purchase_classification",
  "enquiry_outcome",
  "lead_department",
  "franchise",
  "enquiry_id",
  "customer_message",
  "accept_privacy_policy",
  "receive_marketing_updates",
  "postcode",
  "unit_suite",
  "enquiry_model",
  "enquiry_variant",
  "enquiry_powertrain",
  "chat_transcript",
  "lead_owner_email",
];

// Humanized label only — the stored value stays the exact internal
// field name (source_field), unchanged, since that's what
// leadMappingService.js reads off leadRow[mapping.source_field] at
// sync time.
function humanizeFieldName(field) {
  return field
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const OUR_FIELD_OPTIONS = [
  { value: "", label: "Select field…" },
  ...OUR_FIELDS.map((f) => ({ value: f, label: `${humanizeFieldName(f)} (${f})` })),
];

const INTEGRATION_STATUS_TONES = {
  ACTIVE: "active",
  CONNECTED: "active",
  CONFIGURING: "pending",
  NOT_CONFIGURED: "neutral",
  DISABLED: "neutral",
  ERROR: "danger",
};

const CONNECTED_STATUSES = ["ACTIVE", "CONNECTED"];

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

const MASKED_CREDENTIAL_PLACEHOLDER = "••••••••••••";

const DEFAULT_FIELD_MAPPINGS = [
  { source_field: "customer_name", target_field: "", data_type: "string", required: true },
  { source_field: "mobile_number", target_field: "", data_type: "string", required: false },
  { source_field: "email_address", target_field: "", data_type: "string", required: false },
  { source_field: "vehicle_model", target_field: "", data_type: "string", required: false },
  { source_field: "lead_status", target_field: "", data_type: "string", required: false },
];

const DEFAULT_STATUS_MAPPINGS = [
  { source_status: "New", target_status: "" },
  { source_status: "Contacted", target_status: "" },
  { source_status: "Test Drive", target_status: "" },
  { source_status: "Quotation", target_status: "" },
  { source_status: "Delivered", target_status: "" },
  { source_status: "Lost", target_status: "" },
];

const EMPTY_CONFIG = {
  integration_type: "PORTAL",
  crm_type: "GENERIC_REST",
  crm_name: "",
  base_url: "",
  auth_type: "BEARER_TOKEN",
  create_lead_endpoint: "/api/leads",
  update_lead_endpoint: "/api/leads/{externalLeadId}",
  http_method: "POST",
  update_http_method: "PUT",
  oauth_accounts_domain: "",
  webhook_enabled: true,
  status: "NOT_CONFIGURED",
};

// Only the scenarios actually reachable from what crmIntegrationService.js
// logs today (see the module-comment block above for why the others in
// the client's full matrix can't appear here).
const DEALER_LOG_SCENARIOS = {
  "happy-1": {
    path: "happy",
    number: 1,
    label: "New enquiry routed successfully",
    color: { bg: "var(--scenario-happy-1-bg)", text: "var(--scenario-happy-1-text)" },
  },
  "happy-2": {
    path: "happy",
    number: 2,
    label: "Dealer progresses enquiry (status sync)",
    color: { bg: "var(--scenario-happy-2-bg)", text: "var(--scenario-happy-2-text)" },
  },
  // NEW — backend now distinguishes this from happy-2 (see
  // crmIntegrationService.js's isStatusSync split in processInboundWebhook).
  // Now pointed at the same --scenario-happy-5-* tokens SyncLogsPage.jsx
  // uses, so the same scenario reads as the same color on both pages —
  // previously this used its own one-off hex (#e0f2fe/#0284c7) that
  // didn't match SyncLogsPage's happy-5 (#d1fae5/#059669) at all.
  "happy-5": {
    path: "happy",
    number: 5,
    label: "Data synchronisation (dealer → OEM)",
    color: { bg: "var(--scenario-happy-5-bg)", text: "var(--scenario-happy-5-text)" },
  },
  "unhappy-1": {
    path: "unhappy",
    number: 1,
    label: "API / integration failure",
    color: { bg: "var(--scenario-unhappy-1-bg)", text: "var(--scenario-unhappy-1-text)" },
  },
  "unhappy-2": {
    path: "unhappy",
    number: 2,
    label: "Invalid / missing data",
    color: { bg: "var(--scenario-unhappy-2-bg)", text: "var(--scenario-unhappy-2-text)" },
  },
  "unhappy-4": {
    path: "unhappy",
    number: 4,
    label: "Status update failure (dealer → OEM)",
    color: { bg: "var(--scenario-unhappy-4-bg)", text: "var(--scenario-unhappy-4-text)" },
  },
  // NEW — previously unreachable: LEAD_MAPPING_NOT_FOUND used to throw
  // before writeLog ran, so no row ever carried this scenario. Now that
  // the backend logs it, it needs a badge here too.
  "unhappy-7": {
    path: "unhappy",
    number: 7,
    label: "Out-of-order events",
    color: { bg: "var(--scenario-unhappy-7-bg)", text: "var(--scenario-unhappy-7-text)" },
  },
};

// Configuration/business-rule error codes that leadMappingService.js
// literally throws as err.code — crmIntegrationService.js's catch
// blocks store err.code (when present) verbatim as error_message, so
// these are exact matches, not a keyword guess.
const INVALID_DATA_ERROR_CODES = new Set(["FIELD_MAPPING_INVALID", "STATUS_MAPPING_NOT_FOUND"]);

// Maps the backend's stored "Happy 2" / "Unhappy 7" / "Connection Test"
// string (happy_unhappy_path_name) to the same key shape used by
// DEALER_LOG_SCENARIOS above ("happy-2", "unhappy-7").
function scenarioKeyFromStoredName(name) {
  const match = /^(happy|unhappy)\s+(\d+)$/i.exec((name || "").trim());
  if (!match) return null;
  return `${match[1].toLowerCase()}-${match[2]}`;
}

// Classifies a log row for display. Prefers the columns the backend now
// writes at insert time (happy_unhappy_path_name / _message) — these are
// authoritative since they're derived from the exact err.code the
// backend threw, not guessed from the row after the fact. Falls back to
// re-deriving client-side ONLY for rows written before this migration,
// which won't have those columns populated.
function classifyDealerLog(row) {
  if (row.happy_unhappy_path_name) {
    if (row.happy_unhappy_path_name.startsWith("Connection Test")) {
      return {
        special: true,
        label: row.happy_unhappy_path_name,
        tone: row.happy_unhappy_path_name.endsWith("Failed") ? "danger" : "success",
      };
    }

    const key = scenarioKeyFromStoredName(row.happy_unhappy_path_name);
    const known = key && DEALER_LOG_SCENARIOS[key];
    if (known) {
      // Stored message can differ from the hardcoded label if the
      // backend's wording changes later — prefer it when present.
      return { ...known, label: row.happy_unhappy_path_message || known.label };
    }

    // Stored name doesn't match anything we know how to color/badge yet
    // (e.g. a new scenario added server-side before the frontend catches
    // up) — show it plainly rather than misclassifying it.
    return {
      special: true,
      label: row.happy_unhappy_path_message || row.happy_unhappy_path_name,
      tone: "neutral",
    };
  }

  // Legacy fallback — row predates the happy_unhappy_path_* columns.
  return classifyDealerLogLegacy(row);
}

function classifyDealerLogLegacy(row) {
  if (row.operation === "TEST_CONNECTION") {
    return {
      special: true,
      label: row.status === "SUCCESS" ? "Connection Test" : "Connection Test Failed",
      tone: row.status === "SUCCESS" ? "success" : "danger",
    };
  }

  if (row.status === "SUCCESS") {
    return row.direction === "EXTERNAL_CRM_TO_ZOHO"
      ? DEALER_LOG_SCENARIOS["happy-2"]
      : DEALER_LOG_SCENARIOS["happy-1"];
  }

  if (row.direction === "EXTERNAL_CRM_TO_ZOHO") {
    return DEALER_LOG_SCENARIOS["unhappy-4"];
  }

  const code = (row.error_message || "").trim();
  if (INVALID_DATA_ERROR_CODES.has(code)) {
    return DEALER_LOG_SCENARIOS["unhappy-2"];
  }
  return DEALER_LOG_SCENARIOS["unhappy-1"];
}

function statusBadge(status) {
  const tone = INTEGRATION_STATUS_TONES[status] || "neutral";
  const label = (status || "NOT_CONFIGURED").replace(/_/g, " ");
  return <Badge tone={tone} fixed>{label}</Badge>;
}

// Activity-log rows use a different status vocabulary (SUCCESS / FAILED)
// than the dealer-level integration status above (ACTIVE / CONFIGURING /
// etc.) — these were previously both run through statusBadge(), which
// only knows the integration-status vocabulary, so every log row fell
// through to the "neutral" tone. This gives logs their own green/red.
function logStatusBadge(status) {
  if (status === "SUCCESS") return <Badge tone="active" fixed>Success</Badge>;
  if (status === "FAILED") return <Badge tone="danger" fixed>Failed</Badge>;
  return <Badge tone="neutral" fixed>{status || "—"}</Badge>;
}

// NOTE: adjust the field(s) checked here to whatever your
// adminDashboardService.listDealers() response actually names the
// dealer's live CRM-connection state. It falls through a few likely
// field names so the badges work as soon as that's confirmed.
function isDealerConnected(dealer) {
  const rawStatus = dealer.integration_status || dealer.crm_status || dealer.status;
  return CONNECTED_STATUSES.includes(rawStatus);
}

function paginate(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function PaginationBar({ page, pageSize, total, onPageChange, onPageSizeChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(total, page * pageSize);

  return (
    <div className="dealer-crm-config__pagination">
      <span className="dealer-crm-config__pagination-info">
        {total === 0 ? "0 results" : `${startItem}–${endItem} of ${total}`}
      </span>
      <div className="dealer-crm-config__pagination-controls">
        <label>
          Show
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="dealer-crm-config__pagination-buttons">
          <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
            ‹
          </button>
          <span>
            {page} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

function LogDetailOffcanvas({ row, onClose }) {
  if (!row) return null;
  const scenario = classifyDealerLog(row);

  return (
    <div className="dealer-crm-config__offcanvas-overlay" onClick={onClose}>
      <div className="dealer-crm-config__offcanvas" onClick={(e) => e.stopPropagation()}>
        <div className="dealer-crm-config__offcanvas-header">
          <h4>Activity Detail</h4>
          <button type="button" onClick={onClose} aria-label="Close details">
            <X size={18} />
          </button>
        </div>

        <div className="dealer-crm-config__offcanvas-body">
          <div className="dealer-crm-config__offcanvas-scenario">
            {scenario.special ? (
              <Badge tone={scenario.tone} fixed>
                {scenario.label}
              </Badge>
            ) : (
              <>
                <span
                  className="dealer-crm-config__scenario-badge"
                  style={{ backgroundColor: scenario.color.bg, color: scenario.color.text }}
                >
                  {scenario.path === "happy" ? "Happy" : "Unhappy"} {scenario.number}
                </span>
                <p className="dealer-crm-config__offcanvas-scenario-label">{scenario.label}</p>
              </>
            )}
          </div>

          <div className="dealer-crm-config__offcanvas-row">
            <Clock size={14} />
            <span>Time</span>
            <strong>{row.created_at || "—"}</strong>
          </div>
          <div className="dealer-crm-config__offcanvas-row">
            <ArrowLeftRight size={14} />
            <span>Direction</span>
            <strong>{row.direction || "—"}</strong>
          </div>
          <div className="dealer-crm-config__offcanvas-row">
            <Hash size={14} />
            <span>Operation</span>
            <strong>{row.operation || "—"}</strong>
          </div>
          <div className="dealer-crm-config__offcanvas-row">
            <Hash size={14} />
            <span>Zoho Lead</span>
            <strong>{row.zoho_lead_id || "—"}</strong>
          </div>
          <div className="dealer-crm-config__offcanvas-row">
            <Globe size={14} />
            <span>External Lead</span>
            <strong>{row.external_lead_id || "—"}</strong>
          </div>
          <div className="dealer-crm-config__offcanvas-row">
            {row.status === "SUCCESS" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <span>Status</span>
            <strong>{row.status || "—"}</strong>
          </div>
          <div className="dealer-crm-config__offcanvas-row">
            <Hash size={14} />
            <span>HTTP Status</span>
            <strong>{row.http_status || "—"}</strong>
          </div>

          {row.status === "FAILED" && (
            <div className="dealer-crm-config__offcanvas-error">
              <AlertTriangle size={14} />
              <span>{row.error_message || "Unknown error"}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DealerCRMConfig() {
  const { showAlert } = useAlerts();
  const [searchParams, setSearchParams] = useSearchParams();

  const [dealers, setDealers] = useState([]);
  const [dealersLoading, setDealersLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [selectedDealer, setSelectedDealer] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const saveSuccessTimeoutRef = useRef(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [tab, setTab] = useState("connection"); // connection | fields | status | logs

  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [credentialValue, setCredentialValue] = useState("");
  const [hasStoredCredential, setHasStoredCredential] = useState(false);

  // Controls whether the credential inputs are shown editable or as
  // masked/disabled dots. False whenever a credential is already stored
  // and the admin hasn't explicitly asked to change it.
  const [editingCredentials, setEditingCredentials] = useState(false);

  const [fieldMappings, setFieldMappings] = useState(DEFAULT_FIELD_MAPPINGS);
  const [statusMappings, setStatusMappings] = useState(DEFAULT_STATUS_MAPPINGS);

  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [activeLogDetail, setActiveLogDetail] = useState(null);

  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthRefreshToken, setOauthRefreshToken] = useState("");

  // ---- left panel: collapse + pagination state ----
  const [expandedDealers, setExpandedDealers] = useState(() => new Set());
  const [dealerPage, setDealerPage] = useState(1);
  const [dealerPageSize, setDealerPageSize] = useState(10);

  // ---- activity log pagination state ----
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(10);

  useEffect(() => {
    (async () => {
      setDealersLoading(true);
      try {
        const result = await adminDashboardService.listDealers();
        setDealers(result.filter((d) => d.sync_status !== "Removed"));

        const deepLinkCode = searchParams.get("dealerCode");
        if (deepLinkCode) {
          const match = result.find((d) => d.dealer_code === deepLinkCode);
          if (match) setSelectedDealer(match);
        }
      } catch (err) {
        showAlert("error", err?.response?.data?.error || "Couldn't load dealers. Try again.", {
          title: "Load failed",
        });
      } finally {
        setDealersLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  useEffect(() => () => window.clearTimeout(saveSuccessTimeoutRef.current), []);

  const filteredDealers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return dealers;
    return dealers.filter((d) =>
      [d.dealer_name, d.dealer_code, d.email_address, d.region].filter(Boolean).some((f) => f.toLowerCase().includes(term))
    );
  }, [dealers, search]);

  // Reset to page 1 whenever the visible dealer set changes shape.
  useEffect(() => {
    setDealerPage(1);
  }, [search]);

  const paginatedDealers = useMemo(
    () => paginate(filteredDealers, dealerPage, dealerPageSize),
    [filteredDealers, dealerPage, dealerPageSize]
  );

  // Reset to page 1 whenever a fresh batch of logs comes in (new dealer,
  // reload after retry, etc.) so the pager never gets stranded past the end.
  useEffect(() => {
    setLogsPage(1);
  }, [logs]);

  const paginatedLogs = useMemo(() => paginate(logs, logsPage, logsPageSize), [logs, logsPage, logsPageSize]);

  const toggleDealerExpand = (code) => {
    setExpandedDealers((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const clearSaveSuccessSoon = () => {
    window.clearTimeout(saveSuccessTimeoutRef.current);
    saveSuccessTimeoutRef.current = window.setTimeout(() => setSaveSuccess(false), 4000);
  };

  const resetCredentialInputs = () => {
    setCredentialValue("");
    setOauthClientId("");
    setOauthClientSecret("");
    setOauthRefreshToken("");
    setEditingCredentials(false);
  };

  const loadIntegration = async (dealer) => {
    setConfigLoading(true);
    setTestResult(null);
    setSaveSuccess(false);
    setTab("connection");
    try {
      const result = await dealerCrmIntegrationService.getIntegration(dealer.dealer_code);
      setConfig({ ...EMPTY_CONFIG, ...(result?.integration || {}) });
      setHasStoredCredential(Boolean(result?.hasCredential));
      resetCredentialInputs();

      const mappingsResult = await dealerCrmIntegrationService.getMappings(dealer.dealer_code);
      setFieldMappings(
        mappingsResult?.fieldMappings?.length ? mappingsResult.fieldMappings : DEFAULT_FIELD_MAPPINGS
      );
      setStatusMappings(
        mappingsResult?.statusMappings?.length ? mappingsResult.statusMappings : DEFAULT_STATUS_MAPPINGS
      );
    } catch (err) {
      if (err?.response?.status === 404) {
        // No integration configured yet for this dealer — start fresh.
        setConfig(EMPTY_CONFIG);
        setHasStoredCredential(false);
        resetCredentialInputs();
        setFieldMappings(DEFAULT_FIELD_MAPPINGS);
        setStatusMappings(DEFAULT_STATUS_MAPPINGS);
      } else {
        showAlert("error", err?.response?.data?.error || "Couldn't load integration config.", {
          title: "Load failed",
        });
      }
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSelectDealer = (dealer) => {
    setSelectedDealer(dealer);
    setSearchParams({ dealerCode: dealer.dealer_code });
    loadIntegration(dealer);
  };

  const handleConfigChange = (key, value) => {
    setSaveSuccess(false);
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleFieldMappingChange = (index, key, value) => {
    setSaveSuccess(false);
    setFieldMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  };

  const addFieldMapping = () => {
    setSaveSuccess(false);
    setFieldMappings((prev) => [...prev, { source_field: "", target_field: "", data_type: "string", required: false }]);
  };

  const removeFieldMapping = (index) => {
    setSaveSuccess(false);
    setFieldMappings((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStatusMappingChange = (index, key, value) => {
    setSaveSuccess(false);
    setStatusMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  };

  // NEW — status mapping previously had no way to grow past the six
  // DEFAULT_STATUS_MAPPINGS rows, and source_status rendered as a
  // read-only <span> in the JSX below (now an editable input), so a new
  // status pair had nowhere to go. Mirrors addFieldMapping/removeFieldMapping.
  const addStatusMapping = () => {
    setSaveSuccess(false);
    setStatusMappings((prev) => [...prev, { source_status: "", target_status: "" }]);
  };

  const removeStatusMapping = (index) => {
    setSaveSuccess(false);
    setStatusMappings((prev) => prev.filter((_, i) => i !== index));
  };

  // ---- Connection tab save ----
  // Only ever touches /integration (config + credentials). Never call
  // this from a mapping-tab button — see the file-level note above on
  // why that combination was silently re-locking the mapping tabs.
  const handleSaveConnection = async () => {
    if (!selectedDealer) return;
    setSaving(true);
    try {
      await dealerCrmIntegrationService.saveIntegration(selectedDealer.dealer_code, {
        ...config,
        credential: credentialValue || undefined,
        oauth_client_id: oauthClientId || undefined,
        oauth_client_secret: oauthClientSecret || undefined,
        oauth_refresh_token: oauthRefreshToken || undefined,
      });

      showAlert("success", `Saved connection settings for ${selectedDealer.dealer_name}.`, {
        title: "Configuration saved",
      });
      setSaveSuccess(true);
      clearSaveSuccessSoon();
      // Any credential just entered is now persisted server-side —
      // collapse back to the masked/disabled view.
      resetCredentialInputs();
      await loadIntegration(selectedDealer);
      // loadIntegration() resets saveSuccess to false — re-assert the
      // confirmation state for this save action specifically.
      setSaveSuccess(true);
      clearSaveSuccessSoon();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Couldn't save the configuration. Try again.", {
        title: "Save failed",
      });
    } finally {
      setSaving(false);
    }
  };

  // ---- Field/Status mapping tab save ----
  // Only ever touches /integration/mappings — never the connection
  // endpoint, so it can't demote the integration's status and re-lock
  // these tabs on itself. Re-fetches only the mappings afterward, not
  // the whole integration, for the same reason.
  const handleSaveMappings = async () => {
    if (!selectedDealer) return;
    setSaving(true);
    try {
      await dealerCrmIntegrationService.saveMappings(selectedDealer.dealer_code, {
        fieldMappings,
        statusMappings,
      });

      showAlert("success", `Saved mapping settings for ${selectedDealer.dealer_name}.`, {
        title: "Mappings saved",
      });
      setSaveSuccess(true);
      clearSaveSuccessSoon();

      const mappingsResult = await dealerCrmIntegrationService.getMappings(selectedDealer.dealer_code);
      setFieldMappings(
        mappingsResult?.fieldMappings?.length ? mappingsResult.fieldMappings : DEFAULT_FIELD_MAPPINGS
      );
      setStatusMappings(
        mappingsResult?.statusMappings?.length ? mappingsResult.statusMappings : DEFAULT_STATUS_MAPPINGS
      );
      setSaveSuccess(true);
      clearSaveSuccessSoon();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Couldn't save the mapping. Try again.", {
        title: "Save failed",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedDealer) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await dealerCrmIntegrationService.testConnection(selectedDealer.dealer_code);
      setTestResult({ ok: true, ...result });
      showAlert("success", "Connection successful.", { title: "Test connection" });
      await loadIntegration(selectedDealer);
    } catch (err) {
      const message = err?.response?.data?.error || "Connection failed.";
      setTestResult({ ok: false, message, httpStatus: err?.response?.data?.httpStatus });
      showAlert("error", message, { title: "Test connection failed" });
    } finally {
      setTesting(false);
    }
  };

  const loadLogs = async () => {
    if (!selectedDealer) return;
    setLogsLoading(true);
    try {
      const result = await dealerCrmIntegrationService.getLogs(selectedDealer.dealer_code);
      setLogs(result?.logs || []);
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Couldn't load integration logs.", {
        title: "Load failed",
      });
    } finally {
      setLogsLoading(false);
    }
  };

  const handleTabChange = (nextTab) => {
    setTab(nextTab);
    if (nextTab === "logs") loadLogs();
  };

  const handleRetrySync = async (log) => {
    try {
      await dealerCrmIntegrationService.retrySync(selectedDealer.dealer_code, log.zoho_lead_id);
      showAlert("success", "Retry queued.", { title: "Retry sync" });
      await loadLogs();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Retry failed.", { title: "Retry sync failed" });
    }
  };

  const logColumns = [
    {
      key: "scenario",
      label: "Scenario",
      render: (row) => {
        const scenario = classifyDealerLog(row);
        if (scenario.special) {
          return (
            <Badge tone={scenario.tone} fixed>
              {scenario.label}
            </Badge>
          );
        }
        return (
          <div className="dealer-crm-config__scenario-cell">
            <span
              className="dealer-crm-config__scenario-badge"
              style={{ backgroundColor: scenario.color.bg, color: scenario.color.text }}
            >
              {scenario.path === "happy" ? "Happy" : "Unhappy"} {scenario.number}
            </span>
            <span className="dealer-crm-config__scenario-desc">{scenario.label}</span>
          </div>
        );
      },
    },
    { key: "created_at", label: "Time" },
    { key: "direction", label: "Direction" },
    { key: "operation", label: "Operation" },
    { key: "zoho_lead_id", label: "Zoho Lead" },
    { key: "external_lead_id", label: "External Lead", render: (row) => row.external_lead_id || "—" },
    { key: "status", label: "Status", render: (row) => logStatusBadge(row.status) },
    { key: "http_status", label: "HTTP" },
    {
      key: "error_message",
      label: "Error",
      render: (row) =>
        row.status === "FAILED" ? (
          <div className="dealer-crm-config__log-error">
            <span className="dealer-crm-config__error-chip">
              <AlertTriangle size={12} />
              {row.error_message || "Unknown error"}
            </span>
            <button
              type="button"
              className="dealer-crm-config__retry-link"
              onClick={(e) => {
                e.stopPropagation();
                handleRetrySync(row);
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <span className="dealer-crm-config__muted">—</span>
        ),
    },
  ];

  const isExternalCrm = config.integration_type === "EXTERNAL_CRM";
  const isZohoCrm = config.crm_type === "ZOHO_CRM";
  // Field/Status mapping only make sense once the connection itself has
  // been verified — mapping fields for an unreachable or misconfigured
  // CRM just produces confusing errors later. Logs stays open regardless.
  const isConnectionVerified = isExternalCrm && CONNECTED_STATUSES.includes(config.status);
  const mappingsLocked = isExternalCrm && !isConnectionVerified;

  // Credentials render as masked/disabled once something is stored and
  // the admin hasn't clicked "Edit credentials" for this session.
  const showMaskedCredentials = hasStoredCredential && !editingCredentials;

  const genericCredentialLabel = () => {
    switch (config.auth_type) {
      case "API_KEY":
        return "API Key";
      case "BEARER_TOKEN":
        return "Bearer Token";
      case "BASIC_AUTH":
        return "Password";
      case "OAUTH2":
        return "Client Secret";
      case "CUSTOM_HEADER":
        return "Header Value";
      default:
        return "Credential";
    }
  };

  const saveButtonContent = (defaultLabel) => {
    if (saving) return "Saving…";
    if (saveSuccess)
      return (
        <>
          <CheckCircle2 size={14} /> Saved
        </>
      );
    return defaultLabel;
  };

  return (
    <div className="dealer-crm-config">
      <div className="dealer-crm-config__layout">
        {/* ---------- Left: dealer picker ---------- */}
        <div className="dealer-crm-config__panel dealer-crm-config__panel--list">
          <div className="dealer-crm-config__panel-header">
            <img src={mgLogo} alt="MG Motor" className="dealer-crm-config__brand-logo" />
            <h3>Our Dealers</h3>
          </div>

          <div className="dealer-crm-config__search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, code, or region…"
            />
          </div>

          {dealersLoading ? (
            <div className="dealer-crm-config__dealer-list-scroll">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} width="100%" height={52} />
              ))}
            </div>
          ) : (
            <>
              <div className="dealer-crm-config__dealer-list-scroll">
                {paginatedDealers.length === 0 ? (
                  <p className="dealer-crm-config__empty-list">No dealers found</p>
                ) : (
                  paginatedDealers.map((dealer) => {
                    const isSelected = dealer.dealer_code === selectedDealer?.dealer_code;
                    const isExpanded = expandedDealers.has(dealer.dealer_code);
                    const connected = isDealerConnected(dealer);
                    return (
                      <div
                        key={dealer.dealer_code}
                        className={`dealer-crm-config__dealer-card ${
                          connected
                            ? "dealer-crm-config__dealer-card--connected"
                            : "dealer-crm-config__dealer-card--pending"
                        } ${isSelected ? "dealer-crm-config__dealer-card--selected" : ""}`}
                      >
                        <button
                          type="button"
                          className="dealer-crm-config__dealer-row"
                          onClick={() => handleSelectDealer(dealer)}
                        >
                          <img src={mgLogo} alt="" className="dealer-crm-config__dealer-logo" />
                          <div className="dealer-crm-config__dealer-info">
                            <span className="dealer-crm-config__dealer-name">{dealer.dealer_name}</span>
                            <span className="dealer-crm-config__dealer-code">{dealer.dealer_code}</span>
                          </div>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={isExpanded ? "Collapse dealer details" : "Expand dealer details"}
                            className={`dealer-crm-config__chevron ${
                              isExpanded ? "dealer-crm-config__chevron--open" : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleDealerExpand(dealer.dealer_code);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                e.preventDefault();
                                toggleDealerExpand(dealer.dealer_code);
                              }
                            }}
                          >
                            <ChevronDown size={16} />
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="dealer-crm-config__dealer-expand">
                            {connected ? (
                              <Badge tone="active" fixed>
                                Active
                              </Badge>
                            ) : (
                              <Badge tone="pending" fixed>
                                Not Configured
                              </Badge>
                            )}
                            <Badge tone="info" fixed>
                              {dealer.region || "—"}
                            </Badge>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <PaginationBar
                page={dealerPage}
                pageSize={dealerPageSize}
                total={filteredDealers.length}
                onPageChange={setDealerPage}
                onPageSizeChange={(size) => {
                  setDealerPageSize(size);
                  setDealerPage(1);
                }}
              />
            </>
          )}
        </div>

        {/* ---------- Right: integration config ---------- */}
        <div className="dealer-crm-config__panel dealer-crm-config__panel--detail">
          {!selectedDealer ? (
            <div className="dealer-crm-config__empty-state">
              <Plug size={28} strokeWidth={1.5} />
              <p>Select a dealer to configure their CRM integration.</p>
            </div>
          ) : (
            <>
              <div className="dealer-crm-config__detail-header">
                <div>
                  <h2>{selectedDealer.dealer_name}</h2>
                  <p className="dealer-crm-config__detail-code">{selectedDealer.dealer_code}</p>
                </div>
                <div className="dealer-crm-config__detail-status">{statusBadge(config.status)}</div>
              </div>

              <div className="dealer-crm-config__tabs">
                <button
                  className={tab === "connection" ? "dealer-crm-config__tab--active" : ""}
                  onClick={() => handleTabChange("connection")}
                >
                  <ShieldCheck size={14} /> Connection
                </button>
                <button
                  className={tab === "fields" ? "dealer-crm-config__tab--active" : ""}
                  onClick={() => !mappingsLocked && handleTabChange("fields")}
                  disabled={!isExternalCrm}
                  title={mappingsLocked ? "Test the connection successfully first to unlock field mapping" : undefined}
                >
                  {mappingsLocked ? <Lock size={13} /> : <ArrowLeftRight size={14} />} Field Mapping
                </button>
                <button
                  className={tab === "status" ? "dealer-crm-config__tab--active" : ""}
                  onClick={() => !mappingsLocked && handleTabChange("status")}
                  disabled={!isExternalCrm}
                  title={mappingsLocked ? "Test the connection successfully first to unlock status mapping" : undefined}
                >
                  {mappingsLocked ? <Lock size={13} /> : <ListChecks size={14} />} Status Mapping
                </button>
                <button
                  className={tab === "logs" ? "dealer-crm-config__tab--active" : ""}
                  onClick={() => handleTabChange("logs")}
                >
                  <ScrollText size={14} /> Activity Log
                </button>
              </div>

              {configLoading ? (
                <div className="dealer-crm-config__skeleton-block">
                  <Skeleton width="100%" height={40} />
                  <Skeleton width="100%" height={40} />
                  <Skeleton width="60%" height={40} />
                </div>
              ) : (
                <>
                  {tab === "connection" && (
                    <div className="dealer-crm-config__form">
                      <div className="dealer-crm-config__mode-toggle">
                        <label className={config.integration_type === "PORTAL" ? "dealer-crm-config__mode--active" : ""}>
                          <input
                            type="radio"
                            name="integration_type"
                            checked={config.integration_type === "PORTAL"}
                            onChange={() => handleConfigChange("integration_type", "PORTAL")}
                          />
                          Dealer Portal
                        </label>
                        <label className={config.integration_type === "EXTERNAL_CRM" ? "dealer-crm-config__mode--active" : ""}>
                          <input
                            type="radio"
                            name="integration_type"
                            checked={config.integration_type === "EXTERNAL_CRM"}
                            onChange={() => handleConfigChange("integration_type", "EXTERNAL_CRM")}
                          />
                          External CRM
                        </label>
                      </div>

                      {config.integration_type === "PORTAL" ? (
                        <p className="dealer-crm-config__portal-note">
                          This dealer uses the standard Catalyst dealer portal. No further configuration is needed —
                          existing invitation and lead sync behaviour applies unchanged.
                        </p>
                      ) : (
                        <>
                          {/* Guided progress summary — tells a non-technical
                              admin exactly where they stand, in plain
                              language, before they touch any fields. */}
                          <div className={`dealer-crm-config__progress ${isConnectionVerified ? "dealer-crm-config__progress--done" : ""}`}>
                            {isConnectionVerified ? (
                              <>
                                <CheckCircle2 size={16} />
                                <span>Connected. This dealer's leads will now sync automatically.</span>
                              </>
                            ) : (
                              <>
                                <ShieldCheck size={16} />
                                <span>Fill in the CRM details below, then test the connection to activate syncing.</span>
                              </>
                            )}
                          </div>

                          <div className="dealer-crm-config__section-title">CRM details</div>

                          <div className="dealer-crm-config__field-row">
                            <label>Which CRM does this dealer use?</label>
                            <Dropdown
                              ariaLabel="CRM type"
                              value={config.crm_type}
                              onChange={(v) => handleConfigChange("crm_type", v)}
                              options={[
                                { value: "GENERIC_REST", label: "Generic REST API" },
                                { value: "ZOHO_CRM", label: "Zoho CRM (dealer's own account)" },
                              ]}
                            />
                          </div>

                          <div className="dealer-crm-config__field-row">
                            <label>CRM name (for your reference)</label>
                            <input
                              value={config.crm_name}
                              onChange={(e) => handleConfigChange("crm_name", e.target.value)}
                              placeholder="e.g. Salesforce, Dealer's Custom CRM"
                            />
                          </div>

                          <div className="dealer-crm-config__field-row">
                            <label>Base URL</label>
                            <input
                              value={config.base_url}
                              onChange={(e) => handleConfigChange("base_url", e.target.value)}
                              placeholder="https://dealer-crm.example.com"
                            />
                            <span className="dealer-crm-config__field-hint">
                              The web address of the dealer's CRM's API — they can provide this, or it's shown in
                              their CRM's developer/API settings.
                            </span>
                          </div>

                          {!isZohoCrm && (
                            <div className="dealer-crm-config__field-row">
                              <label>Authentication method</label>
                              <Dropdown
                                ariaLabel="Authentication type"
                                value={config.auth_type}
                                onChange={(v) => handleConfigChange("auth_type", v)}
                                options={AUTH_TYPES}
                              />
                            </div>
                          )}

                          <div className="dealer-crm-config__section-title">Credentials</div>

                          {isZohoCrm ? (
                            <>
                              <div className="dealer-crm-config__field-row">
                                <label>Accounts domain</label>
                                <input
                                  value={config.oauth_accounts_domain || ""}
                                  onChange={(e) => handleConfigChange("oauth_accounts_domain", e.target.value)}
                                  placeholder="https://accounts.zoho.in"
                                />
                                <span className="dealer-crm-config__field-hint">
                                  Matches the dealer's Zoho region — .com, .in, .eu, .com.au, etc.
                                </span>
                              </div>

                              {showMaskedCredentials ? (
                                <>
                                  <div className="dealer-crm-config__credentials-grid">
                                    <div className="dealer-crm-config__field-row">
                                      <label>Client ID</label>
                                      <input type="password" value={MASKED_CREDENTIAL_PLACEHOLDER} disabled readOnly />
                                    </div>
                                    <div className="dealer-crm-config__field-row">
                                      <label>Client Secret</label>
                                      <input type="password" value={MASKED_CREDENTIAL_PLACEHOLDER} disabled readOnly />
                                    </div>
                                    <div className="dealer-crm-config__field-row">
                                      <label>Refresh Token</label>
                                      <input type="password" value={MASKED_CREDENTIAL_PLACEHOLDER} disabled readOnly />
                                    </div>
                                  </div>
                                  <span className="dealer-crm-config__field-hint">
                                    Credentials are saved and encrypted.{" "}
                                    <button
                                      type="button"
                                      className="dealer-crm-config__link-button"
                                      onClick={() => setEditingCredentials(true)}
                                    >
                                      Edit credentials
                                    </button>
                                  </span>
                                </>
                              ) : (
                                <>
                                  <div className="dealer-crm-config__credentials-grid">
                                    <div className="dealer-crm-config__field-row">
                                      <label>Client ID</label>
                                      <input
                                        type="password"
                                        value={oauthClientId}
                                        onChange={(e) => setOauthClientId(e.target.value)}
                                        placeholder="Enter Client ID"
                                        autoComplete="new-password"
                                      />
                                    </div>
                                    <div className="dealer-crm-config__field-row">
                                      <label>Client Secret</label>
                                      <input
                                        type="password"
                                        value={oauthClientSecret}
                                        onChange={(e) => setOauthClientSecret(e.target.value)}
                                        placeholder="Enter Client Secret"
                                        autoComplete="new-password"
                                      />
                                    </div>
                                    <div className="dealer-crm-config__field-row">
                                      <label>Refresh Token</label>
                                      <input
                                        type="password"
                                        value={oauthRefreshToken}
                                        onChange={(e) => setOauthRefreshToken(e.target.value)}
                                        placeholder="Enter Refresh Token"
                                        autoComplete="new-password"
                                      />
                                    </div>
                                  </div>
                                  {hasStoredCredential && (
                                    <button
                                      type="button"
                                      className="dealer-crm-config__link-button"
                                      onClick={resetCredentialInputs}
                                    >
                                      Cancel
                                    </button>
                                  )}
                                </>
                              )}
                            </>
                          ) : showMaskedCredentials ? (
                            <div className="dealer-crm-config__field-row">
                              <label>{genericCredentialLabel()}</label>
                              <input type="password" value={MASKED_CREDENTIAL_PLACEHOLDER} disabled readOnly />
                              <span className="dealer-crm-config__field-hint">
                                A credential is saved and encrypted.{" "}
                                <button
                                  type="button"
                                  className="dealer-crm-config__link-button"
                                  onClick={() => setEditingCredentials(true)}
                                >
                                  Edit credential
                                </button>
                              </span>
                            </div>
                          ) : (
                            <div className="dealer-crm-config__field-row">
                              <label>{genericCredentialLabel()}</label>
                              <input
                                type="password"
                                value={credentialValue}
                                onChange={(e) => setCredentialValue(e.target.value)}
                                placeholder="Enter credential"
                                autoComplete="new-password"
                              />
                              {hasStoredCredential && (
                                <button
                                  type="button"
                                  className="dealer-crm-config__link-button"
                                  onClick={resetCredentialInputs}
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          )}

                          <div className="dealer-crm-config__section-title">Lead endpoints</div>

                          <div className="dealer-crm-config__field-row-inline">
                            <div>
                              <label>Create Lead URL path</label>
                              <input
                                value={config.create_lead_endpoint}
                                onChange={(e) => handleConfigChange("create_lead_endpoint", e.target.value)}
                                placeholder={isZohoCrm ? "/crm/v8/Leads" : "/api/leads"}
                              />
                            </div>
                            <div>
                              <label>Update Lead URL path</label>
                              <input
                                value={config.update_lead_endpoint}
                                onChange={(e) => handleConfigChange("update_lead_endpoint", e.target.value)}
                                placeholder={isZohoCrm ? "/crm/v8/Leads/{externalLeadId}" : "/api/leads/{externalLeadId}"}
                              />
                            </div>
                            <div>
                              <label>Create method</label>
                              <Dropdown
                                ariaLabel="Create HTTP method"
                                value={config.http_method}
                                onChange={(v) => handleConfigChange("http_method", v)}
                                options={HTTP_METHODS}
                              />
                            </div>
                            <div>
                              <label>Update method</label>
                              <Dropdown
                                ariaLabel="Update HTTP method"
                                value={config.update_http_method || "PUT"}
                                onChange={(v) => handleConfigChange("update_http_method", v)}
                                options={HTTP_METHODS}
                              />
                            </div>
                          </div>

                          <label className="dealer-crm-config__checkbox-row">
                            <input
                              type="checkbox"
                              checked={config.webhook_enabled}
                              onChange={(e) => handleConfigChange("webhook_enabled", e.target.checked)}
                            />
                            Let the dealer's CRM send updates back to us automatically
                          </label>

                          {testResult && (
                            <div
                              className={`dealer-crm-config__test-result ${
                                testResult.ok ? "dealer-crm-config__test-result--ok" : "dealer-crm-config__test-result--error"
                              }`}
                            >
                              {testResult.ok ? (
                                <>Connection successful — the dealer's CRM responded in {testResult.responseTimeMs}ms.</>
                              ) : (
                                <>Connection failed{testResult.httpStatus ? ` (HTTP ${testResult.httpStatus})` : ""}: {testResult.message}</>
                              )}
                            </div>
                          )}
                        </>
                      )}

                      <div className="dealer-crm-config__actions">
                        {isExternalCrm && (
                          <button
                            type="button"
                            className="dealer-crm-config__button--outline"
                            onClick={handleTestConnection}
                            disabled={testing || !config.base_url}
                          >
                            {testing ? <Loader2 size={14} className="dealer-crm-config__spin" /> : <RefreshCw size={14} />}
                            {testing ? "Connecting…" : "Connect Dealer CRM"}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`dealer-crm-config__button--primary ${
                            saveSuccess ? "dealer-crm-config__button--success" : ""
                          }`}
                          onClick={handleSaveConnection}
                          disabled={saving}
                        >
                          {saveButtonContent("Save Configuration")}
                        </button>
                      </div>
                    </div>
                  )}

                  {tab === "fields" && isExternalCrm && (
                    mappingsLocked ? (
                      <div className="dealer-crm-config__locked-state">
                        <Lock size={22} strokeWidth={1.5} />
                        <p>Test the connection on the Connection tab first — field mapping unlocks once it succeeds.</p>
                      </div>
                    ) : (
                      <div className="dealer-crm-config__mapping-table">
                        <p className="dealer-crm-config__mapping-intro">
                          Tell us which field in the dealer's CRM matches each of our fields, so lead details line up
                          correctly on both sides.
                        </p>
                        <div className="dealer-crm-config__mapping-header">
                          <span>Our Field</span>
                          <span />
                          <span>Dealer CRM Field</span>
                          <span>Required</span>
                          <span />
                        </div>
                        {fieldMappings.map((mapping, index) => (
                          <div className="dealer-crm-config__mapping-row" key={index}>
                            <Dropdown
                              ariaLabel="Our field"
                              value={mapping.source_field}
                              onChange={(v) => handleFieldMappingChange(index, "source_field", v)}
                              options={OUR_FIELD_OPTIONS}
                            />
                            <span className="dealer-crm-config__mapping-arrow">→</span>
                            <input
                              value={mapping.target_field}
                              onChange={(e) => handleFieldMappingChange(index, "target_field", e.target.value)}
                              placeholder="Last_Name"
                            />
                            <label className="dealer-crm-config__checkbox-row dealer-crm-config__checkbox-row--compact">
                              <input
                                type="checkbox"
                                checked={mapping.required}
                                onChange={(e) => handleFieldMappingChange(index, "required", e.target.checked)}
                              />
                            </label>
                            <button
                              type="button"
                              className="dealer-crm-config__remove-mapping"
                              onClick={() => removeFieldMapping(index)}
                              aria-label="Remove mapping"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button type="button" className="dealer-crm-config__add-mapping" onClick={addFieldMapping}>
                          + Add another field
                        </button>

                        <div className="dealer-crm-config__actions">
                          <button
                            type="button"
                            className={`dealer-crm-config__button--primary ${
                              saveSuccess ? "dealer-crm-config__button--success" : ""
                            }`}
                            onClick={handleSaveMappings}
                            disabled={saving}
                          >
                            {saveButtonContent("Save Field Mapping")}
                          </button>
                        </div>
                      </div>
                    )
                  )}

                  {tab === "status" && isExternalCrm && (
                    mappingsLocked ? (
                      <div className="dealer-crm-config__locked-state">
                        <Lock size={22} strokeWidth={1.5} />
                        <p>Test the connection on the Connection tab first — status mapping unlocks once it succeeds.</p>
                      </div>
                    ) : (
                      <div className="dealer-crm-config__mapping-table">
                        <p className="dealer-crm-config__mapping-intro">
                          Match each of our lead statuses to the equivalent status name in the dealer's CRM.
                        </p>
                        <div className="dealer-crm-config__mapping-header dealer-crm-config__mapping-header--status">
                          <span>Our Status</span>
                          <span />
                          <span>Dealer CRM Status</span>
                          <span />
                        </div>
                        {statusMappings.map((mapping, index) => (
                          <div className="dealer-crm-config__mapping-row dealer-crm-config__mapping-row--status" key={index}>
                            <input
                              value={mapping.source_status}
                              onChange={(e) => handleStatusMappingChange(index, "source_status", e.target.value)}
                              placeholder="e.g. New, Contacted…"
                            />
                            <span className="dealer-crm-config__mapping-arrow">→</span>
                            <input
                              value={mapping.target_status}
                              onChange={(e) => handleStatusMappingChange(index, "target_status", e.target.value)}
                              placeholder="e.g. OPEN, IN_PROGRESS, HOT…"
                            />
                            <button
                              type="button"
                              className="dealer-crm-config__remove-mapping"
                              onClick={() => removeStatusMapping(index)}
                              aria-label="Remove mapping"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button type="button" className="dealer-crm-config__add-mapping" onClick={addStatusMapping}>
                          + Add another status
                        </button>

                        <div className="dealer-crm-config__actions">
                          <button
                            type="button"
                            className={`dealer-crm-config__button--primary ${
                              saveSuccess ? "dealer-crm-config__button--success" : ""
                            }`}
                            onClick={handleSaveMappings}
                            disabled={saving}
                          >
                            {saveButtonContent("Save Status Mapping")}
                          </button>
                        </div>
                      </div>
                    )
                  )}

                  {tab === "logs" && (
                    <>
                      <Table
                        columns={logColumns}
                        rows={paginatedLogs}
                        loading={logsLoading}
                        emptyMessage="No integration activity yet"
                        onRowClick={(row) => setActiveLogDetail(row)}
                        showSerial={false}
                      />
                      {!logsLoading && logs.length > 0 && (
                        <PaginationBar
                          page={logsPage}
                          pageSize={logsPageSize}
                          total={logs.length}
                          onPageChange={setLogsPage}
                          onPageSizeChange={(size) => {
                            setLogsPageSize(size);
                            setLogsPage(1);
                          }}
                        />
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      <LogDetailOffcanvas row={activeLogDetail} onClose={() => setActiveLogDetail(null)} />
    </div>
  );
}