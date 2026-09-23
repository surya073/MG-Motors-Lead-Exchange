import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutGrid,
  List,
  Store,
  Hash,
  Car,
  Megaphone,
  Phone,
  Mail,
  Calendar,
  Eye,
  MoreVertical,
  RefreshCw,
} from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { syncLeadsService } from "../../services/api/syncService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import Skeleton from "../../ui/Skeleton/Skeleton";
import LeadDetailView from "./LeadDetailView";
import { useAlerts } from "../../ui/Alerts/Alerts";
import "./LeadExchangePage.css";

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

const VIEW_STORAGE_KEY = "leadExchange:view";
const DETAIL_STORAGE_KEY = "leadExchange:detailId";

const STATUS_TONES = {
  "Not Contacted": "neutral",
  "Follow-up 1": "info",
  "Follow-up 2": "info",
  Contacted: "info",
  "Contact in Future": "warning",
  "In Progress": "warning",
  Converted: "success",
  "Not Qualified": "danger",
  Dropped: "danger",
  Lost: "danger",
  "Lost Lead": "danger",
  Rejected: "danger",
  "Dealer Unavailable": "danger",
  "Unattended Alert": "danger",
};

// Commercial outcomes such as Lost / Dropped / Not Qualified are valid
// Happy 2 status synchronisations. Only integration holds/failures and
// an explicit spam/junk rejection belong on the Unhappy side.
const UNHAPPY_LEAD_STATUSES = new Set([
  "Rejected",
  "Junk",
  "Junk Lead",
  "Spam",
  "Dealer Unavailable",
  "Unattended Alert",
]);

const UNHAPPY_SYNC_STATUSES = new Set([
  "VALIDATION_HOLD",
  "CONSENT_HOLD",
  "ROUTING_HOLD",
  "DELIVERY_FAILED",
  "FAILED_CRITICAL",
  "SLA_BREACH",
  "HELD",
]);

// A lead can be classified Unhappy purely from sync_status/lead_status when
// the stored scenario name has not been mirrored onto the row yet. Without
// this map those leads appeared in the Unhappy filter with no indication of
// WHICH path they were on, which is the first thing anyone asks.
const SYNC_STATUS_TO_PATH = {
  CONSENT_HOLD: "Unhappy 8",
  VALIDATION_HOLD: "Unhappy 2",
  ROUTING_HOLD: "Unhappy 5",
  DELIVERY_FAILED: "Unhappy 1",
  FAILED: "Unhappy 1",
  FAILED_CRITICAL: "Unhappy 3",
  SLA_BREACH: "Unhappy 10",
  HELD: "Unhappy 4",
  RECONCILE_MISMATCH: "Unhappy 11",
  DUPLICATE_LINKED: "Happy 3",
};

const LEAD_STATUS_TO_PATH = {
  "Unattended Alert": "Unhappy 10",
  "Dealer Unavailable": "Unhappy 3",
  "Junk Lead": "Unhappy 9",
  Junk: "Unhappy 9",
  Spam: "Unhappy 9",
  Rejected: "Unhappy 9",
};

const classifyLeadWithDuplicate = (lead) => {
  const storedPath = (lead.happy_unhappy_path_name || "").trim();
  const isDuplicate = lead.sync_status === "DUPLICATE_LINKED" || storedPath === "Happy 3";
  if (isDuplicate) {
    return { path: "happy", number: 3, isDuplicate: true, label: "Happy 3" };
  }

  const unhappy =
    /^Unhappy\s+/i.test(storedPath) ||
    UNHAPPY_SYNC_STATUSES.has(lead.sync_status) ||
    UNHAPPY_LEAD_STATUSES.has(lead.lead_status);

  // Prefer what the backend recorded; fall back to whatever the lead's
  // current hold state implies, so a card is never left unlabelled.
  const label =
    (/^(Happy|Unhappy)\s+\d+$/i.test(storedPath) && storedPath) ||
    SYNC_STATUS_TO_PATH[lead.sync_status] ||
    LEAD_STATUS_TO_PATH[lead.lead_status] ||
    (unhappy ? "Unhappy" : "");

  return { path: unhappy ? "unhappy" : "happy", isDuplicate: false, label };
};

const PATH_FILTER_OPTIONS = [
  { value: "all", label: "All leads" },
  { value: "happy", label: "Happy" },
  { value: "unhappy", label: "Unhappy" },
];

const ALL_COLUMNS = [
  { key: "customer_name", label: "Customer", defaultVisible: true },
  { key: "dealer_name", label: "Dealer", defaultVisible: true },
  { key: "dealer_code", label: "Dealer code", defaultVisible: false },
  { key: "vehicle_model", label: "Vehicle", defaultVisible: true },
  { key: "lead_source", label: "Source", defaultVisible: true },
  { key: "lead_status", label: "Status", defaultVisible: true },
  { key: "mobile_number", label: "Mobile", defaultVisible: false },
  { key: "email_address", label: "Email", defaultVisible: false },
  { key: "assigned_date", label: "Assigned", defaultVisible: false },
  { key: "last_status_update", label: "Last update", defaultVisible: false },
];

function cellText(value) {
  return value && String(value).trim() ? value : "—";
}

function initialsFor(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return parts.length === 1
    ? parts[0].charAt(0).toUpperCase()
    : (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** Skeleton placeholder matching the real lead-card's structure, shown
 * in place of "Loading…" text while the grid view's first fetch is in
 * flight — keeps the layout's shape stable instead of collapsing to a
 * single line of text. */
function LeadCardSkeleton() {
  return (
    <div className="lead-card lead-card--skeleton">
      <div className="lead-card__top">
        <div className="lead-card__identity">
          <Skeleton width={46} height={46} radius="50%" />
          <div>
            <Skeleton width={120} height={14} />
            <div style={{ marginTop: 6 }}>
              <Skeleton width={80} height={11} />
            </div>
          </div>
        </div>
        <Skeleton width={70} height={22} radius="var(--radius-full)" />
      </div>
      <div className="lead-card__body">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="lead-card__field" key={i}>
            <Skeleton width={32} height={32} radius="50%" />
            <div>
              <Skeleton width={50} height={9} />
              <div style={{ marginTop: 4 }}>
                <Skeleton width={70} height={13} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="lead-card__contact-row">
        <Skeleton width={110} height={26} radius="var(--radius-full)" />
        <Skeleton width={130} height={26} radius="var(--radius-full)" />
      </div>
      <div className="lead-card__footer">
        <Skeleton width={100} height={12} />
        <Skeleton width={90} height={26} radius="var(--radius-full)" />
      </div>
    </div>
  );
}

export default function LeadExchangePage() {
  const { showAlert } = useAlerts();

  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  // Persisted across refresh — a reload should land back on whichever
  // view (grid/list) the user last had open, not silently reset to grid.
  const [view, setView] = useState(() => {
    if (typeof window === "undefined") return "grid";
    return localStorage.getItem(VIEW_STORAGE_KEY) || "grid";
  });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dealerFilter, setDealerFilter] = useState("");
  const [pathFilter, setPathFilter] = useState("all");
  const [showRemoved, setShowRemoved] = useState(true);
  const [sortBy, setSortBy] = useState("recent"); // "recent" | "alpha"
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const [detail, setDetail] = useState(null);
  const restoredDetailRef = useRef(false);

  const [visibleColumns, setVisibleColumns] = useState(() =>
    Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.defaultVisible]))
  );
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const columnMenuRef = useRef(null);

  const loadLeads = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await adminDashboardService.listLeads();
      setLeads(result);
    } catch (err) {
      const message = err?.response?.data?.error || "Couldn't load leads. Try again.";
      setLoadError(message);
      showAlert("error", message, { title: "Load failed" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once leads are in, restore whichever lead was open in detail view
  // before a refresh — only attempted once per mount so it doesn't
  // fight with the user navigating back to the list afterward.
  useEffect(() => {
    if (loading || restoredDetailRef.current) return;
    restoredDetailRef.current = true;
    const savedId = localStorage.getItem(DETAIL_STORAGE_KEY);
    if (!savedId) return;
    const found = leads.find((l) => String(l.ROWID) === savedId);
    if (found) setDetail(found);
    else localStorage.removeItem(DETAIL_STORAGE_KEY);
  }, [loading, leads]);

  useEffect(() => {
    if (!columnMenuOpen) return undefined;
    const handleClickOutside = (event) => {
      if (columnMenuRef.current && !columnMenuRef.current.contains(event.target)) {
        setColumnMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [columnMenuOpen]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncLeadsService();
      const removedNote = result.recordsRemoved ? `, ${result.recordsRemoved} removed` : "";
      showAlert(
        "success",
        `${result.recordsInserted} new, ${result.recordsUpdated} updated${removedNote}.`,
        {
          title: "Sync complete",
        }
      );
      await loadLeads();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Sync failed. Try again.", {
        title: "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  };

  const openDetail = (row) => {
    setDetail(row);
    if (row?.ROWID) localStorage.setItem(DETAIL_STORAGE_KEY, String(row.ROWID));
  };

  const closeDetail = () => {
    setDetail(null);
    localStorage.removeItem(DETAIL_STORAGE_KEY);
  };

  const changeView = (next) => {
    setView(next);
    localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  const statuses = useMemo(
    () => [...new Set(leads.map((l) => l.lead_status).filter(Boolean))].sort(),
    [leads]
  );
  const dealerOptions = useMemo(() => {
    const map = new Map();
    leads.forEach((l) => {
      if (l.dealer_code) map.set(l.dealer_code, l.dealer_name);
    });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [leads]);

  const statusDropdownOptions = useMemo(
    () => [{ value: "", label: "All statuses" }, ...statuses.map((s) => ({ value: s, label: s }))],
    [statuses]
  );

  const dealerDropdownOptions = useMemo(
    () => [
      { value: "", label: "All dealers" },
      ...dealerOptions.map(([code, name]) => ({ value: code, label: name })),
    ],
    [dealerOptions]
  );

  const sortDropdownOptions = useMemo(
    () => [
      { value: "recent", label: "Recently added" },
      { value: "alpha", label: "Alphabetical (A–Z)" },
    ],
    []
  );

  const pageSizeOptions = useMemo(
    () => PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
    []
  );

  // Counts for the toggle labels, computed pre-pathFilter so switching
  // segments doesn't make its own count disappear.
  const pathCounts = useMemo(() => {
    const counts = { happy: 0, unhappy: 0 };
    leads.forEach((l) => {
      const classification = classifyLeadWithDuplicate(l, leads);
      counts[classification.path] += 1;
    });
    return counts;
  }, [leads]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads.filter((l) => {
      const matchesSearch =
        !term ||
        [l.customer_name, l.email_address, l.mobile_number, l.dealer_name, l.vehicle_model]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(term));
      const matchesStatus = !statusFilter || l.lead_status === statusFilter;
      const matchesDealer = !dealerFilter || l.dealer_code === dealerFilter;
      const classification = classifyLeadWithDuplicate(l, leads);
      const matchesPath = pathFilter === "all" || classification.path === pathFilter;
      const matchesRemoved = showRemoved || l.sync_status !== "Removed";
      return matchesSearch && matchesStatus && matchesDealer && matchesPath && matchesRemoved;
    });
  }, [leads, search, statusFilter, dealerFilter, pathFilter, showRemoved]);

  // Applied after filtering, before pagination, so "recently added"
  // and "alphabetical" both operate on the same filtered set and the
  // first page always reflects the chosen order.
  const sorted = useMemo(() => {
    const rows = [...filtered];
    if (sortBy === "alpha") {
      rows.sort((a, b) =>
        (a.customer_name || "").localeCompare(b.customer_name || "", undefined, {
          sensitivity: "base",
        })
      );
    } else {
      // "recent" (default) — Catalyst ROWIDs are chronologically
      // increasing, so a higher ROWID means the record was created
      // more recently. Falls back to assigned_date if ROWID is ever
      // missing/non-numeric.
      rows.sort((a, b) => {
        const aId = Number(a.ROWID);
        const bId = Number(b.ROWID);
        if (!Number.isNaN(aId) && !Number.isNaN(bId)) return bId - aId;
        return (b.assigned_date || "").localeCompare(a.assigned_date || "");
      });
    }
    return rows;
  }, [filtered, sortBy]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageRows = sorted.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const resetPage = () => setPageIndex(0);

  const handleStatusChange = (value) => {
    setStatusFilter(value);
    resetPage();
  };

  const handleDealerChange = (value) => {
    setDealerFilter(value);
    resetPage();
  };

  const handlePathFilterChange = (value) => {
    setPathFilter(value);
    resetPage();
  };

  const handleSortChange = (value) => {
    setSortBy(value);
    resetPage();
  };

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    resetPage();
  };

  const toggleColumn = (key) => {
    setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const dimmed = (row, content) => (
    <span className={row.sync_status === "Removed" ? "lead-exchange__cell--removed" : ""}>
      {content}
    </span>
  );

  const columnRenderers = {
    customer_name: (row) => dimmed(row, row.customer_name),
    dealer_name: (row) => dimmed(row, row.dealer_name),
    dealer_code: (row) => dimmed(row, row.dealer_code),
    vehicle_model: (row) => dimmed(row, cellText(row.vehicle_model)),
    lead_source: (row) => dimmed(row, cellText(row.lead_source)),
    lead_status: (row) =>
      row.sync_status === "Removed" ? (
        <Badge tone="danger">Removed</Badge>
      ) : (
        <Badge tone={STATUS_TONES[row.lead_status] || "neutral"}>{row.lead_status || "—"}</Badge>
      ),
    mobile_number: (row) =>
      dimmed(
        row,
        row.mobile_number ? (
          <a
            href={`tel:${row.mobile_number}`}
            className="lead-exchange__contact-link"
            onClick={(e) => e.stopPropagation()}
          >
            {row.mobile_number}
          </a>
        ) : (
          "—"
        )
      ),
    email_address: (row) =>
      dimmed(
        row,
        row.email_address ? (
          <a
            href={`mailto:${row.email_address}`}
            className="lead-exchange__contact-link"
            onClick={(e) => e.stopPropagation()}
          >
            {row.email_address}
          </a>
        ) : (
          "—"
        )
      ),
    assigned_date: (row) => dimmed(row, cellText(row.assigned_date)),
    last_status_update: (row) => dimmed(row, cellText(row.last_status_update)),
  };

  const columns = [
    ...ALL_COLUMNS.filter((c) => visibleColumns[c.key]).map((c) => ({
      key: c.key,
      label: c.label,
      render: columnRenderers[c.key],
    })),
    {
      key: "actions",
      label: "",
      render: (row) => (
        <button className="lead-exchange__row-action" onClick={() => openDetail(row)}>
          View
        </button>
      ),
    },
  ];

  return (
    <div className="lead-exchange">
      {detail ? (
        <div className="lead-exchange__panel" key="detail">
          <LeadDetailView lead={detail} onBack={closeDetail} />
        </div>
      ) : (
        <div className="lead-exchange__panel" key="list">
          <div className="lead-exchange__header">
            <button
              className={`lead-exchange__refresh-btn ${syncing ? "lead-exchange__refresh-btn--spinning" : ""}`}
              onClick={handleSync}
              disabled={syncing}
              aria-label="Sync leads"
            >
              <RefreshCw size={16} strokeWidth={2} />
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>

          {loadError && (
            <div className="lead-exchange__error">
              {loadError}
              <button
                type="button"
                className="lead-exchange__error-close"
                onClick={() => setLoadError(null)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          <div className="lead-exchange__path-toggle" role="tablist" aria-label="Filter by outcome">
            {PATH_FILTER_OPTIONS.map((option) => {
              const count =
                option.value === "happy"
                  ? pathCounts.happy
                  : option.value === "unhappy"
                    ? pathCounts.unhappy
                    : leads.length;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={pathFilter === option.value}
                  className={`lead-exchange__path-pill lead-exchange__path-pill--${option.value} ${
                    pathFilter === option.value ? "lead-exchange__path-pill--active" : ""
                  }`}
                  onClick={() => handlePathFilterChange(option.value)}
                >
                  {option.label}
                  <span className="lead-exchange__path-pill-count">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="lead-exchange__filters">
            <div className="lead-exchange__search">
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  resetPage();
                }}
                placeholder="Search by customer, email, mobile, dealer, or vehicle…"
              />
            </div>

            <Dropdown
              ariaLabel="Filter by status"
              value={statusFilter}
              onChange={handleStatusChange}
              options={statusDropdownOptions}
            />

            <Dropdown
              ariaLabel="Filter by dealer"
              value={dealerFilter}
              onChange={handleDealerChange}
              options={dealerDropdownOptions}
            />

            <Dropdown
              ariaLabel="Sort leads"
              value={sortBy}
              onChange={handleSortChange}
              options={sortDropdownOptions}
            />

            <label className="lead-exchange__switch">
              <input
                type="checkbox"
                checked={showRemoved}
                onChange={(event) => {
                  setShowRemoved(event.target.checked);
                  resetPage();
                }}
              />
              <span className="lead-exchange__switch-track">
                <span className="lead-exchange__switch-thumb" />
              </span>
              Show removed
            </label>

            {/* Column visibility only applies to the list/table view —
                the grid view's cards show a fixed field set, so this
                control would do nothing there. */}
            {view === "list" && (
              <div className="lead-exchange__column-menu" ref={columnMenuRef}>
                <button
                  type="button"
                  className="lead-exchange__column-toggle"
                  onClick={() => setColumnMenuOpen((open) => !open)}
                >
                  Columns
                </button>
                {columnMenuOpen && (
                  <div className="lead-exchange__column-dropdown">
                    {ALL_COLUMNS.map((c) => (
                      <label key={c.key} className="lead-exchange__checkbox">
                        <input
                          type="checkbox"
                          checked={visibleColumns[c.key]}
                          onChange={() => toggleColumn(c.key)}
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="lead-exchange__view-toggle" role="group" aria-label="Switch view">
              <button
                type="button"
                className={view === "grid" ? "lead-exchange__view-btn--active" : ""}
                onClick={() => changeView("grid")}
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                title="Grid view"
              >
                <LayoutGrid size={16} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={view === "list" ? "lead-exchange__view-btn--active" : ""}
                onClick={() => changeView("list")}
                aria-label="List view"
                aria-pressed={view === "list"}
                title="List view"
              >
                <List size={16} strokeWidth={2} />
              </button>
            </div>
          </div>

          {view === "list" ? (
            <Table
              columns={columns}
              rows={pageRows}
              loading={loading}
              emptyMessage="No leads match your search"
              onRowClick={(row) => openDetail(row)}
            />
          ) : (
            <div className="lead-exchange__grid">
              {loading ? (
                Array.from({ length: pageSize }).map((_, i) => <LeadCardSkeleton key={i} />)
              ) : pageRows.length === 0 ? (
                <div className="lead-exchange__grid-loading">No leads match your search</div>
              ) : (
                pageRows.map((row) => {
                  const removed = row.sync_status === "Removed";
                  const classification = classifyLeadWithDuplicate(row, leads);
                  const isDuplicate = classification.isDuplicate && !removed;
                  // Removed leads are soft-deleted upstream; labelling them
                  // with an integration path would imply live activity.
                  const pathLabel = removed ? "" : classification.label;
                  const pathTone = classification.path === "unhappy" ? "unhappy" : "happy";
                  const tone = removed
                    ? "neutral"
                    : isDuplicate
                      ? "success"
                      : STATUS_TONES[row.lead_status] || "neutral";
                  return (
                    <div
                      key={row.ROWID || row.dealer_code + row.customer_name}
                      className={`lead-card lead-card--tone-${tone} ${removed ? "lead-card--removed" : ""} ${
                        isDuplicate ? "lead-card--duplicate" : ""
                      }`}
                      onClick={() => openDetail(row)}
                    >
                      <div className="lead-card__top">
                        <div className="lead-card__identity">
                          <span className="lead-card__avatar">
                            {initialsFor(row.customer_name)}
                          </span>
                          <div>
                            <div className="lead-card__name-row">
                              <h3>{row.customer_name || "Unnamed lead"}</h3>
                              {row.lead_status === "Not Contacted" && !removed && (
                                <span className="lead-card__new-pill">New Lead</span>
                              )}
                              {isDuplicate && (
                                <span className="lead-card__duplicate-pill">
                                  Duplicate (Happy 3)
                                </span>
                              )}
                              {!isDuplicate && pathLabel && (
                                <span
                                  className={`lead-card__path-pill lead-card__path-pill--${pathTone}`}
                                  title={`Integration path: ${pathLabel}`}
                                >
                                  {pathLabel}
                                </span>
                              )}
                            </div>
                            {row.ROWID && (
                              <span className="lead-card__id">Lead ID: {row.ROWID}</span>
                            )}
                          </div>
                        </div>
                        <div className="lead-card__top-actions">
                          {removed ? (
                            <Badge tone="danger">Removed</Badge>
                          ) : (
                            <Badge tone={STATUS_TONES[row.lead_status] || "neutral"}>
                              {row.lead_status || "—"}
                            </Badge>
                          )}
                          <button
                            className="lead-card__more"
                            onClick={(e) => e.stopPropagation()}
                            aria-label="More actions"
                          >
                            <MoreVertical size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="lead-card__body">
                        <div className="lead-card__field">
                          <span className="lead-card__icon">
                            <Store size={16} />
                          </span>
                          <div>
                            <span className="lead-card__label">Dealer</span>
                            <span className="lead-card__value">{row.dealer_name || "—"}</span>
                          </div>
                        </div>
                        <div className="lead-card__field">
                          <span className="lead-card__icon">
                            <Hash size={16} />
                          </span>
                          <div>
                            <span className="lead-card__label">Dealer code</span>
                            <span className="lead-card__value">{row.dealer_code || "—"}</span>
                          </div>
                        </div>
                        <div className="lead-card__field">
                          <span className="lead-card__icon">
                            <Car size={16} />
                          </span>
                          <div>
                            <span className="lead-card__label">Vehicle</span>
                            <span className="lead-card__value">{cellText(row.vehicle_model)}</span>
                          </div>
                        </div>
                        <div className="lead-card__field">
                          <span className="lead-card__icon">
                            <Megaphone size={16} />
                          </span>
                          <div>
                            <span className="lead-card__label">Source</span>
                            <span className="lead-card__value">{cellText(row.lead_source)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="lead-card__contact-row">
                        {row.mobile_number && (
                          <a
                            href={`tel:${row.mobile_number}`}
                            className="lead-card__contact-btn lead-card__contact-btn--call"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Phone size={14} strokeWidth={2.5} />
                            {row.mobile_number}
                          </a>
                        )}
                        {row.email_address && (
                          <a
                            href={`mailto:${row.email_address}`}
                            className="lead-card__contact-btn lead-card__contact-btn--mail"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Mail size={14} strokeWidth={2.5} />
                            {row.email_address}
                          </a>
                        )}
                      </div>

                      <div className="lead-card__footer">
                        {row.assigned_date && (
                          <span className="lead-card__created">
                            <Calendar size={14} />
                            Created: {row.assigned_date}
                          </span>
                        )}
                        <button
                          className="lead-card__view-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetail(row);
                          }}
                        >
                          <Eye size={14} />
                          View Details
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          <div className="lead-exchange__pagination">
            <div className="lead-exchange__page-size">
              <span>Rows per page</span>
              <Dropdown
                ariaLabel="Rows per page"
                size="sm"
                value={String(pageSize)}
                onChange={handlePageSizeChange}
                options={pageSizeOptions}
              />
            </div>

            <div className="lead-exchange__page-nav">
              <button
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
              >
                Previous
              </button>
              <span>
                Page {currentPage + 1} of {pageCount} · {sorted.length} leads
              </span>
              <button
                onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
                disabled={currentPage >= pageCount - 1}
              >
                Next
              </button>
            </div>
          </div>

          <OutOfOrderEventsPanel />
        </div>
      )}
    </div>
  );
}

// Unhappy 7 — out-of-order dealer events. A dealer update that arrives
// before its MG enquiry is linked has no MG lead, so it can never be a card
// in the lead list above. This panel shows those dealer records on their
// own, so the hold, the release and the expiry are all visible. It is
// self-contained: it neither reads nor changes the lead list's state.
const OUT_OF_ORDER_REFRESH_MS = 30000;

const OUT_OF_ORDER_STATES = {
  HELD: { label: "Held", tone: "held", note: "Waiting for its MG enquiry" },
  EXPIRED: { label: "Expired", tone: "expired", note: "Retention passed — not applied to MG" },
  RELEASED: { label: "Released", tone: "released", note: "Applied to MG once the enquiry was linked" },
};

function formatSystemTimestamp(value) {
  if (!value) return "—";
  // Catalyst system timestamp "YYYY-MM-DD HH:MM:SS:mmm" — drop milliseconds.
  return String(value).replace(/:\d{1,3}$/, "");
}

function OutOfOrderEventsPanel() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const result = await adminDashboardService.listOutOfOrderEvents();
      setEvents(result);
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.error || "Couldn't load dealer events.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, OUT_OF_ORDER_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  if (loading) return null;
  if (!error && events.length === 0) return null;

  const heldCount = events.filter((e) => e.state === "HELD").length;

  return (
    <section className="ooo-panel" aria-labelledby="ooo-panel-title">
      <div className="ooo-panel__header">
        <div>
          <div className="ooo-panel__title-row">
            <h3 id="ooo-panel-title" className="ooo-panel__title">
              Dealer updates awaiting an MG enquiry
            </h3>
            <span className="ooo-panel__path-pill">Unhappy 7</span>
          </div>
          <p className="ooo-panel__subtitle">
            Out-of-order events: the dealer CRM sent an update for a record with no linked MG
            enquiry. It is held — never applied to the wrong enquiry — and released once the
            enquiry exists, or expired with an alert after the retention period.
          </p>
        </div>
        <button type="button" className="ooo-panel__refresh" onClick={load} aria-label="Refresh dealer events">
          <RefreshCw size={14} strokeWidth={2} />
          Refresh
        </button>
      </div>

      {error && <div className="ooo-panel__error">{error}</div>}

      {events.length > 0 && (
        <>
          <div className="ooo-panel__summary">
            {heldCount} held · {events.length} total
          </div>
          <div className="ooo-panel__table-wrap">
            <table className="ooo-panel__table">
              <thead>
                <tr>
                  <th>Customer (dealer CRM)</th>
                  <th>Dealer</th>
                  <th>Dealer record ID</th>
                  <th>Dealer status</th>
                  <th>Held since</th>
                  <th>State</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const meta = OUT_OF_ORDER_STATES[event.state] || OUT_OF_ORDER_STATES.HELD;
                  return (
                    <tr key={`${event.dealerCode}:${event.externalLeadId}`}>
                      <td className="ooo-panel__name">
                        {event.customerName || (event.dealerRecordMissing ? "Not found at dealer" : "—")}
                      </td>
                      <td>{event.dealerCode || "—"}</td>
                      <td className="ooo-panel__mono">{event.externalLeadId}</td>
                      <td>{event.dealerStatus || "—"}</td>
                      <td className="ooo-panel__mono">{formatSystemTimestamp(event.heldSince)}</td>
                      <td>
                        <span className={`ooo-panel__state ooo-panel__state--${meta.tone}`}>{meta.label}</span>
                        <div className="ooo-panel__state-note">{meta.note}</div>
                      </td>
                      <td className="ooo-panel__reason">
                        {event.reason}
                        {event.expiredAt && (
                          <div className="ooo-panel__state-note">Expired {formatSystemTimestamp(event.expiredAt)}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
