import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Building2,
  Car,
  X,
  Link2,
  CheckCircle2,
  AlertTriangle,
  FileCheck2,
  FileWarning,
  Info,
  Database,
  User,
  Calendar,
  Clock,
  Hash,
  Zap,
  Activity,
} from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { syncDealersService, syncLeadsService } from "../../services/api/syncService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import { useAlerts } from "../../ui/Alerts/Alerts";
import "./SyncLogsPage.css";

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

const SYNC_TYPE_OPTIONS = [
  { value: "", label: "All sync types" },
  { value: "Dealer_Sync", label: "Dealer Sync" },
  { value: "Lead_Sync", label: "Lead Sync" },
];

const STATUS_TONES = {
  Success: "success",
  Partial: "warning",
  Failed: "danger",
};

const SYNC_TYPE_TONES = {
  Dealer_Sync: "info",
  Lead_Sync: "neutral",
};

const SYNC_TYPE_LABELS = {
  Dealer_Sync: "Dealer Sync",
  Lead_Sync: "Lead Sync",
};

const HAPPY_STATUSES = new Set(["Success"]);
const classifyPath = (status) => (HAPPY_STATUSES.has(status) ? "happy" : "unhappy");

// =========================================================
// SCENARIO CATALOG — the client's full Happy/Unhappy path matrix.
// =========================================================
const SCENARIO_CATALOG = {
  "happy-1": {
    path: "happy",
    number: 1,
    label: "New enquiry routed successfully",
    source: "OEM CRM",
    description:
      "New enquiry created in OEM CRM with status = 'Update Pending'. Fires via OEM webhook (or scheduled poll of records where Status = Update Pending). Mandatory fields present.",
    color: { bg: "#dcfce7", text: "#16a34a" },
  },
  "happy-2": {
    path: "happy",
    number: 2,
    label: "Dealer progresses enquiry (status sync)",
    source: "Dealer CRM",
    description:
      "Dealer CRM sends a receipt on accept, then subsequent status changes. Fires on dealer webhook per change, plus a daily scheduled reconcile pull.",
    color: { bg: "#ccfbf1", text: "#0d9488" },
  },
  "happy-3": {
    path: "happy",
    number: 3,
    label: "Duplicate detected",
    source: "Middleware",
    description:
      "During ingest of a new enquiry. Dedupe rule matches an existing record: same Enq. ID (idempotent replay) OR match on email/mobile + name for the same dealer within the configured window.",
    color: { bg: "#cffafe", text: "#0891b2" },
  },
  "happy-4": {
    path: "happy",
    number: 4,
    label: "Integration recovery (replay)",
    source: "Scheduler",
    description:
      "Connectivity is restored after an outage and queued messages exist. The retry/replay processor runs.",
    color: { bg: "#dbeafe", text: "#2563eb" },
  },
  "happy-5": {
    path: "happy",
    number: 5,
    label: "Data synchronisation (dealer → OEM)",
    source: "Dealer CRM",
    description:
      "Dealer updates customer/enquiry fields. Fires on dealer change event, plus daily scheduled pull.",
    color: { bg: "#d1fae5", text: "#059669" },
  },
  "unhappy-1": {
    path: "unhappy",
    number: 1,
    label: "API / integration failure",
    source: "Middleware",
    description:
      "During push to the dealer: adapter returns timeout, 5xx, or connection error (a recoverable failure).",
    color: { bg: "#fee2e2", text: "#dc2626" },
  },
  "unhappy-2": {
    path: "unhappy",
    number: 2,
    label: "Invalid / missing data",
    source: "Middleware",
    description:
      "During validation on ingest from OEM: a mandatory field is missing or a value fails format/business rules. NON-recoverable — no retry.",
    color: { bg: "#ffe4e6", text: "#e11d48" },
  },
  "unhappy-3": {
    path: "unhappy",
    number: 3,
    label: "Dealer unavailable (after 24h retry)",
    source: "Scheduler",
    description: "Mapped dealer is inactive/unavailable and the retry window (24h) is exhausted.",
    color: { bg: "#ffedd5", text: "#ea580c" },
  },
  "unhappy-4": {
    path: "unhappy",
    number: 4,
    label: "Status update failure (dealer → OEM)",
    source: "Middleware",
    description: "A dealer update is received but the write to OEM fails (recoverable).",
    color: { bg: "#fef3c7", text: "#d97706" },
  },
  "unhappy-5": {
    path: "unhappy",
    number: 5,
    label: "Wrong / rejected dealer mapping",
    source: "Middleware",
    description:
      "During routing: postcode resolves to no dealer, an ambiguous dealer, or an invalid postcode-to-dealer configuration.",
    color: { bg: "#fce7f3", text: "#db2777" },
  },
  "unhappy-6": {
    path: "unhappy",
    number: 6,
    label: "Ownership conflict",
    source: "Middleware",
    description: "OEM and dealer independently update the same enquiry/field (concurrent edits).",
    color: { bg: "#fae8ff", text: "#c026d3" },
  },
  "unhappy-7": {
    path: "unhappy",
    number: 7,
    label: "Out-of-order events",
    source: "Middleware",
    description: "A status update arrives before the enquiry-created record exists.",
    color: { bg: "#fee2e2", text: "#7f1d1d" },
  },
  "unhappy-8": {
    path: "unhappy",
    number: 8,
    label: "Consent / privacy mismatch",
    source: "Middleware",
    description:
      "Consent/privacy data is incomplete or incorrect (e.g. Privacy Opt-In missing/mismatched) at OEM→dealer send or on dealer receipt.",
    color: { bg: "#ede9fe", text: "#7c3aed" },
  },
  "unhappy-9": {
    path: "unhappy",
    number: 9,
    label: "Dealer rejects enquiry",
    source: "Dealer CRM",
    description: "Dealer marks the enquiry as rejected (spam/invalid). A rejection event is received.",
    color: { bg: "#ffedd5", text: "#9a3412" },
  },
  "unhappy-10": {
    path: "unhappy",
    number: 10,
    label: "SLA breach",
    source: "Scheduler",
    description: "Dealer received the enquiry but takes no action within 24 hours. The SLA monitor fires.",
    color: { bg: "#ffe4e6", text: "#be123c" },
  },
  "unhappy-11": {
    path: "unhappy",
    number: 11,
    label: "Partial transaction",
    source: "Middleware",
    description:
      "OEM records the enquiry successfully but the dealer creation fails, leaving a mismatch.",
    color: { bg: "#fef3c7", text: "#92400e" },
  },
  "unhappy-12": {
    path: "unhappy",
    number: 12,
    label: "Dealer CRM migration / offboarding",
    source: "Scheduler",
    description:
      "Dealer changes CRM or leaves the network. Eligible enquiries = status NOT IN (Not Qualified, Lost, Dropped) AND age_in_days < 14.",
    color: { bg: "#f1f5f9", text: "#475569" },
  },
};

const SCENARIO_LIST = Object.entries(SCENARIO_CATALOG).map(([code, info]) => ({ code, ...info }));

const PATH_FILTER_OPTIONS = [
  { value: "all", label: "All runs" },
  { value: "happy", label: "Happy" },
  { value: "unhappy", label: "Unhappy" },
];

const DETAIL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "records", label: "Records" },
  { key: "errors", label: "Error Details" },
];

const normalizeScenarioCode = (raw) => {
  if (!raw) return null;
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
};

// ---------------------------------------------------------
// Best-effort guess used only when a log has no explicit
// scenario_code tagged on it. Uses whatever signal is already on
// the aggregate sync_logs row (trigger, counts, error text). This
// is an inference, not ground truth — the backend should tag
// scenario_code directly the moment it can, which always takes
// priority over this guess (see resolveScenario below).
// ---------------------------------------------------------
const guessHappyCode = (log) => {
  const trigger = (log.sync_trigger || "").toLowerCase();
  const inserted = Number(log.records_inserted) || 0;
  const updated = Number(log.records_updated) || 0;
  const fetched = Number(log.total_records_fetched) || 0;
  const skipped = Math.max(fetched - inserted - updated, 0);

  if (skipped > 0 && fetched > 0) return "happy-3"; // fetched but neither inserted nor updated → likely deduped/skipped
  if (trigger.includes("schedul") || trigger.includes("retry") || trigger.includes("replay")) return "happy-4";
  if (log.sync_type === "Dealer_Sync" && updated > 0) return "happy-5";
  if (trigger.includes("webhook") && inserted > 0) return "happy-1";
  if (trigger.includes("webhook") && updated > 0) return "happy-2";
  if (inserted > 0) return "happy-1";
  if (updated > 0) return "happy-2";
  return "happy-1";
};

const UNHAPPY_KEYWORD_RULES = [
  { code: "unhappy-3", keywords: ["dealer unavailable", "inactive dealer", "dealer inactive"] },
  { code: "unhappy-4", keywords: ["write to oem", "oem update failed", "oem write failed"] },
  { code: "unhappy-5", keywords: ["postcode", "dealer mapping", "ambiguous dealer", "no dealer"] },
  { code: "unhappy-6", keywords: ["conflict", "concurrent"] },
  { code: "unhappy-7", keywords: ["out of order", "out-of-order", "sequence"] },
  { code: "unhappy-8", keywords: ["consent", "privacy", "opt-in", "opt in"] },
  { code: "unhappy-9", keywords: ["reject", "spam"] },
  { code: "unhappy-10", keywords: ["sla", "24 hour", "24h", "no action"] },
  { code: "unhappy-11", keywords: ["partial transaction", "mismatch"] },
  { code: "unhappy-12", keywords: ["migration", "offboard"] },
  { code: "unhappy-2", keywords: ["missing", "mandatory", "required field", "invalid"] },
  { code: "unhappy-1", keywords: ["timeout", "connection", "econnrefused", "5xx", "unavailable"] },
];

const guessUnhappyCode = (log) => {
  const text = (log.error_message || "").toLowerCase();
  for (const { code, keywords } of UNHAPPY_KEYWORD_RULES) {
    if (keywords.some((kw) => text.includes(kw))) return code;
  }
  return "unhappy-1";
};

// Prefers an explicit scenario_code tagged on the log by the backend;
// falls back to the heuristic guess above when absent, so every log
// always resolves to a specific numbered scenario.
const resolveScenario = (log) => {
  const raw = log?.scenario_code || log?.scenario || log?.path_code || log?.scenarioCode;
  const explicitCode = normalizeScenarioCode(raw);
  const hasExplicit = Boolean(explicitCode && SCENARIO_CATALOG[explicitCode]);
  const path = classifyPath(log?.status);
  const code = hasExplicit ? explicitCode : path === "happy" ? guessHappyCode(log) : guessUnhappyCode(log);
  const info = SCENARIO_CATALOG[code];
  return { code, info, path: info.path, guessed: !hasExplicit };
};

const shortText = (text, max = 78) =>
  !text ? "" : text.length > max ? `${text.slice(0, max - 1)}…` : text;

function ScenarioBadge({ resolved }) {
  const { path, number, label, color } = resolved.info;
  return (
    <span
      className={`sync-logs__scenario-badge ${resolved.guessed ? "sync-logs__scenario-badge--guessed" : ""}`}
      style={{ backgroundColor: color.bg, color: color.text }}
      title={resolved.guessed ? `${label} (estimated from log data)` : label}
    >
      {path === "happy" ? "Happy" : "Unhappy"} {number}
    </span>
  );
}

function ScenarioMessage({ resolved }) {
  const { color, description } = resolved.info;
  return (
    <span
      className="sync-logs__scenario-message"
      style={{ backgroundColor: color.bg, color: color.text, borderLeftColor: color.text }}
      title={description}
    >
      {shortText(description)}
    </span>
  );
}

export default function SyncLogsPage() {
  const { showAlert } = useAlerts();

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [triggeredByFilter, setTriggeredByFilter] = useState("");
  const [pathFilter, setPathFilter] = useState("all");
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const [syncingDealers, setSyncingDealers] = useState(false);
  const [syncingLeads, setSyncingLeads] = useState(false);

  const [selectedLog, setSelectedLog] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");

  const loadLogs = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await adminDashboardService.syncLogs();
      setLogs(result);
    } catch (err) {
      const message = err?.response?.data?.error || "Couldn't load sync logs. Try again.";
      setLoadError(message);
      showAlert("error", message, { title: "Load failed" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedLog) return undefined;
    setActiveTab("overview");
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setSelectedLog(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedLog]);

  const handleSyncDealers = async () => {
    setSyncingDealers(true);
    try {
      const result = await syncDealersService();
      const removedNote = result.recordsRemoved ? `, ${result.recordsRemoved} removed` : "";
      showAlert(
        "success",
        `${result.recordsInserted} new, ${result.recordsUpdated} updated${removedNote}.`,
        { title: "Dealer sync complete" }
      );
      await loadLogs();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Dealer sync failed. Try again.", {
        title: "Dealer sync failed",
      });
    } finally {
      setSyncingDealers(false);
    }
  };

  const handleSyncLeads = async () => {
    setSyncingLeads(true);
    try {
      const result = await syncLeadsService();
      const removedNote = result.recordsRemoved ? `, ${result.recordsRemoved} removed` : "";
      showAlert(
        "success",
        `${result.recordsInserted} new, ${result.recordsUpdated} updated${removedNote}.`,
        { title: "Lead sync complete" }
      );
      await loadLogs();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Lead sync failed. Try again.", {
        title: "Lead sync failed",
      });
    } finally {
      setSyncingLeads(false);
    }
  };

  const handleRetryFromDetail = async () => {
    if (!selectedLog) return;
    const isDealerSync = selectedLog.sync_type === "Dealer_Sync";
    setSelectedLog(null);
    if (isDealerSync) await handleSyncDealers();
    else await handleSyncLeads();
  };

  const statuses = useMemo(
    () => [...new Set(logs.map((l) => l.status).filter(Boolean))].sort(),
    [logs]
  );

  const triggeredByValues = useMemo(
    () => [...new Set(logs.map((l) => l.triggered_by).filter(Boolean))].sort(),
    [logs]
  );

  const statusOptions = useMemo(
    () => [{ value: "", label: "All statuses" }, ...statuses.map((s) => ({ value: s, label: s }))],
    [statuses]
  );

  const triggeredByOptions = useMemo(
    () => [
      { value: "", label: "Anyone" },
      ...triggeredByValues.map((t) => ({ value: t, label: t })),
    ],
    [triggeredByValues]
  );

  const pageSizeOptions = useMemo(
    () => PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
    []
  );

  const scenarioOptions = useMemo(() => {
    const relevant = SCENARIO_LIST.filter((s) => pathFilter === "all" || s.path === pathFilter);
    return [
      { value: "", label: pathFilter === "all" ? "All scenarios" : `All ${pathFilter} scenarios` },
      ...relevant.map((s) => ({
        value: s.code,
        label: `${s.path === "happy" ? "Happy" : "Unhappy"} ${s.number} — ${s.label}`,
      })),
    ];
  }, [pathFilter]);

  const pathCounts = useMemo(() => {
    const counts = { happy: 0, unhappy: 0 };
    logs.forEach((log) => {
      counts[resolveScenario(log).path] += 1;
    });
    return counts;
  }, [logs]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((log) => {
      const resolved = resolveScenario(log);
      const matchesType = !typeFilter || log.sync_type === typeFilter;
      const matchesStatus = !statusFilter || log.status === statusFilter;
      const matchesTriggeredBy = !triggeredByFilter || log.triggered_by === triggeredByFilter;
      const matchesPath = pathFilter === "all" || resolved.path === pathFilter;
      const matchesScenario = !scenarioFilter || resolved.code === scenarioFilter;
      const matchesSearch =
        !term ||
        [log.sync_type, log.sync_trigger, log.triggered_by, log.status]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(term));
      return (
        matchesType &&
        matchesStatus &&
        matchesTriggeredBy &&
        matchesPath &&
        matchesScenario &&
        matchesSearch
      );
    });
  }, [logs, search, typeFilter, statusFilter, triggeredByFilter, pathFilter, scenarioFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageRows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const resetPage = () => setPageIndex(0);

  const handleSearchChange = (value) => {
    setSearch(value);
    resetPage();
  };

  const handleTypeChange = (value) => {
    setTypeFilter(value);
    resetPage();
  };

  const handleStatusChange = (value) => {
    setStatusFilter(value);
    resetPage();
  };

  const handleTriggeredByChange = (value) => {
    setTriggeredByFilter(value);
    resetPage();
  };

  const handlePathFilterChange = (value) => {
    setPathFilter(value);
    setScenarioFilter("");
    resetPage();
  };

  const handleScenarioFilterChange = (value) => {
    setScenarioFilter(value);
    resetPage();
  };

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    resetPage();
  };

  const hasActiveFilters =
    Boolean(search) ||
    Boolean(typeFilter) ||
    Boolean(statusFilter) ||
    Boolean(triggeredByFilter) ||
    pathFilter !== "all" ||
    Boolean(scenarioFilter);

  const clearFilters = () => {
    setSearch("");
    setTypeFilter("");
    setStatusFilter("");
    setTriggeredByFilter("");
    setPathFilter("all");
    setScenarioFilter("");
    resetPage();
  };

  const columns = [
    {
      key: "scenario",
      label: "Scenario",
      render: (row) => {
        const resolved = resolveScenario(row);
        return (
          <div className="sync-logs__scenario-cell">
            <ScenarioBadge resolved={resolved} />
            <ScenarioMessage resolved={resolved} />
          </div>
        );
      },
    },
    {
      key: "sync_type",
      label: "Type",
      render: (row) => (
        <Badge tone={SYNC_TYPE_TONES[row.sync_type] || "neutral"}>
          {SYNC_TYPE_LABELS[row.sync_type] || row.sync_type}
        </Badge>
      ),
    },
    { key: "sync_trigger", label: "Trigger" },
    { key: "total_records_fetched", label: "Fetched" },
    {
      key: "records_inserted",
      label: "Inserted",
      render: (row) =>
        row.records_inserted ? <Badge tone="success">{row.records_inserted}</Badge> : row.records_inserted,
    },
    {
      key: "records_updated",
      label: "Updated",
      render: (row) =>
        row.records_updated ? <Badge tone="info">{row.records_updated}</Badge> : row.records_updated,
    },
    {
      key: "records_failed",
      label: "Failed",
      render: (row) =>
        row.records_failed ? (
          <Badge tone="danger">{row.records_failed}</Badge>
        ) : (
          <Badge tone="neutral">0</Badge>
        ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => <Badge tone={STATUS_TONES[row.status] || "neutral"}>{row.status}</Badge>,
    },
    {
      key: "triggered_by",
      label: "Triggered by",
      render: (row) => <Badge tone="neutral">{row.triggered_by || "System"}</Badge>,
    },
    { key: "start_time", label: "Started" },
    { key: "end_time", label: "Finished" },
  ];

  const anySyncing = syncingDealers || syncingLeads;

  const parsedErrors = useMemo(() => {
    if (!selectedLog?.error_message) return [];
    try {
      const parsed = JSON.parse(selectedLog.error_message);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [{ error: selectedLog.error_message }];
    }
  }, [selectedLog]);

  const resolvedSelected = selectedLog ? resolveScenario(selectedLog) : null;
  const path = resolvedSelected ? resolvedSelected.path : "happy";
  const bannerHeading = resolvedSelected
    ? `${resolvedSelected.path === "happy" ? "Happy" : "Unhappy"} ${resolvedSelected.info.number} — ${
        resolvedSelected.info.label
      }`
    : "";
  const bannerMessage = resolvedSelected ? resolvedSelected.info.description : "";
  const bannerColor = resolvedSelected ? resolvedSelected.info.color : { bg: "#f0fdf4", text: "#16a34a" };

  const syncInfoFields = selectedLog
    ? [
        { icon: User, label: "Creator ID", value: selectedLog.CREATORID },
        { icon: Zap, label: "Sync Type", value: SYNC_TYPE_LABELS[selectedLog.sync_type] || selectedLog.sync_type },
        {
          icon: Activity,
          label: "Trigger Source",
          value: resolvedSelected?.info?.source || selectedLog.triggered_by,
        },
        { icon: RefreshCw, label: "Sync Trigger", value: selectedLog.sync_trigger },
        { icon: CheckCircle2, label: "Status", value: selectedLog.status, badge: true },
      ].filter((f) => f.value !== undefined && f.value !== null && f.value !== "")
    : [];

  const timeFields = selectedLog
    ? [
        { icon: Calendar, label: "Start Time", value: selectedLog.start_time },
        { icon: Calendar, label: "End Time", value: selectedLog.end_time },
        { icon: Clock, label: "Modified Time", value: selectedLog.MODIFIEDTIME },
        { icon: Clock, label: "Created Time", value: selectedLog.CREATEDTIME },
        { icon: Hash, label: "ROWID", value: selectedLog.ROWID },
      ].filter((f) => f.value !== undefined && f.value !== null && f.value !== "")
    : [];

  const footnote = selectedLog
    ? `This sync was triggered ${
        selectedLog.sync_trigger === "Webhook"
          ? "automatically via webhook"
          : `via ${selectedLog.sync_trigger || "an unspecified trigger"}`
      }${selectedLog.triggered_by ? ` from ${selectedLog.triggered_by}` : ""}.`
    : "";

  return (
    <div className="sync-logs">
      <div className="sync-logs__header">
        <div className="sync-logs__actions">
          <button
            type="button"
            className="sync-logs__sync-btn sync-logs__sync-btn--dealers"
            onClick={handleSyncDealers}
            disabled={anySyncing}
          >
            {syncingDealers ? (
              <RefreshCw size={16} strokeWidth={2.5} className="sync-logs__sync-icon--spinning" />
            ) : (
              <Building2 size={16} strokeWidth={2} />
            )}
            {syncingDealers ? "Syncing…" : "Sync dealers"}
          </button>
          <button
            type="button"
            className="sync-logs__sync-btn sync-logs__sync-btn--leads"
            onClick={handleSyncLeads}
            disabled={anySyncing}
          >
            {syncingLeads ? (
              <RefreshCw size={16} strokeWidth={2.5} className="sync-logs__sync-icon--spinning" />
            ) : (
              <Car size={16} strokeWidth={2} />
            )}
            {syncingLeads ? "Syncing…" : "Sync leads"}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="sync-logs__notice sync-logs__notice--error">
          {loadError}
          <button
            type="button"
            className="sync-logs__notice-close"
            onClick={() => setLoadError(null)}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="sync-logs__path-toggle" role="tablist" aria-label="Filter by outcome">
        {PATH_FILTER_OPTIONS.map((option) => {
          const count =
            option.value === "happy"
              ? pathCounts.happy
              : option.value === "unhappy"
              ? pathCounts.unhappy
              : logs.length;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={pathFilter === option.value}
              className={`sync-logs__path-pill sync-logs__path-pill--${option.value} ${
                pathFilter === option.value ? "sync-logs__path-pill--active" : ""
              }`}
              onClick={() => handlePathFilterChange(option.value)}
            >
              {option.label}
              <span className="sync-logs__path-pill-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="sync-logs__filters">
        <div className="sync-logs__search">
          <input
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder="Search by type, trigger, status, or who ran it…"
          />
          {search && (
            <button
              type="button"
              className="sync-logs__search-clear"
              onClick={() => handleSearchChange("")}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <Dropdown
          ariaLabel="Filter by scenario"
          value={scenarioFilter}
          onChange={handleScenarioFilterChange}
          options={scenarioOptions}
        />

        <Dropdown
          ariaLabel="Filter by sync type"
          value={typeFilter}
          onChange={handleTypeChange}
          options={SYNC_TYPE_OPTIONS}
        />

        <Dropdown
          ariaLabel="Filter by status"
          value={statusFilter}
          onChange={handleStatusChange}
          options={statusOptions}
        />

        <Dropdown
          ariaLabel="Filter by triggered by"
          value={triggeredByFilter}
          onChange={handleTriggeredByChange}
          options={triggeredByOptions}
        />

        {hasActiveFilters && (
          <button type="button" className="sync-logs__clear-filters" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <Table
        columns={columns}
        rows={pageRows}
        loading={loading}
        emptyMessage="No sync runs yet"
        onRowClick={(row) => setSelectedLog(row)}
      />

      <div className="sync-logs__pagination">
        <div className="sync-logs__page-size">
          <span>Rows per page</span>
          <Dropdown
            ariaLabel="Rows per page"
            size="sm"
            value={String(pageSize)}
            onChange={handlePageSizeChange}
            options={pageSizeOptions}
          />
        </div>

        <div className="sync-logs__page-nav">
          <button onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={currentPage === 0}>
            Previous
          </button>
          <span>
            Page {currentPage + 1} of {pageCount} · {filtered.length} run{filtered.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
            disabled={currentPage >= pageCount - 1}
          >
            Next
          </button>
        </div>
      </div>

      {selectedLog && (
        <div className="sync-logs__offcanvas-backdrop" onClick={() => setSelectedLog(null)}>
          <div
            className="sync-logs__offcanvas"
            role="dialog"
            aria-modal="true"
            aria-label="Sync details"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sync-logs__offcanvas-header">
              <div className="sync-logs__offcanvas-header-left">
                <span className="sync-logs__offcanvas-icon">
                  <Link2 size={20} />
                </span>
                <div>
                  <h2>Sync Details</h2>
                  <p>View complete information about this CRM sync operation.</p>
                </div>
              </div>
              <div className="sync-logs__offcanvas-header-right">
                {resolvedSelected && <ScenarioBadge resolved={resolvedSelected} />}
                <Badge tone={STATUS_TONES[selectedLog.status] || "neutral"}>{selectedLog.status}</Badge>
                <button
                  type="button"
                  className="sync-logs__offcanvas-close"
                  onClick={() => setSelectedLog(null)}
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="sync-logs__offcanvas-body">
              <div
                className="sync-logs__path-banner"
                style={{ backgroundColor: bannerColor.bg, borderColor: bannerColor.text }}
              >
                <span
                  className="sync-logs__path-banner-icon"
                  style={{ backgroundColor: "rgba(255,255,255,0.55)", color: bannerColor.text }}
                >
                  {path === "happy" ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
                </span>
                <div className="sync-logs__path-banner-text">
                  <h3 style={{ color: bannerColor.text }}>{bannerHeading}</h3>
                  <p>{bannerMessage}</p>
                </div>
                <span className="sync-logs__path-banner-decor" style={{ color: bannerColor.text }}>
                  {path === "happy" ? <FileCheck2 size={44} /> : <FileWarning size={44} />}
                </span>
              </div>

              <div className="sync-logs__offcanvas-tabs" role="tablist">
                {DETAIL_TABS.map((tab) => {
                  const count =
                    tab.key === "records"
                      ? selectedLog.total_records_fetched
                      : tab.key === "errors"
                      ? parsedErrors.length
                      : null;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.key}
                      className={`sync-logs__offcanvas-tab ${
                        activeTab === tab.key ? "sync-logs__offcanvas-tab--active" : ""
                      }`}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      {tab.label}
                      {count !== null && count !== undefined && (
                        <span className="sync-logs__offcanvas-tab-count">{count}</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {activeTab === "overview" && (
                <>
                  <section className="sync-logs__detail-section">
                    <h4>
                      <Database size={15} /> Sync Information
                    </h4>
                    <div className="sync-logs__detail-grid">
                      {syncInfoFields.map((field) => (
                        <div className="sync-logs__detail-field" key={field.label}>
                          <span className="sync-logs__detail-field-icon">
                            <field.icon size={15} />
                          </span>
                          <div>
                            <span className="sync-logs__detail-field-label">{field.label}</span>
                            {field.badge ? (
                              <div>
                                <Badge tone={STATUS_TONES[field.value] || "neutral"}>{field.value}</Badge>
                              </div>
                            ) : (
                              <span className="sync-logs__detail-field-value">{field.value}</span>
                            )}
                          </div>
                        </div>
                      ))}
                      {timeFields.map((field) => (
                        <div className="sync-logs__detail-field" key={field.label}>
                          <span className="sync-logs__detail-field-icon">
                            <field.icon size={15} />
                          </span>
                          <div>
                            <span className="sync-logs__detail-field-label">{field.label}</span>
                            <span className="sync-logs__detail-field-value">{field.value}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="sync-logs__detail-section">
                    <h4>
                      <Link2 size={15} /> Sync Summary
                    </h4>
                    <div className="sync-logs__stat-grid">
                      <div className="sync-logs__stat">
                        <span className="sync-logs__stat-icon sync-logs__stat-icon--neutral">
                          <Database size={15} />
                        </span>
                        <span className="sync-logs__stat-label">Total Records</span>
                        <span className="sync-logs__stat-value">{selectedLog.total_records_fetched ?? 0}</span>
                      </div>
                      <div className="sync-logs__stat">
                        <span className="sync-logs__stat-icon sync-logs__stat-icon--success">
                          <CheckCircle2 size={15} />
                        </span>
                        <span className="sync-logs__stat-label">Inserted</span>
                        <span className="sync-logs__stat-value">{selectedLog.records_inserted ?? 0}</span>
                      </div>
                      <div className="sync-logs__stat">
                        <span className="sync-logs__stat-icon sync-logs__stat-icon--info">
                          <RefreshCw size={15} />
                        </span>
                        <span className="sync-logs__stat-label">Updated</span>
                        <span className="sync-logs__stat-value">{selectedLog.records_updated ?? 0}</span>
                      </div>
                      <div className="sync-logs__stat">
                        <span className="sync-logs__stat-icon sync-logs__stat-icon--danger">
                          <AlertTriangle size={15} />
                        </span>
                        <span className="sync-logs__stat-label">Failed</span>
                        <span className="sync-logs__stat-value">{selectedLog.records_failed ?? 0}</span>
                      </div>
                    </div>
                  </section>
                </>
              )}

              {activeTab === "records" && (
                <section className="sync-logs__detail-section">
                  <h4>
                    <Database size={15} /> Records processed
                  </h4>
                  <div className="sync-logs__stat-grid">
                    <div className="sync-logs__stat">
                      <span className="sync-logs__stat-icon sync-logs__stat-icon--neutral">
                        <Database size={15} />
                      </span>
                      <span className="sync-logs__stat-label">Fetched</span>
                      <span className="sync-logs__stat-value">{selectedLog.total_records_fetched ?? 0}</span>
                    </div>
                    <div className="sync-logs__stat">
                      <span className="sync-logs__stat-icon sync-logs__stat-icon--success">
                        <CheckCircle2 size={15} />
                      </span>
                      <span className="sync-logs__stat-label">Inserted</span>
                      <span className="sync-logs__stat-value">{selectedLog.records_inserted ?? 0}</span>
                    </div>
                    <div className="sync-logs__stat">
                      <span className="sync-logs__stat-icon sync-logs__stat-icon--info">
                        <RefreshCw size={15} />
                      </span>
                      <span className="sync-logs__stat-label">Updated</span>
                      <span className="sync-logs__stat-value">{selectedLog.records_updated ?? 0}</span>
                    </div>
                    <div className="sync-logs__stat">
                      <span className="sync-logs__stat-icon sync-logs__stat-icon--danger">
                        <AlertTriangle size={15} />
                      </span>
                      <span className="sync-logs__stat-label">Failed</span>
                      <span className="sync-logs__stat-value">{selectedLog.records_failed ?? 0}</span>
                    </div>
                  </div>
                  <p className="sync-logs__detail-note">
                    Row-level record detail isn't tracked on this sync log yet — these are the aggregate
                    counts from the run.
                  </p>
                </section>
              )}

              {activeTab === "errors" && (
                <section className="sync-logs__detail-section">
                  <h4>
                    <AlertTriangle size={15} /> Error Details
                  </h4>
                  {parsedErrors.length === 0 ? (
                    <div className="sync-logs__empty-state">
                      <CheckCircle2 size={20} />
                      No errors were recorded for this sync run.
                    </div>
                  ) : (
                    parsedErrors.map((err, idx) => (
                      <pre className="sync-logs__error-block" key={idx}>
                        {JSON.stringify(err, null, 2)}
                      </pre>
                    ))
                  )}
                </section>
              )}
            </div>

            <div className="sync-logs__offcanvas-footer">
              <span className="sync-logs__offcanvas-footnote">
                <Info size={14} />
                {footnote}
              </span>
              {path === "unhappy" && (
                <button
                  type="button"
                  className="sync-logs__retry-btn"
                  onClick={handleRetryFromDetail}
                  disabled={anySyncing}
                >
                  <RefreshCw size={16} className={anySyncing ? "sync-logs__sync-icon--spinning" : ""} />
                  Retry Sync
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}