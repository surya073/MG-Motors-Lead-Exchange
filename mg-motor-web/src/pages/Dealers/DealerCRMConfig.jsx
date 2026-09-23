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
  Pencil,
  Trash2,
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
 * (unchanged doc comment — see original file)
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

const CONNECTED_STATUSES = ["ACTIVE", "CONNECTED"];

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

const MASKED_CREDENTIAL_PLACEHOLDER = "••••••••••••";

const DEFAULT_FIELD_MAPPINGS = [
  { source_field: "enquiry_id", target_field: "", data_type: "string", required: true },
  { source_field: "customer_name", target_field: "", data_type: "string", required: true },
  { source_field: "mobile_number", target_field: "", data_type: "string", required: true },
  { source_field: "email_address", target_field: "", data_type: "string", required: true },
  { source_field: "postcode", target_field: "", data_type: "string", required: true },
  { source_field: "vehicle_model", target_field: "", data_type: "string", required: true },
  { source_field: "enquiry_variant", target_field: "", data_type: "string", required: false },
  { source_field: "nature_of_enquiry", target_field: "", data_type: "string", required: true },
  { source_field: "lead_source", target_field: "", data_type: "string", required: true },
  { source_field: "dealer_code", target_field: "", data_type: "string", required: true },
  { source_field: "accept_privacy_policy", target_field: "", data_type: "boolean", required: true },
  { source_field: "receive_marketing_updates", target_field: "", data_type: "boolean", required: false },
  { source_field: "lead_status", target_field: "", data_type: "string", required: true },
  { source_field: "enquiry_outcome", target_field: "", data_type: "string", required: false },
  { source_field: "purchase_classification", target_field: "", data_type: "string", required: false },
  { source_field: "last_status_update", target_field: "", data_type: "datetime", required: false },
];

const DEFAULT_STATUS_MAPPINGS = [
  { source_status: "Not Contacted", target_status: "" },
  { source_status: "Follow-up 1", target_status: "" },
  { source_status: "Follow-up 2", target_status: "" },
  { source_status: "Contacted", target_status: "" },
  { source_status: "Contact in Future", target_status: "" },
  { source_status: "Not Qualified", target_status: "" },
  { source_status: "Dropped", target_status: "" },
  { source_status: "Lost", target_status: "" },
  { source_status: "Attempted to Contact", target_status: "" },
  { source_status: "Junk Lead", target_status: "" },
  { source_status: "Lost Lead", target_status: "" },
  { source_status: "Pre-Qualified", target_status: "" },
];

// Verified against both live Zoho picklists on 23 Sep 2026 and aligned to
// the register. Saving these rows also creates the reverse dealer -> MG rows;
// e.g. Received / Acknowledged maps back to MG Not Contacted.
const AU008_VERIFIED_STATUS_MAPPINGS = [
  { source_status: "Not Contacted", target_status: "Received / Acknowledged" },
  { source_status: "Follow-up 1", target_status: "Follow-up 1 / In progress" },
  { source_status: "Follow-up 2", target_status: "Follow-up 2" },
  { source_status: "Contacted", target_status: "Contacted" },
  { source_status: "Contact in Future", target_status: "Nurture / Future" },
  { source_status: "Not Qualified", target_status: "Not Qualified" },
  { source_status: "Dropped", target_status: "Dropped" },
  { source_status: "Lost", target_status: "Lost (final)" },
  { source_status: "Attempted to Contact", target_status: "Attempted to Contact" },
  { source_status: "Junk Lead", target_status: "Junk Lead" },
  { source_status: "Lost Lead", target_status: "Lost Lead" },
  { source_status: "Pre-Qualified", target_status: "Pre-Qualified" },
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
  "happy-3": {
    path: "happy",
    number: 3,
    label: "Duplicate detected",
    color: { bg: "var(--scenario-happy-3-bg)", text: "var(--scenario-happy-3-text)" },
  },
  "happy-4": {
    path: "happy",
    number: 4,
    label: "Integration recovery (replay)",
    color: { bg: "var(--scenario-happy-4-bg)", text: "var(--scenario-happy-4-text)" },
  },
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
  "unhappy-3": {
    path: "unhappy",
    number: 3,
    label: "Dealer unavailable (after 24h retry)",
    color: { bg: "var(--scenario-unhappy-3-bg)", text: "var(--scenario-unhappy-3-text)" },
  },
  "unhappy-4": {
    path: "unhappy",
    number: 4,
    label: "Status update failure (dealer → OEM)",
    color: { bg: "var(--scenario-unhappy-4-bg)", text: "var(--scenario-unhappy-4-text)" },
  },
  "unhappy-5": {
    path: "unhappy",
    number: 5,
    label: "Wrong / rejected dealer mapping",
    color: { bg: "var(--scenario-unhappy-5-bg)", text: "var(--scenario-unhappy-5-text)" },
  },
  "unhappy-6": {
    path: "unhappy",
    number: 6,
    label: "Ownership conflict",
    color: { bg: "var(--scenario-unhappy-6-bg)", text: "var(--scenario-unhappy-6-text)" },
  },
  "unhappy-7": {
    path: "unhappy",
    number: 7,
    label: "Out-of-order events",
    color: { bg: "var(--scenario-unhappy-7-bg)", text: "var(--scenario-unhappy-7-text)" },
  },
  "unhappy-8": {
    path: "unhappy",
    number: 8,
    label: "Consent / privacy mismatch",
    color: { bg: "var(--scenario-unhappy-8-bg)", text: "var(--scenario-unhappy-8-text)" },
  },
  "unhappy-9": {
    path: "unhappy",
    number: 9,
    label: "Dealer rejects enquiry (spam / junk only)",
    color: { bg: "var(--scenario-unhappy-9-bg)", text: "var(--scenario-unhappy-9-text)" },
  },
  "unhappy-10": {
    path: "unhappy",
    number: 10,
    label: "SLA breach",
    color: { bg: "var(--scenario-unhappy-10-bg)", text: "var(--scenario-unhappy-10-text)" },
  },
};

const INVALID_DATA_ERROR_CODES = new Set(["FIELD_MAPPING_INVALID", "LEAD_VALIDATION_FAILED"]);

function scenarioKeyFromStoredName(name) {
  const match = /^(happy|unhappy)\s+(\d+)$/i.exec((name || "").trim());
  if (!match) return null;
  return `${match[1].toLowerCase()}-${match[2]}`;
}

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
      return { ...known, label: row.happy_unhappy_path_message || known.label };
    }

    return {
      special: true,
      label: row.happy_unhappy_path_message || row.happy_unhappy_path_name,
      tone: "neutral",
    };
  }

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

// Activity-log rows use SUCCESS / FAILED — separate from the top-level
// Connected / Not Connected badge, which uses the dealer_integrations
// status vocabulary.
function logStatusBadge(status) {
  if (status === "SUCCESS") return <Badge tone="active" fixed>Success</Badge>;
  if (status === "FAILED") return <Badge tone="danger" fixed>Failed</Badge>;
  return <Badge tone="neutral" fixed>{status || "—"}</Badge>;
}

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
  const [webhookRegistering, setWebhookRegistering] = useState(false);

  const [tab, setTab] = useState("connection");

  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [credentialValue, setCredentialValue] = useState("");
  const [hasStoredCredential, setHasStoredCredential] = useState(false);
  const [editingCredentials, setEditingCredentials] = useState(false);

  const [fieldMappings, setFieldMappings] = useState(DEFAULT_FIELD_MAPPINGS);
  const [statusMappings, setStatusMappings] = useState(DEFAULT_STATUS_MAPPINGS);

  // UI-only: which mapping rows (by current array index) are in edit mode
  // right now. A row is ALSO in edit mode automatically whenever it has
  // no ROWID yet (i.e. it's new/unsaved) — this set only tracks rows the
  // admin has explicitly re-opened via the pencil icon after they were
  // already saved. Cleared back to empty every time a fresh mapping list
  // comes in from the server (initial load or after a successful save),
  // since a freshly-loaded row is by definition saved and not being edited.
  const [editingFieldRows, setEditingFieldRows] = useState(() => new Set());
  const [editingStatusRows, setEditingStatusRows] = useState(() => new Set());

  const [oemStatusOptions, setOemStatusOptions] = useState([]);
  const [picklistRefreshing, setPicklistRefreshing] = useState(false);

  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [activeLogDetail, setActiveLogDetail] = useState(null);

  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthRefreshToken, setOauthRefreshToken] = useState("");

   const savedConfigSnapshotRef = useRef(EMPTY_CONFIG);

  const isConnectionDirty = useMemo(() => {
    const snap = savedConfigSnapshotRef.current;
    return (
      JSON.stringify(config) !== JSON.stringify(snap) ||
      Boolean(credentialValue) ||
      Boolean(oauthClientId) ||
      Boolean(oauthClientSecret) ||
      Boolean(oauthRefreshToken)
    );
  }, [config, credentialValue, oauthClientId, oauthClientSecret, oauthRefreshToken]);

  const [expandedDealers, setExpandedDealers] = useState(() => new Set());
  const [dealerPage, setDealerPage] = useState(1);
  const [dealerPageSize, setDealerPageSize] = useState(10);

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
          if (match) {
            setSelectedDealer(match);
            // FIX: deep-linking in used to leave connection status stale
            // (whatever EMPTY_CONFIG/default was) because only the dealer
            // was selected, not its integration loaded — clicking a dealer
            // manually always called this, deep-link never did.
            loadIntegration(match);
          }
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

  useEffect(() => {
    setDealerPage(1);
  }, [search]);

  const paginatedDealers = useMemo(
    () => paginate(filteredDealers, dealerPage, dealerPageSize),
    [filteredDealers, dealerPage, dealerPageSize]
  );

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
      // setConfig({ ...EMPTY_CONFIG, ...(result?.integration || {}) });
      const loaded = { ...EMPTY_CONFIG, ...(result?.integration || {}) };
      setConfig(loaded);
      savedConfigSnapshotRef.current = loaded;
      setHasStoredCredential(Boolean(result?.hasCredential));
      resetCredentialInputs();

      const mappingsResult = await dealerCrmIntegrationService.getMappings(dealer.dealer_code);
      setFieldMappings(
        mappingsResult?.fieldMappings?.length ? mappingsResult.fieldMappings : DEFAULT_FIELD_MAPPINGS
      );
      setStatusMappings(
        mappingsResult?.statusMappings?.length ? mappingsResult.statusMappings : DEFAULT_STATUS_MAPPINGS
      );
      setEditingFieldRows(new Set());
      setEditingStatusRows(new Set());
    } catch (err) {
      if (err?.response?.status === 404) {
        setConfig(EMPTY_CONFIG);
        savedConfigSnapshotRef.current = EMPTY_CONFIG;
        setHasStoredCredential(false);
        resetCredentialInputs();
        setFieldMappings(DEFAULT_FIELD_MAPPINGS);
        setStatusMappings(DEFAULT_STATUS_MAPPINGS);
        setEditingFieldRows(new Set());
        setEditingStatusRows(new Set());
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
    setConfig((prev) => {
      if (key === "crm_type" && value === "ZOHO_CRM") {
        return {
          ...prev,
          crm_type: value,
          create_lead_endpoint: "/crm/v8/Leads",
          update_lead_endpoint: "/crm/v8/Leads/{externalLeadId}",
          http_method: "POST",
          update_http_method: "PUT",
        };
      }
      return { ...prev, [key]: value };
    });
  };

  const handleFieldMappingChange = (index, key, value) => {
    setSaveSuccess(false);
    setFieldMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  };

  const addFieldMapping = () => {
    setSaveSuccess(false);
    setFieldMappings((prev) => [...prev, { source_field: "", target_field: "", data_type: "string", required: false }]);
  };

  // Index-shift-safe removal: any editing-row index above the removed one
  // needs to shift down by one, and the removed index itself drops out —
  // otherwise deleting a row could leave an unrelated row stuck "open".
  const removeFieldMapping = (index) => {
    setSaveSuccess(false);
    setFieldMappings((prev) => prev.filter((_, i) => i !== index));
    setEditingFieldRows((prev) => {
      const next = new Set();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  };

  const startEditingFieldMapping = (index) => {
    setEditingFieldRows((prev) => new Set(prev).add(index));
  };

  const handleStatusMappingChange = (index, key, value) => {
    setSaveSuccess(false);
    setStatusMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  };

  const addStatusMapping = () => {
    setSaveSuccess(false);
    setStatusMappings((prev) => [...prev, { source_status: "", target_status: "" }]);
  };

  const applyVerifiedAu008StatusMap = () => {
    setSaveSuccess(false);
    // Deliberately drop ROWIDs: the backend safely upserts these canonical
    // pairs first, then removes the old reversed/duplicate AU008 rows.
    setStatusMappings(AU008_VERIFIED_STATUS_MAPPINGS.map((mapping) => ({ ...mapping })));
    setEditingStatusRows(new Set());
  };

  const removeStatusMapping = (index) => {
    setSaveSuccess(false);
    setStatusMappings((prev) => prev.filter((_, i) => i !== index));
    setEditingStatusRows((prev) => {
      const next = new Set();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  };

  const startEditingStatusMapping = (index) => {
    setEditingStatusRows((prev) => new Set(prev).add(index));
  };

  const loadStatusPicklist = async () => {
    try {
      const result = await dealerCrmIntegrationService.getStatusPicklist();
      setOemStatusOptions(
        (result?.values || []).map((v) => ({ value: v.value, label: v.display_label || v.value }))
      );
    } catch (err) {
      showAlert("error", "Couldn't load OEM status list.", { title: "Load failed" });
    }
  };

  const handleRefreshStatusPicklist = async () => {
    setPicklistRefreshing(true);
    try {
      const result = await dealerCrmIntegrationService.refreshStatusPicklist();
      showAlert("success", `Refreshed ${result.count} statuses from CRM.`, { title: "Picklist refreshed" });
      await loadStatusPicklist();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Refresh failed.", { title: "Refresh failed" });
    } finally {
      setPicklistRefreshing(false);
    }
  };

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
      savedConfigSnapshotRef.current = config;
      setSaveSuccess(true);
      clearSaveSuccessSoon();
      resetCredentialInputs();
      await loadIntegration(selectedDealer);
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
      // Every row just came back fresh from the server — none of them
      // should stay pinned open in edit mode.
      setEditingFieldRows(new Set());
      setEditingStatusRows(new Set());
      setSaveSuccess(true);
      clearSaveSuccessSoon();
    } catch (err) {
      const response = err?.response?.data;
      const missing = Array.isArray(response?.missingFields) ? response.missingFields.join(", ") : "";
      let message = response?.error || "Couldn't save the mapping. Try again.";
      if (missing) message = `Map every mandatory field before saving. Missing: ${missing}`;
      if (response?.error === "STATUS_MAPPING_INVALID_SOURCE") {
        message = `“${response.value}” is not a current MG Lead Status.`;
      }
      if (response?.error === "STATUS_MAPPING_OEM_ONLY") {
        message = `“${response.value}” is an MG-only workflow status and must not be mapped to a dealer value.`;
      }
      if (response?.error === "STATUS_MAPPING_AMBIGUOUS") {
        message = `“${response.value}” has an ambiguous two-way status mapping. Keep exactly one approved counterpart.`;
      }
      if (response?.error === "FIELD_MAPPING_AMBIGUOUS") {
        message = `Each MG and dealer field may appear only once. Check ${response.sourceField || "the source field"} and ${response.targetField || "the target field"}.`;
      }
      showAlert("error", message, {
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

  const handleRegisterWebhook = async () => {
    if (!selectedDealer) return;
    setWebhookRegistering(true);
    try {
      const result = await dealerCrmIntegrationService.registerWebhook(selectedDealer.dealer_code);
      const expiresAt = result?.result?.expiresAt;
      showAlert(
        "success",
        expiresAt ? `Dealer webhook renewed until ${expiresAt}.` : "Dealer webhook renewed successfully.",
        { title: "Webhook renewed" }
      );
    } catch (err) {
      showAlert(
        "error",
        err?.response?.data?.message || err?.response?.data?.error || "Webhook registration failed.",
        { title: "Webhook renewal failed" }
      );
    } finally {
      setWebhookRegistering(false);
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
    if (nextTab === "status") loadStatusPicklist();
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
  const isConnectionVerified = isExternalCrm && CONNECTED_STATUSES.includes(config.status);
  const mappingsLocked = isExternalCrm && !isConnectionVerified;
  const isTopConnected = CONNECTED_STATUSES.includes(config.status);

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

  // A saved field-mapping row is one the server already has (has a
  // ROWID) with both sides filled in, and that the admin hasn't
  // re-opened via the pencil icon. Anything else renders as editable —
  // covers brand-new rows (no ROWID yet) and rows currently being edited.
  const isFieldRowSaved = (mapping, index) =>
    Boolean(mapping.ROWID) &&
    Boolean(mapping.source_field) &&
    Boolean(mapping.target_field) &&
    !editingFieldRows.has(index);

  const isStatusRowSaved = (mapping, index) =>
    Boolean(mapping.ROWID) &&
    Boolean(mapping.source_status) &&
    Boolean(mapping.target_status) &&
    !editingStatusRows.has(index);

  const ourFieldLabel = (value) => OUR_FIELD_OPTIONS.find((o) => o.value === value)?.label || humanizeFieldName(value);
  const ourStatusLabel = (value) => oemStatusOptions.find((o) => o.value === value)?.label || value || "—";

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
                          <div className="dealer-crm-config__dealer-logo-wrap">
                            <img src={mgLogo} alt="" className="dealer-crm-config__dealer-logo" />
                            {/* NEW: tick badge on the logo itself, visible
                                without expanding the card — the border/bg
                                tint already signals connected state at a
                                glance, this adds an explicit icon too. */}
                            {connected && (
                              <span className="dealer-crm-config__dealer-connected-tick" aria-label="Connected">
                                <CheckCircle2 size={12} strokeWidth={2.5} />
                              </span>
                            )}
                          </div>
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
                            {connected && (
                              <Badge tone="active" fixed>
                                Connected
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
                {/* NEW: simplified to just Connected / Not Connected —
                    the granular ACTIVE/CONFIGURING/ERROR/etc vocabulary
                    is still visible in the Activity Log per-row, just not
                    duplicated here at the top. */}
                <div className="dealer-crm-config__detail-status">
                  <Badge tone={isTopConnected ? "active" : "neutral"} fixed>
                    {isTopConnected ? "Connected" : "Not Connected"}
                  </Badge>
                </div>
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

                          {/* NEW: toggle-switch style instead of a plain
                              checkbox. Same checked/onChange wiring —
                              config.webhook_enabled and
                              handleConfigChange are untouched. */}
                          <label className="dealer-crm-config__toggle-row">
                            <span className="dealer-crm-config__toggle-switch">
                              <input
                                type="checkbox"
                                checked={config.webhook_enabled}
                                onChange={(e) => handleConfigChange("webhook_enabled", e.target.checked)}
                              />
                              <span className="dealer-crm-config__toggle-slider" />
                            </span>
                            <span className="dealer-crm-config__toggle-row-label">
                              Let the dealer's CRM send updates back to us automatically
                            </span>
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

                        {isExternalCrm && isZohoCrm && (
                          <button
                            type="button"
                            className="dealer-crm-config__button--outline"
                            onClick={handleRegisterWebhook}
                            disabled={webhookRegistering || testing || isConnectionDirty || !hasStoredCredential || !config.webhook_enabled}
                          >
                            {webhookRegistering ? <Loader2 size={14} className="dealer-crm-config__spin" /> : <RefreshCw size={14} />}
                            {webhookRegistering ? "Renewing webhook…" : "Renew Dealer Webhook"}
                          </button>
                        )}

                        {isConnectionDirty && (
                          <div className="dealer-crm-config__unsaved-bar">
                            <span className="dealer-crm-config__unsaved-text">
                              <span className="dealer-crm-config__unsaved-dot" />
                              Unsaved changes
                            </span>
                            <button
                              type="button"
                              className={`dealer-crm-config__button--primary ${saveSuccess ? "dealer-crm-config__button--success" : ""}`}
                              onClick={handleSaveConnection}
                              disabled={saving}
                            >
                              {saveButtonContent("Save Configuration")}
                            </button>
                          </div>
                        )}
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
                        {fieldMappings.map((mapping, index) => {
                          if (isFieldRowSaved(mapping, index)) {
                            return (
                              <div
                                className="dealer-crm-config__mapping-row dealer-crm-config__mapping-row--saved"
                                key={index}
                              >
                                <div className="dealer-crm-config__mapping-saved-label">
                                  <CheckCircle2 size={15} className="dealer-crm-config__mapping-check" />
                                  <span className="dealer-crm-config__mapping-saved-text">
                                    {ourFieldLabel(mapping.source_field)}
                                    <span className="dealer-crm-config__mapping-arrow-inline">→</span>
                                    {mapping.target_field}
                                  </span>
                                </div>
                                <label className="dealer-crm-config__toggle-switch dealer-crm-config__toggle-switch--compact">
                                  <input
                                    type="checkbox"
                                    checked={mapping.required}
                                    onChange={(e) => handleFieldMappingChange(index, "required", e.target.checked)}
                                  />
                                  <span className="dealer-crm-config__toggle-slider" />
                                </label>
                                <div className="dealer-crm-config__mapping-row-actions">
                                  <button
                                    type="button"
                                    className="dealer-crm-config__icon-button"
                                    onClick={() => startEditingFieldMapping(index)}
                                    aria-label="Edit mapping"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="dealer-crm-config__icon-button dealer-crm-config__icon-button--danger"
                                    onClick={() => removeFieldMapping(index)}
                                    aria-label="Delete mapping"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                            );
                          }
                          return (
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
                                placeholder="Dealer CRM field name"
                              />
                              <label className="dealer-crm-config__toggle-switch dealer-crm-config__toggle-switch--compact">
                                <input
                                  type="checkbox"
                                  checked={mapping.required}
                                  onChange={(e) => handleFieldMappingChange(index, "required", e.target.checked)}
                                />
                                <span className="dealer-crm-config__toggle-slider" />
                              </label>
                              <button
                                type="button"
                                className="dealer-crm-config__icon-button dealer-crm-config__icon-button--danger"
                                onClick={() => removeFieldMapping(index)}
                                aria-label="Remove mapping"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          );
                        })}
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
                          Match each MG lifecycle status to the approved dealer value. Saving creates both directions; MG-only states such as Update Pending, Dealer Unavailable and Unattended Alert are intentionally excluded.
                        </p>
                        <button
                          type="button"
                          className="dealer-crm-config__button--outline"
                          onClick={handleRefreshStatusPicklist}
                          disabled={picklistRefreshing}
                        >
                          {picklistRefreshing ? <Loader2 size={14} className="dealer-crm-config__spin" /> : <RefreshCw size={14} />}
                          {picklistRefreshing ? "Refreshing…" : "Refresh statuses from CRM"}
                        </button>

                        {selectedDealer?.dealer_code === "AU008" && config.crm_type === "ZOHO_CRM" && (
                          <button
                            type="button"
                            className="dealer-crm-config__button--outline"
                            onClick={applyVerifiedAu008StatusMap}
                            disabled={saving}
                          >
                            <ShieldCheck size={14} />
                            Load verified AU008 map
                          </button>
                        )}

                        {statusMappings.map((mapping, index) => {
                          if (isStatusRowSaved(mapping, index)) {
                            return (
                              <div
                                className="dealer-crm-config__mapping-row dealer-crm-config__mapping-row--saved"
                                key={index}
                              >
                                <div className="dealer-crm-config__mapping-saved-label">
                                  <CheckCircle2 size={15} className="dealer-crm-config__mapping-check" />
                                  <span className="dealer-crm-config__mapping-saved-text">
                                    {ourStatusLabel(mapping.source_status)}
                                    <span className="dealer-crm-config__mapping-arrow-inline">↔</span>
                                    {mapping.target_status}
                                  </span>
                                </div>
                                <div className="dealer-crm-config__mapping-row-actions">
                                  <button
                                    type="button"
                                    className="dealer-crm-config__icon-button"
                                    onClick={() => startEditingStatusMapping(index)}
                                    aria-label="Edit status mapping"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="dealer-crm-config__icon-button dealer-crm-config__icon-button--danger"
                                    onClick={() => removeStatusMapping(index)}
                                    aria-label="Delete status mapping"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div className="dealer-crm-config__mapping-row dealer-crm-config__mapping-row--status" key={index}>
                              <Dropdown
                                ariaLabel="Our status"
                                value={mapping.source_status}
                                onChange={(v) => handleStatusMappingChange(index, "source_status", v)}
                                options={[{ value: "", label: "Select status…" }, ...oemStatusOptions]}
                              />
                              <span className="dealer-crm-config__mapping-arrow">→</span>
                              <input
                                value={mapping.target_status}
                                onChange={(e) => handleStatusMappingChange(index, "target_status", e.target.value)}
                                placeholder="e.g. OPEN, IN_PROGRESS, HOT…"
                              />
                              <button
                                type="button"
                                className="dealer-crm-config__icon-button dealer-crm-config__icon-button--danger"
                                onClick={() => removeStatusMapping(index)}
                                aria-label="Remove mapping"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          );
                        })}
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
