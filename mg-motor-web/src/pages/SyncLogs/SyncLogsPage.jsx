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

// =========================================================
// SCENARIO CATALOG — the client's full Happy/Unhappy path matrix.
// =========================================================
const SCENARIO_CATALOG = {
  "happy-1": {
    path: "happy",
    number: 1,
    label: "New enquiry routed successfully",
    source: "OEM CRM",
    description: "New enquiry created in OEM CRM with status = 'Update Pending'. Fires via OEM webhook (or scheduled poll of records where Status = Update Pending). Mandatory fields present.",
    color: { bg: "var(--scenario-happy-1-bg)", text: "var(--scenario-happy-1-text)" },
  },
  "happy-2": {
    path: "happy",
    number: 2,
    label: "Dealer progresses enquiry (status sync)",
    source: "Dealer CRM",
    description: "Dealer CRM sends a receipt on accept, then subsequent status changes. Fires on dealer webhook per change, plus a daily scheduled reconcile pull.",
    color: { bg: "var(--scenario-happy-2-bg)", text: "var(--scenario-happy-2-text)" },
  },
  "happy-3": {
    path: "happy",
    number: 3,
    label: "Duplicate detected",
    source: "Middleware",
    description: "During ingest of a new enquiry. Dedupe rule matches an existing record: same Enq. ID (idempotent replay) OR match on email/mobile + name for the same dealer within the configured window.",
    color: { bg: "var(--scenario-happy-3-bg)", text: "var(--scenario-happy-3-text)" },
  },
  "happy-4": {
    path: "happy",
    number: 4,
    label: "Integration recovery (replay)",
    source: "Scheduler",
    description: "Connectivity is restored after an outage and queued messages exist. The retry/replay processor runs.",
    color: { bg: "var(--scenario-happy-4-bg)", text: "var(--scenario-happy-4-text)" },
  },
  "happy-5": {
    path: "happy",
    number: 5,
    label: "Data synchronisation (dealer → OEM)",
    source: "Dealer CRM",
    description: "Dealer updates customer/enquiry fields. Fires on dealer change event, plus daily scheduled pull.",
    color: { bg: "var(--scenario-happy-5-bg)", text: "var(--scenario-happy-5-text)" },
  },
  "unhappy-1": {
    path: "unhappy",
    number: 1,
    label: "API / integration failure",
    source: "Middleware",
    description: "During push to the dealer: adapter returns timeout, 5xx, or connection error (a recoverable failure).",
    color: { bg: "var(--scenario-unhappy-1-bg)", text: "var(--scenario-unhappy-1-text)" },
  },
  "unhappy-2": {
    path: "unhappy",
    number: 2,
    label: "Invalid / missing data",
    source: "Middleware",
    description: "During validation on ingest from OEM: a mandatory field is missing or a value fails format/business rules. NON-recoverable — no retry.",
    color: { bg: "var(--scenario-unhappy-2-bg)", text: "var(--scenario-unhappy-2-text)" },
  },
  "unhappy-3": {
    path: "unhappy",
    number: 3,
    label: "Dealer unavailable (after 24h retry)",
    source: "Scheduler",
    description: "Mapped dealer is inactive/unavailable and the retry window (24h) is exhausted.",
    color: { bg: "var(--scenario-unhappy-3-bg)", text: "var(--scenario-unhappy-3-text)" },
  },
  "unhappy-4": {
    path: "unhappy",
    number: 4,
    label: "Status update failure (dealer → OEM)",
    source: "Middleware",
    description: "A dealer update is received but the write to OEM fails (recoverable).",
    color: { bg: "var(--scenario-unhappy-4-bg)", text: "var(--scenario-unhappy-4-text)" },
  },
  "unhappy-5": {
    path: "unhappy",
    number: 5,
    label: "Wrong / rejected dealer mapping",
    source: "Middleware",
    description: "During routing: postcode resolves to no dealer, an ambiguous dealer, or an invalid postcode-to-dealer configuration.",
    color: { bg: "var(--scenario-unhappy-5-bg)", text: "var(--scenario-unhappy-5-text)" },
  },
  "unhappy-6": {
    path: "unhappy",
    number: 6,
    label: "Ownership conflict",
    source: "Middleware",
    description: "OEM and dealer independently update the same enquiry/field (concurrent edits).",
    color: { bg: "var(--scenario-unhappy-6-bg)", text: "var(--scenario-unhappy-6-text)" },
  },
  "unhappy-7": {
    path: "unhappy",
    number: 7,
    label: "Out-of-order events",
    source: "Middleware",
    description: "A status update arrives before the enquiry-created record exists.",
    color: { bg: "var(--scenario-unhappy-7-bg)", text: "var(--scenario-unhappy-7-text)" },
  },
  "unhappy-8": {
    path: "unhappy",
    number: 8,
    label: "Consent / privacy mismatch",
    source: "Middleware",
    description: "Consent/privacy data is incomplete or incorrect (e.g. Privacy Opt-In missing/mismatched) at OEM→dealer send or on dealer receipt.",
    color: { bg: "var(--scenario-unhappy-8-bg)", text: "var(--scenario-unhappy-8-text)" },
  },
  "unhappy-9": {
    path: "unhappy",
    number: 9,
    label: "Dealer rejects enquiry",
    source: "Dealer CRM",
    description: "Dealer marks the enquiry as rejected (spam/invalid). A rejection event is received.",
    color: { bg: "var(--scenario-unhappy-9-bg)", text: "var(--scenario-unhappy-9-text)" },
  },
  "unhappy-10": {
    path: "unhappy",
    number: 10,
    label: "SLA breach",
    source: "Scheduler",
    description: "Dealer received the enquiry but takes no action within 24 hours. The SLA monitor fires.",
    color: { bg: "var(--scenario-unhappy-10-bg)", text: "var(--scenario-unhappy-10-text)" },
  },
  "unhappy-11": {
    path: "unhappy",
    number: 11,
    label: "Partial transaction",
    source: "Middleware",
    description: "OEM records the enquiry successfully but the dealer creation fails, leaving a mismatch.",
    color: { bg: "var(--scenario-unhappy-11-bg)", text: "var(--scenario-unhappy-11-text)" },
  },
  "unhappy-12": {
    path: "unhappy",
    number: 12,
    label: "Dealer CRM migration / offboarding",
    source: "Scheduler",
    description: "Dealer changes CRM or leaves the network. Eligible enquiries = status NOT IN (Not Qualified, Lost, Dropped) AND age_in_days < 14.",
    color: { bg: "var(--scenario-unhappy-12-bg)", text: "var(--scenario-unhappy-12-text)" },
  },
};


// Sort key so bucket lists always render in a stable, sensible order:
// all Happy scenarios (by number) before all Unhappy ones (by number).
const catalogSortKey = (code) => {
  const info = SCENARIO_CATALOG[code];
  return (info.path === "happy" ? 0 : 1000) + info.number;
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
// A "failed" record isn't always a real failure. If a record's
// own error text says it was skipped because it matched an
// existing lead on Enq. ID / email / mobile, that's Happy-3
// (Duplicate detected) per the client's own scenario table — not
// an integration error.
// ---------------------------------------------------------
const DUPLICATE_KEYWORDS = [
  "duplicate",
  "already exists",
  "already exist",
  "existing lead",
  "existing record",
  "existing enquiry",
  "matched existing",
  "same email",
  "same mobile",
  "same phone",
  "email/mobile match",
  "email or mobile",
  "idempotent replay",
];

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
  {
    code: "unhappy-2",
    keywords: [
      "missing",
      "mandatory",
      "required field",
      "invalid",
      "dealer_code",
      "dealer code",
    ],
  },
  { code: "unhappy-1", keywords: ["timeout", "connection", "econnrefused", "5xx", "unavailable"] },
];

// Classifies ONE record-level error string into a scenario code.
// Duplicate signals win first (they're Happy-3, not a failure);
// otherwise the first matching keyword rule wins; otherwise it
// falls back to the generic integration-failure bucket.
const classifyErrorText = (text) => {
  const lower = (text || "").toLowerCase();
  if (DUPLICATE_KEYWORDS.some((kw) => lower.includes(kw))) return "happy-3";
  for (const { code, keywords } of UNHAPPY_KEYWORD_RULES) {
    if (keywords.some((kw) => lower.includes(kw))) return code;
  }
  return "unhappy-1";
};

// The backend field has been seen as both error_details (current,
// an array of {crm_record_id, error}) and error_message (legacy,
// a single string or JSON blob). Read whichever is present and
// normalize to a flat list of {recordId, text}.
const parseErrorEntries = (log) => {
  const raw = log?.error_details ?? log?.error_message;
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [{ recordId: null, text: String(raw) }];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((item) => {
    if (item && typeof item === "object") {
      return {
        recordId: item.crm_record_id || item.id || item.recordId || null,
        text: item.error || item.message || JSON.stringify(item),
      };
    }
    return { recordId: null, text: String(item) };
  });
};

// ---------------------------------------------------------
// Resolves a sync-log ROW into every distinct outcome it actually
// contains, each with a record count — e.g. "27 fetched" can mean
// 1 × Happy 1 (new lead), 2 × Unhappy 2 (missing Dealer_Code),
// 24 × Happy 3 (already existed, correctly skipped) all in one run.
// This replaces the old one-badge-per-row model, which forced a
// mixed run into a single misleading bucket.
// ---------------------------------------------------------
const parseStoredScenarioSummary = (log) => {
  const raw = (log?.happy_unhappy_path_name || "").trim();
  if (!raw) return null;

  const segments = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  const results = [];
  segments.forEach((segment) => {
    const match = /^(Happy|Unhappy)\s+(\d+)\s+x(\d+)$/i.exec(segment);
    if (!match) return;
    const code = `${match[1].toLowerCase()}-${match[2]}`;
    const info = SCENARIO_CATALOG[code];
    if (!info) return;
    results.push({
      code,
      info,
      count: Number(match[3]) || 1,
      recordIds: [],
      guessed: false,
    });
  });

  return results.length > 0
    ? results.sort((a, b) => catalogSortKey(a.code) - catalogSortKey(b.code))
    : null;
};

const resolveRowScenarios = (log) => {
  const stored = parseStoredScenarioSummary(log);
  if (stored) return stored;
  return resolveRowScenariosLegacy(log);
};

const resolveRowScenariosLegacy = (log) => {
  const explicitCode = normalizeScenarioCode(
    log?.scenario_code || log?.scenario || log?.path_code || log?.scenarioCode
  );
  if (explicitCode && SCENARIO_CATALOG[explicitCode]) {
    const total = Number(log.total_records_fetched) || 1;
    return [
      {
        code: explicitCode,
        info: SCENARIO_CATALOG[explicitCode],
        count: total,
        recordIds: [],
        guessed: false,
      },
    ];
  }

  const inserted = Number(log.records_inserted) || 0;
  const updated = Number(log.records_updated) || 0;
  const failed = Number(log.records_failed) || 0;
  const fetched = Number(log.total_records_fetched) || 0;

  const buckets = new Map();
  const addToBucket = (code, count, recordId) => {
    if (!SCENARIO_CATALOG[code] || count <= 0) return;
    const existing = buckets.get(code) || { count: 0, recordIds: [] };
    existing.count += count;
    if (recordId) existing.recordIds.push(recordId);
    buckets.set(code, existing);
  };

  const errorEntries = parseErrorEntries(log);
  errorEntries.forEach((entry) => addToBucket(classifyErrorText(entry.text), 1, entry.recordId));

  const unexplainedFailed = failed - errorEntries.length;
  if (unexplainedFailed > 0) addToBucket("unhappy-1", unexplainedFailed);

  if (inserted > 0) {
    const trigger = (log.sync_trigger || "").toLowerCase();
    addToBucket(trigger.includes("schedul") || trigger.includes("retry") ? "happy-4" : "happy-1", inserted);
  }

  if (updated > 0) {
    addToBucket(log.sync_type === "Dealer_Sync" ? "happy-5" : "happy-2", updated);
  }

  const accounted = inserted + updated + errorEntries.length + Math.max(unexplainedFailed, 0);
  const skipped = Math.max(fetched - accounted, 0);
  if (skipped > 0) addToBucket("happy-3", skipped);

  if (buckets.size === 0) {
    addToBucket(log.status === "Success" ? "happy-1" : "unhappy-1", fetched || 1);
  }

  return Array.from(buckets.entries())
    .map(([code, { count, recordIds }]) => ({
      code,
      info: SCENARIO_CATALOG[code],
      count,
      recordIds,
      guessed: true,
    }))
    .sort((a, b) => catalogSortKey(a.code) - catalogSortKey(b.code));
};

const shortText = (text, max = 78) =>
  !text ? "" : text.length > max ? `${text.slice(0, max - 1)}…` : text;

function ScenarioBadge({ scenario, showCount = true }) {
  const { path, number, label } = scenario.info;
  const { color } = scenario.info;
  return (
    <span
      className={`sync-logs__scenario-badge ${scenario.guessed ? "sync-logs__scenario-badge--guessed" : ""}`}
      style={{ backgroundColor: color.bg, color: color.text }}
      title={scenario.guessed ? `${label} (estimated from log data)` : label}
    >
      {path === "happy" ? "Happy" : "Unhappy"} {number}
      {showCount && scenario.count > 1 ? ` ×${scenario.count}` : ""}
    </span>
  );
}

// Table-cell version: shows outcome badges for the row. When a path
// filter is active (Happy/Unhappy tab), only badges matching that
// path are shown — a mixed row on the Happy tab shows just its
// happy badges, not the unhappy ones alongside them.
function ScenarioCell({ scenarios, filterPath = "all" }) {
  const visible = filterPath === "all" ? scenarios : scenarios.filter((s) => s.info.path === filterPath);
  const highlighted = visible.find((s) => s.info.path === "unhappy") || visible[0];
  return (
    <div className="sync-logs__scenario-cell">
      <div className="sync-logs__scenario-badges">
        {visible.map((s) => (
          <ScenarioBadge key={s.code} scenario={s} />
        ))}
      </div>
      {highlighted && (
        <span
          className="sync-logs__scenario-message"
          style={{
            backgroundColor: highlighted.info.color.bg,
            color: highlighted.info.color.text,
            borderLeftColor: highlighted.info.color.text,
          }}
          title={highlighted.info.description}
        >
          {shortText(highlighted.info.description)}
        </span>
      )}
    </div>
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

  // Inclusive by design: a mixed run genuinely contains both a happy
  // and an unhappy outcome, so it counts — and shows — under both
  // tabs. That's an accurate reflection of the run, not double
  // counting. "Happy" = "this run had at least one happy outcome",
  // "Unhappy" = "this run had at least one unhappy outcome".
  const pathCounts = useMemo(() => {
    const counts = { happy: 0, unhappy: 0 };
    logs.forEach((log) => {
      const scenarios = resolveRowScenarios(log);
      if (scenarios.some((s) => s.info.path === "happy")) counts.happy += 1;
      if (scenarios.some((s) => s.info.path === "unhappy")) counts.unhappy += 1;
    });
    return counts;
  }, [logs]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((log) => {
      const scenarios = resolveRowScenarios(log);
      const matchesType = !typeFilter || log.sync_type === typeFilter;
      const matchesStatus = !statusFilter || log.status === statusFilter;
      const matchesTriggeredBy = !triggeredByFilter || log.triggered_by === triggeredByFilter;
      const matchesPath = pathFilter === "all" || scenarios.some((s) => s.info.path === pathFilter);
      const matchesScenario = !scenarioFilter || scenarios.some((s) => s.code === scenarioFilter);
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
      render: (row) => <ScenarioCell scenarios={resolveRowScenarios(row)} filterPath={pathFilter} />,
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
        pathFilter === "unhappy" ? (
          <span className="sync-logs__cell-muted">—</span>
        ) : row.records_inserted ? (
          <Badge tone="success">{row.records_inserted}</Badge>
        ) : (
          row.records_inserted
        ),
    },
    {
      key: "records_updated",
      label: "Updated",
      render: (row) =>
        pathFilter === "unhappy" ? (
          <span className="sync-logs__cell-muted">—</span>
        ) : row.records_updated ? (
          <Badge tone="info">{row.records_updated}</Badge>
        ) : (
          row.records_updated
        ),
    },
    {
      key: "records_failed",
      label: "Failed",
      render: (row) =>
        pathFilter === "happy" ? (
          <span className="sync-logs__cell-muted">—</span>
        ) : row.records_failed ? (
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

  const selectedScenarios = useMemo(
    () => (selectedLog ? resolveRowScenarios(selectedLog) : []),
    [selectedLog]
  );
  const selectedErrorEntries = useMemo(
    () => (selectedLog ? parseErrorEntries(selectedLog) : []),
    [selectedLog]
  );
  const hasUnhappy = selectedScenarios.some((s) => s.info.path === "unhappy");
  const hasHappy = selectedScenarios.some((s) => s.info.path === "happy");
  const isMixedOutcome = hasUnhappy && hasHappy;

  const syncInfoFields = selectedLog
    ? [
        { icon: User, label: "Creator ID", value: selectedLog.CREATORID },
        { icon: Zap, label: "Sync Type", value: SYNC_TYPE_LABELS[selectedLog.sync_type] || selectedLog.sync_type },
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
                {selectedScenarios.map((s) => (
                  <ScenarioBadge key={s.code} scenario={s} />
                ))}
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
              {isMixedOutcome ? (
                <div className="sync-logs__scenario-breakdown">
                  <h4>
                    <Info size={15} /> This run had a mixed outcome — {selectedScenarios.length} distinct
                    result{selectedScenarios.length === 1 ? "" : "s"}
                  </h4>
                  {selectedScenarios.map((s) => (
                    <div
                      key={s.code}
                      className="sync-logs__scenario-breakdown-row"
                      style={{ borderLeftColor: s.info.color.text }}
                    >
                      <ScenarioBadge scenario={s} />
                      <span className="sync-logs__scenario-breakdown-desc">{s.info.description}</span>
                    </div>
                  ))}
                </div>
              ) : (
                selectedScenarios[0] && (
                  <div
                    className="sync-logs__path-banner"
                    style={{
                      backgroundColor: selectedScenarios[0].info.color.bg,
                      borderColor: selectedScenarios[0].info.color.text,
                    }}
                  >
                    <span
                      className="sync-logs__path-banner-icon"
                      style={{ backgroundColor: "rgba(255,255,255,0.55)", color: selectedScenarios[0].info.color.text }}
                    >
                      {selectedScenarios[0].info.path === "happy" ? (
                        <CheckCircle2 size={22} />
                      ) : (
                        <AlertTriangle size={22} />
                      )}
                    </span>
                    <div className="sync-logs__path-banner-text">
                      <h3 style={{ color: selectedScenarios[0].info.color.text }}>
                        {selectedScenarios[0].info.path === "happy" ? "Happy" : "Unhappy"}{" "}
                        {selectedScenarios[0].info.number} — {selectedScenarios[0].info.label}
                      </h3>
                      <p>{selectedScenarios[0].info.description}</p>
                    </div>
                    <span
                      className="sync-logs__path-banner-decor"
                      style={{ color: selectedScenarios[0].info.color.text }}
                    >
                      {selectedScenarios[0].info.path === "happy" ? (
                        <FileCheck2 size={44} />
                      ) : (
                        <FileWarning size={44} />
                      )}
                    </span>
                  </div>
                )
              )}

              <div className="sync-logs__offcanvas-tabs" role="tablist">
                {DETAIL_TABS.map((tab) => {
                  const count =
                    tab.key === "records"
                      ? selectedLog.total_records_fetched
                      : tab.key === "errors"
                      ? selectedErrorEntries.length
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
                    <Database size={15} /> Outcome breakdown
                  </h4>
                  <div className="sync-logs__scenario-breakdown">
                    {selectedScenarios.map((s) => (
                      <div
                        key={s.code}
                        className="sync-logs__scenario-breakdown-row"
                        style={{ borderLeftColor: s.info.color.text }}
                      >
                        <ScenarioBadge scenario={s} />
                        <span className="sync-logs__scenario-breakdown-desc">{s.info.description}</span>
                      </div>
                    ))}
                  </div>
                  <p className="sync-logs__detail-note">
                    Row-level record IDs are only available for failed records (see Error Details) — the
                    rest is derived from the run's aggregate counts.
                  </p>
                </section>
              )}

              {activeTab === "errors" && (
                <section className="sync-logs__detail-section">
                  <h4>
                    <AlertTriangle size={15} /> Error Details
                  </h4>
                  {selectedErrorEntries.length === 0 ? (
                    <div className="sync-logs__empty-state">
                      <CheckCircle2 size={20} />
                      No errors were recorded for this sync run.
                    </div>
                  ) : (
                    selectedErrorEntries.map((entry, idx) => {
                      const code = classifyErrorText(entry.text);
                      const info = SCENARIO_CATALOG[code];
                      return (
                        <div key={idx} className="sync-logs__error-entry" style={{ borderLeftColor: info.color.text }}>
                          <div className="sync-logs__error-entry-head">
                            <ScenarioBadge scenario={{ code, info, count: 1, guessed: true }} showCount={false} />
                            {entry.recordId && (
                              <span className="sync-logs__error-entry-id">Record {entry.recordId}</span>
                            )}
                          </div>
                          <pre className="sync-logs__error-block">{entry.text}</pre>
                        </div>
                      );
                    })
                  )}
                </section>
              )}
            </div>

            <div className="sync-logs__offcanvas-footer">
              <span className="sync-logs__offcanvas-footnote">
                <Info size={14} />
                {footnote}
              </span>
              {hasUnhappy && (
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