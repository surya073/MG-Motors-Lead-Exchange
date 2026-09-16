import { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { dealerCrmIntegrationService } from "../../services/api/dealerCrmIntegrationService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import TableSkeleton from "../../ui/Skeleton/TableSkeleton";
import Skeleton from "../../ui/Skeleton/Skeleton";
import { useAlerts } from "../../ui/Alerts/Alerts";
import "./DealerCRMConfig.css";
import "../../ui/Skeleton/Skeleton.css";
import "../../ui/Skeleton/TableSkeleton.css";

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
 *   left  — searchable list of synced dealers
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

const INTEGRATION_STATUS_TONES = {
  ACTIVE: "active",
  CONNECTED: "active",
  CONFIGURING: "pending",
  NOT_CONFIGURED: "neutral",
  DISABLED: "neutral",
  ERROR: "danger",
};

const CONNECTED_STATUSES = ["ACTIVE", "CONNECTED"];

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

function statusBadge(status) {
  const tone = INTEGRATION_STATUS_TONES[status] || "neutral";
  const label = (status || "NOT_CONFIGURED").replace(/_/g, " ");
  return <Badge tone={tone} fixed>{label}</Badge>;
}

function integrationTypeBadge(type) {
  return type === "EXTERNAL_CRM" ? (
    <Badge tone="info" fixed>External CRM</Badge>
  ) : (
    <Badge tone="neutral" fixed>Portal</Badge>
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

  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthRefreshToken, setOauthRefreshToken] = useState("");

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

  const filteredDealers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return dealers;
    return dealers.filter((d) =>
      [d.dealer_name, d.dealer_code, d.email_address, d.region].filter(Boolean).some((f) => f.toLowerCase().includes(term))
    );
  }, [dealers, search]);

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
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleFieldMappingChange = (index, key, value) => {
    setFieldMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  };

  const addFieldMapping = () => {
    setFieldMappings((prev) => [...prev, { source_field: "", target_field: "", data_type: "string", required: false }]);
  };

  const removeFieldMapping = (index) => {
    setFieldMappings((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStatusMappingChange = (index, key, value) => {
    setStatusMappings((prev) => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  };

  const handleSave = async () => {
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

      if (config.integration_type === "EXTERNAL_CRM") {
        await dealerCrmIntegrationService.saveMappings(selectedDealer.dealer_code, {
          fieldMappings,
          statusMappings,
        });
      }

      showAlert("success", `Saved integration settings for ${selectedDealer.dealer_name}.`, {
        title: "Configuration saved",
      });
      // After a successful save, any credential just entered is now
      // persisted server-side — collapse back to the masked/disabled
      // view rather than leaving raw values sitting in the inputs.
      resetCredentialInputs();
      await loadIntegration(selectedDealer);
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Couldn't save the configuration. Try again.", {
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

  const dealerColumns = [
    { key: "dealer_code", label: "Code" },
    {
      key: "dealer_name",
      label: "Dealer",
      render: (row) => (
        <span className={row.dealer_code === selectedDealer?.dealer_code ? "dealer-crm-config__row-label--selected" : ""}>
          {row.dealer_name}
        </span>
      ),
    },
    { key: "region", label: "Region", render: (row) => <Badge tone="info" fixed>{row.region || "—"}</Badge> },
    { key: "integration_type", label: "Mode", render: (row) => integrationTypeBadge(row.integration_type) },
  ];

  const logColumns = [
    { key: "created_at", label: "Time" },
    { key: "direction", label: "Direction" },
    { key: "operation", label: "Operation" },
    { key: "zoho_lead_id", label: "Zoho Lead" },
    { key: "external_lead_id", label: "External Lead", render: (row) => row.external_lead_id || "—" },
    { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
    { key: "http_status", label: "HTTP" },
    {
      key: "error_message",
      label: "Error",
      render: (row) =>
        row.status === "FAILED" ? (
          <div className="dealer-crm-config__log-error">
            <span>{row.error_message || "—"}</span>
            <button type="button" className="dealer-crm-config__retry-link" onClick={() => handleRetrySync(row)}>
              Retry
            </button>
          </div>
        ) : (
          row.error_message || "—"
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

  return (
    <div className="dealer-crm-config">
      <div className="dealer-crm-config__layout">
        {/* ---------- Left: dealer picker ---------- */}
        <div className="dealer-crm-config__panel dealer-crm-config__panel--list">
          <div className="dealer-crm-config__panel-header">
            <span className="dealer-crm-config__panel-icon">
              <Plug size={16} />
            </span>
            <h3>Dealers</h3>
          </div>

          <div className="dealer-crm-config__search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, code, or region…"
            />
          </div>

          {dealersLoading ? (
            <TableSkeleton columnCount={dealerColumns.length} rowCount={6} />
          ) : (
            <Table
              columns={dealerColumns}
              rows={filteredDealers}
              loading={dealersLoading}
              emptyMessage="No dealers found"
              onRowClick={handleSelectDealer}
              showSerial={false}
            />
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
                            {testing ? "Testing…" : "Test Connection"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="dealer-crm-config__button--primary"
                          onClick={handleSave}
                          disabled={saving}
                        >
                          {saving ? "Saving…" : "Save Configuration"}
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
                            <input
                              value={mapping.source_field}
                              onChange={(e) => handleFieldMappingChange(index, "source_field", e.target.value)}
                              placeholder="customer_name"
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
                            className="dealer-crm-config__button--primary"
                            onClick={handleSave}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : "Save Field Mapping"}
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
                        </div>
                        {statusMappings.map((mapping, index) => (
                          <div className="dealer-crm-config__mapping-row dealer-crm-config__mapping-row--status" key={index}>
                            <span className="dealer-crm-config__status-source">{mapping.source_status}</span>
                            <span className="dealer-crm-config__mapping-arrow">→</span>
                            <input
                              value={mapping.target_status}
                              onChange={(e) => handleStatusMappingChange(index, "target_status", e.target.value)}
                              placeholder="e.g. OPEN, IN_PROGRESS, HOT…"
                            />
                          </div>
                        ))}

                        <div className="dealer-crm-config__actions">
                          <button
                            type="button"
                            className="dealer-crm-config__button--primary"
                            onClick={handleSave}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : "Save Status Mapping"}
                          </button>
                        </div>
                      </div>
                    )
                  )}

                  {tab === "logs" && (
                    <Table
                      columns={logColumns}
                      rows={logs}
                      loading={logsLoading}
                      emptyMessage="No integration activity yet"
                      showSerial={false}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}