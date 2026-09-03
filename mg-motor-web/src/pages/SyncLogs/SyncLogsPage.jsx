import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Building2, Car, X } from "lucide-react";
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

export default function SyncLogsPage() {
  const { showAlert } = useAlerts();

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [triggeredByFilter, setTriggeredByFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const [syncingDealers, setSyncingDealers] = useState(false);
  const [syncingLeads, setSyncingLeads] = useState(false);

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

  // Statuses / triggered-by values derived from actual log data — no
  // hardcoded picklist to drift out of sync.
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

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((log) => {
      const matchesType = !typeFilter || log.sync_type === typeFilter;
      const matchesStatus = !statusFilter || log.status === statusFilter;
      const matchesTriggeredBy = !triggeredByFilter || log.triggered_by === triggeredByFilter;
      const matchesSearch =
        !term ||
        [log.sync_type, log.sync_trigger, log.triggered_by, log.status]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(term));
      return matchesType && matchesStatus && matchesTriggeredBy && matchesSearch;
    });
  }, [logs, search, typeFilter, statusFilter, triggeredByFilter]);

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

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    resetPage();
  };

  const hasActiveFilters =
    Boolean(search) || Boolean(typeFilter) || Boolean(statusFilter) || Boolean(triggeredByFilter);

  const clearFilters = () => {
    setSearch("");
    setTypeFilter("");
    setStatusFilter("");
    setTriggeredByFilter("");
    resetPage();
  };

  const columns = [
    {
      key: "sync_type",
      label: "Type",
      render: (row) => (
        <Badge tone={SYNC_TYPE_TONES[row.sync_type] || "neutral"}>
          {row.sync_type === "Dealer_Sync"
            ? "Dealer Sync"
            : row.sync_type === "Lead_Sync"
            ? "Lead Sync"
            : row.sync_type}
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

      {/* Work on the Dealer module to update CRM status and improve the related workflow.
Validate the dealer status update flow and ensure the CRM data is handled correctly.
Explore the Google Drive ↔ Zoho WorkDrive middleware application flow.
Understand the sync architecture and identify the required integration workflow. */}

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

      <Table columns={columns} rows={pageRows} loading={loading} emptyMessage="No sync runs yet" />

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
    </div>
  );
}