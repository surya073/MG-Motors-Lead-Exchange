import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { ROUTES } from "../../constants/routes.constants";
// Single source of truth for what each Happy/Unhappy scenario code means —
// still owned by Overview.jsx (its path cards need it too), re-used here
// only for the error-type filter dropdown below.
import { SCENARIO_META } from "../Overview/Overview";
import "./IntegrationsPage.css";

/**
 * IntegrationsPage.jsx
 * -----------------------------------------------------------------------
 * The integration-error/details experience, moved here from Overview's
 * "Lead Exchange Overview" panel so the dashboard can stay a clean,
 * executive-level summary with just a "View Integration" entry point.
 * Nothing about the data or API calls changed — this is the exact same
 * DateRangeFilterBar + ErrorReportTable that used to render inline,
 * now with their own page and their own date-range/dealer filter state
 * (independent of Overview's, the same way every other admin page here
 * owns its own filters).
 */

const SEVERITY_META = {
  P1: { label: "Critical", tone: "danger" },
  P2: { label: "Warning", tone: "warning" },
  P3: { label: "Low", tone: "info" },
};

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

/** Computes {from, to} (YYYY-MM-DD) for a preset key; null for 'custom'. */
function computePresetRange(key) {
  const now = new Date();
  const todayStr = formatDateInput(now);

  switch (key) {
    case "today":
      return { from: todayStr, to: todayStr };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      const s = formatDateInput(y);
      return { from: s, to: s };
    }
    case "last7": {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { from: formatDateInput(start), to: todayStr };
    }
    case "last30": {
      const start = new Date(now);
      start.setDate(start.getDate() - 29);
      return { from: formatDateInput(start), to: todayStr };
    }
    case "thisMonth": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: formatDateInput(start), to: todayStr };
    }
    default:
      return null; // 'custom' — caller keeps whatever the user typed
  }
}

const DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 Days" },
  { key: "last30", label: "Last 30 Days" },
  { key: "thisMonth", label: "This Month" },
  { key: "custom", label: "Custom Range" },
];

/** Date range + dealer filter bar. Pure controlled UI — no data logic. */
function DateRangeFilterBar({ fromDate, toDate, dealerCode, dealers, preset, onChange, onApply, onReset }) {
  return (
    <div className="health-filterbar">
      <div className="health-filterbar__presets">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`health-filterbar__preset${preset === p.key ? " health-filterbar__preset--active" : ""}`}
            onClick={() => onChange({ preset: p.key })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="health-filterbar__row">
        <label className="health-filterbar__field">
          <span>From</span>
          <input
            type="date"
            value={fromDate || ""}
            max={toDate || undefined}
            onChange={(e) => onChange({ preset: "custom", fromDate: e.target.value })}
          />
        </label>
        <label className="health-filterbar__field">
          <span>To</span>
          <input
            type="date"
            value={toDate || ""}
            min={fromDate || undefined}
            onChange={(e) => onChange({ preset: "custom", toDate: e.target.value })}
          />
        </label>
        <label className="health-filterbar__field">
          <span>Dealer</span>
          <select value={dealerCode} onChange={(e) => onChange({ dealerCode: e.target.value })}>
            <option value="">All Dealers</option>
            {dealers.map((d) => (
              <option key={d.dealer_code} value={d.dealer_code}>{d.dealer_code} — {d.dealer_name}</option>
            ))}
          </select>
        </label>
        <div className="health-filterbar__actions">
          <button type="button" className="health-filterbar__apply" onClick={onApply}>Apply Filters</button>
          <button type="button" className="health-filterbar__reset" onClick={onReset}>Reset</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Integration Errors report — paginated, filterable by dealer / error
 * type / status, fed by GET /admin/integration-logs. Reacts to the
 * parent date range + dealer filter, plus its own local filters.
 */
function ErrorReportTable({ fromDate, toDate, dealerCode, dealers }) {
  const [page, setPage] = useState(1);
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dealerFilter, setDealerFilter] = useState("");
  const [data, setData] = useState({ logs: [], total: 0, pageSize: 25 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Reset to page 1 whenever any filter changes, so a stale page number
  // never points past the end of a newly-narrowed result set.
  useEffect(() => { setPage(1); }, [fromDate, toDate, dealerCode, scenarioFilter, statusFilter, dealerFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminDashboardService.getIntegrationLogs({
      fromDate,
      toDate,
      dealerCode: dealerFilter || dealerCode || undefined,
      scenarioCode: scenarioFilter || undefined,
      status: statusFilter || undefined,
      page,
      pageSize: 25,
    })
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err?.response?.data?.error || "Couldn't load the error report."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate, dealerCode, dealerFilter, scenarioFilter, statusFilter, page]);

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 25)));

  return (
    <div className="panel-card">
      <div className="panel-card__header">
        <h3>Integration Errors</h3>
        <div className="error-report__filters">
          <select value={dealerFilter} onChange={(e) => setDealerFilter(e.target.value)}>
            <option value="">All dealers</option>
            {dealers.map((d) => (
              <option key={d.dealer_code} value={d.dealer_code}>{d.dealer_code}</option>
            ))}
          </select>
          <select value={scenarioFilter} onChange={(e) => setScenarioFilter(e.target.value)}>
            <option value="">All error types</option>
            {Object.keys(SCENARIO_META).filter((k) => k.startsWith("Unhappy")).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Any status</option>
            <option value="FAILED">Failed</option>
            <option value="SUCCESS">Success</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="integrations-page__skeleton" />
      ) : error ? (
        <div className="overview__state overview__state--error">{error}</div>
      ) : data.logs.length === 0 ? (
        <p className="overview__empty-note">No integration activity found for the selected filters.</p>
      ) : (
        <>
          <div className="integrations-page__table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date/Time</th>
                  <th>Dealer</th>
                  <th>Lead</th>
                  <th>Integration</th>
                  <th>Error Type</th>
                  <th>Error Message</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => {
                  const severity = SEVERITY_META[log.priority] || null;
                  return (
                    <tr key={log.ROWID}>
                      <td className="mono">{log.date}</td>
                      <td>{log.dealerCode ? `${log.dealerCode}${log.dealerName ? ` — ${log.dealerName}` : ""}` : "—"}</td>
                      <td>{log.customerName || log.leadId || "—"}</td>
                      <td>{log.integration || "—"}</td>
                      <td>
                        {log.scenarioCode || "—"}
                        {severity && (
                          <span className={`status-pill status-pill--${severity.tone}`} style={{ marginLeft: 6 }}>
                            {severity.label}
                          </span>
                        )}
                      </td>
                      <td>{log.errorMessage || "—"}</td>
                      <td>
                        <span className={`status-pill status-pill--${log.status === "SUCCESS" ? "success" : "danger"}`}>
                          {log.status || "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-pagination">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span>Page {page} of {totalPages} · {data.total} result{data.total === 1 ? "" : "s"}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  const navigate = useNavigate();
  const [dealers, setDealers] = useState([]);
  const [preset, setPreset] = useState("last30");
  const initialRange = computePresetRange("last30");
  const [pendingFrom, setPendingFrom] = useState(initialRange.from);
  const [pendingTo, setPendingTo] = useState(initialRange.to);
  const [pendingDealer, setPendingDealer] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({
    fromDate: initialRange.from,
    toDate: initialRange.to,
    dealerCode: "",
  });

  useEffect(() => {
    adminDashboardService.listDealers().then(setDealers).catch(() => setDealers([]));
  }, []);

  function handleFilterChange({ preset: newPreset, fromDate, toDate, dealerCode }) {
    if (newPreset) {
      setPreset(newPreset);
      const range = computePresetRange(newPreset);
      if (range) {
        setPendingFrom(range.from);
        setPendingTo(range.to);
      }
    }
    if (fromDate !== undefined) setPendingFrom(fromDate);
    if (toDate !== undefined) setPendingTo(toDate);
    if (dealerCode !== undefined) setPendingDealer(dealerCode);
  }

  function handleApply() {
    setAppliedFilters({ fromDate: pendingFrom, toDate: pendingTo, dealerCode: pendingDealer });
  }

  function handleReset() {
    const range = computePresetRange("last30");
    setPreset("last30");
    setPendingFrom(range.from);
    setPendingTo(range.to);
    setPendingDealer("");
    setAppliedFilters({ fromDate: range.from, toDate: range.to, dealerCode: "" });
  }

  return (
    <div className="integrations-page">
      <div className="integrations-page__header">
        <button type="button" className="integrations-page__back" onClick={() => navigate(ROUTES.DASHBOARD)}>
          <ArrowLeft size={15} />
          Back to Overview
        </button>
        <div className="integrations-page__title">
          <span className="integrations-page__icon">
            <AlertTriangle size={18} />
          </span>
          <div>
            <h1>Integration Monitoring</h1>
            <p>Detailed error report and activity for every dealer integration event.</p>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card__header">
          <h3>Filters</h3>
          <span className="panel-card__meta">
            {appliedFilters.fromDate} → {appliedFilters.toDate}
            {appliedFilters.dealerCode ? ` · ${appliedFilters.dealerCode}` : ""}
          </span>
        </div>
        <DateRangeFilterBar
          fromDate={pendingFrom}
          toDate={pendingTo}
          dealerCode={pendingDealer}
          dealers={dealers}
          preset={preset}
          onChange={handleFilterChange}
          onApply={handleApply}
          onReset={handleReset}
        />
      </div>

      <ErrorReportTable
        fromDate={appliedFilters.fromDate}
        toDate={appliedFilters.toDate}
        dealerCode={appliedFilters.dealerCode}
        dealers={dealers}
      />
    </div>
  );
}
