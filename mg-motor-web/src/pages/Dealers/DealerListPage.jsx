import { useEffect, useMemo, useLayoutEffect, useRef, useState } from "react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { syncDealersService } from "../../services/api/syncService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import "./DealerListPage.css";
import DealerInvitations from "./DealerInvitations";
import DealerDetailsOffcanvas from "../../ui/Offcanvas/DealerDetailsOffcanvas";
import Skeleton from "../../ui/Skeleton/Skeleton";
import StatSkeleton from "../../ui/Skeleton/StatSkeleton";
import TableSkeleton from "../../ui/Skeleton/TableSkeleton";
import "../../ui/Skeleton/Skeleton.css";
import "../../ui/Skeleton/TableSkeleton.css";
import { PhoneIcon, MailIcon } from "../../ui/icons";
import { useAlerts } from "../../ui/Alerts/Alerts";

const REGION_LABELS = { East: "East", West: "West", North: "North", South: "South" };

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

const SYNC_STATUS_TONES = {
  Synced: "active",
  Active: "active",
  Pending: "pending",
  Syncing: "info",
  Removed: "danger",
  Error: "danger",
};

function syncStatusTone(status) {
  return SYNC_STATUS_TONES[status] || "neutral";
}

const ALL_COLUMNS = [
  { key: "dealer_code", label: "Code", defaultVisible: true },
  { key: "dealer_name", label: "Dealer", defaultVisible: true, sortable: true },
  { key: "email_address", label: "Email", defaultVisible: true },
  { key: "phone_number", label: "Phone", defaultVisible: true },
  { key: "region", label: "Region", defaultVisible: true, sortable: true },
  { key: "city", label: "City", defaultVisible: false },
  { key: "state", label: "State", defaultVisible: false },
  { key: "lead_count", label: "Leads", defaultVisible: true, sortable: true },
  { key: "sync_status", label: "Sync status", defaultVisible: true },
  { key: "last_synced_at", label: "Last synced", defaultVisible: false, sortable: true },
];

function cellText(value) {
  return value && String(value).trim() ? value : "—";
}

const ICON_PATHS = {
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  x: "M18 6L6 18M6 6l12 12",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  sort: "M7 10l5-5 5 5M7 14l5 5 5-5",
  columns: "M4 4h16v16H4zM10 4v16M16 4v16",
  building: "M3 21h18M6 21V7l6-4 6 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1",
  check: "M20 6L9 17l-5-5",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a1 1 0 00.9 1.5h18.6a1 1 0 00.9-1.5L13.7 3.9a1 1 0 00-1.7 0z",
  filterOff: "M3 3l18 18M6 6h15l-6 7v6l-4 2v-8L3 3",
  map: "M9 20l-6-3V4l6 3 6-3 6 3v13l-6-3-6 3zM9 4v16M15 7v16",
};

function Icon({ name, size = 16, className = "" }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export default function DealerListPage() {
  const { showAlert } = useAlerts();

  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const [search, setSearch] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [showRemoved, setShowRemoved] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);

  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  const [activeTab, setActiveTab] = useState("synced");
  const tabsRef = useRef(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const [pageSize, setPageSize] = useState(10);
  const [selectedDealer, setSelectedDealer] = useState(null);

  useLayoutEffect(() => {
    const container = tabsRef.current;
    if (!container) return;
    const activeBtn = container.querySelector(".dealer-list__tab--active");
    if (activeBtn) {
      setIndicator({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth });
    }
  }, [activeTab]);

  useEffect(() => {
    const onResize = () => {
      const container = tabsRef.current;
      const activeBtn = container?.querySelector(".dealer-list__tab--active");
      if (activeBtn) setIndicator({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setPageIndex(0);
  }, [activeTab]);

  const [visibleColumns, setVisibleColumns] = useState(() =>
    Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.defaultVisible]))
  );
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);

  const columnMenuRef = useRef(null);

  const loadDealers = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await adminDashboardService.listDealers();
      setDealers(result);
    } catch (err) {
      const message = err?.response?.data?.error || "Couldn't load dealers. Try again.";
      setLoadError(message);
      showAlert("error", message, { title: "Load failed" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDealers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const result = await syncDealersService();
      const removedNote = result.recordsRemoved ? `, ${result.recordsRemoved} removed` : "";
      showAlert(
        "success",
        `${result.recordsInserted} new, ${result.recordsUpdated} updated${removedNote}.`,
        { title: "Sync complete" }
      );
      await loadDealers();
    } catch (err) {
      showAlert("error", err?.response?.data?.error || "Sync failed. Try again.", {
        title: "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  };

  const regions = useMemo(
    () => [...new Set(dealers.map((d) => d.region).filter(Boolean))].sort(),
    [dealers]
  );

  const regionDropdownOptions = useMemo(
    () => [
      { value: "", label: "All regions" },
      ...regions.map((region) => ({ value: region, label: REGION_LABELS[region] || region })),
    ],
    [regions]
  );

  const pageSizeOptions = useMemo(
    () => PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
    []
  );

  const stats = useMemo(() => {
    const total = dealers.length;
    const removed = dealers.filter((d) => d.sync_status === "Removed").length;
    return {
      total,
      active: total - removed,
      removed,
      regions: regions.length,
    };
  }, [dealers, regions]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let rows = dealers.filter((d) => {
      const matchesSearch =
        !term ||
        [d.dealer_name, d.dealer_code, d.email_address, d.region]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(term));
      const matchesRegion = !regionFilter || d.region === regionFilter;
      const matchesRemoved = showRemoved || d.sync_status !== "Removed";
      return matchesSearch && matchesRegion && matchesRemoved;
    });

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortKey] ?? "";
        const bv = b[sortKey] ?? "";
        const numeric = typeof av === "number" || typeof bv === "number";
        const cmp = numeric ? Number(av) - Number(bv) : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return rows;
  }, [dealers, search, regionFilter, showRemoved, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageRows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    setPageIndex(0);
  };

  const hasActiveFilters = Boolean(search) || Boolean(regionFilter) || !showRemoved;

  const handleSearchChange = (value) => {
    setSearch(value);
    setPageIndex(0);
  };

  const handleRegionChange = (value) => {
    setRegionFilter(value);
    setPageIndex(0);
  };

  const clearFilters = () => {
    setSearch("");
    setRegionFilter("");
    setShowRemoved(true);
    setPageIndex(0);
  };

  const toggleColumn = (key) => {
    setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSort = (key) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
      setSortDir("asc");
    }
  };

  const dimmed = (row, content) => (
    <span className={row.sync_status === "Removed" ? "dealer-list__cell--removed" : ""}>{content}</span>
  );

  const sortableLabel = (col) => {
    if (!col.sortable) return col.label;
    const active = sortKey === col.key;
    return (
      <button
        type="button"
        className={`dealer-list__sort-btn${active ? " dealer-list__sort-btn--active" : ""}`}
        onClick={() => toggleSort(col.key)}
      >
        {col.label}
        <Icon
          name="sort"
          size={12}
          className={`dealer-list__sort-icon${active && sortDir === "desc" ? " dealer-list__sort-icon--desc" : ""}`}
        />
      </button>
    );
  };

  const columnRenderers = {
    dealer_code: (row) => dimmed(row, row.dealer_code),
    dealer_name: (row) => dimmed(row, row.dealer_name),
    email_address: (row) =>
      dimmed(
        row,
        row.email_address ? (
          
          <a  href={`mailto:${row.email_address}`}
            className="dealer-list__contact-link--mail"
            onClick={(e) => e.stopPropagation()}
          >
            {row.email_address}
          </a>
        ) : (
          "—"
        )
      ),
    phone_number: (row) =>
      dimmed(
        row,
        row.phone_number ? (
          
           <a href={`tel:${row.phone_number}`}
            className="dealer-list__contact-badge--call"
            onClick={(e) => e.stopPropagation()}
          >
            <PhoneIcon size={11} />
            {row.phone_number}
          </a>
        ) : (
          "—"
        )
      ),
    region: (row) =>
      dimmed(row, <Badge tone="info" fixed>{REGION_LABELS[row.region] || row.region || "—"}</Badge>),
    city: (row) => dimmed(row, cellText(row.city)),
    state: (row) => dimmed(row, cellText(row.state)),
    lead_count: (row) => dimmed(row, row.lead_count),
    sync_status: (row) => (
      <Badge tone={syncStatusTone(row.sync_status)} fixed>
        {row.sync_status || "Synced"}
      </Badge>
    ),
    last_synced_at: (row) => dimmed(row, cellText(row.last_synced_at)),
  };

  const columns = ALL_COLUMNS.filter((c) => visibleColumns[c.key]).map((c) => ({
    key: c.key,
    label: sortableLabel(c),
    render: columnRenderers[c.key],
  }));

  const isSyncedTab = activeTab === "synced";

  return (
    <div className="dealer-list">
      <div className="dealer-list__header">
        {isSyncedTab && (
          <button
            className={`dealer-list__refresh-btn ${syncing ? "dealer-list__refresh-btn--spinning" : ""}`}
            onClick={handleSync}
            disabled={syncing}
            aria-label="Sync dealers"
          >
            <Icon name="refresh" size={16} />
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>

      <div className="dealer-list__tabs" ref={tabsRef}>
        <span
          className="dealer-list__tab-indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
        <button
          className={`dealer-list__tab ${activeTab === "synced" ? "dealer-list__tab--active" : ""}`}
          onClick={() => setActiveTab("synced")}
        >
          Synced dealers
        </button>
        <button
          className={`dealer-list__tab ${activeTab === "active" ? "dealer-list__tab--active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Active dealers
        </button>
        <button
          className={`dealer-list__tab ${activeTab === "invitations" ? "dealer-list__tab--active" : ""}`}
          onClick={() => setActiveTab("invitations")}
        >
          Invite dealers
        </button>
      </div>

      {isSyncedTab ? (
        <>
          <div className="dealer-list__stats">
            {loading ? (
              <>
                <StatSkeleton />
                <StatSkeleton />
                <StatSkeleton />
                <StatSkeleton />
              </>
            ) : (
              <>
                <div className="dealer-list__stat">
                  <span className="dealer-list__stat-icon"><Icon name="building" size={16} /></span>
                  <div>
                    <span className="dealer-list__stat-value">{stats.total}</span>
                    <span className="dealer-list__stat-label">Total dealers</span>
                  </div>
                </div>
                <div className="dealer-list__stat">
                  <span className="dealer-list__stat-icon"><Icon name="check" size={16} /></span>
                  <div>
                    <span className="dealer-list__stat-value">{stats.active}</span>
                    <span className="dealer-list__stat-label">Active</span>
                  </div>
                </div>
                <div className="dealer-list__stat">
                  <span className="dealer-list__stat-icon"><Icon name="alert" size={16} /></span>
                  <div>
                    <span className="dealer-list__stat-value">{stats.removed}</span>
                    <span className="dealer-list__stat-label">Removed</span>
                  </div>
                </div>
                <div className="dealer-list__stat">
                  <span className="dealer-list__stat-icon"><Icon name="map" size={16} /></span>
                  <div>
                    <span className="dealer-list__stat-value">{stats.regions}</span>
                    <span className="dealer-list__stat-label">Regions</span>
                  </div>
                </div>
              </>
            )}
          </div>

          {loadError && (
            <div className="dealer-list__banner dealer-list__banner--error">
              <Icon name="alert" size={16} />
              <span>{loadError}</span>
              <button
                type="button"
                className="dealer-list__banner-close"
                onClick={() => setLoadError(null)}
                aria-label="Dismiss"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          <div className="dealer-list__toolbar">
            <div className="dealer-list__search">
              <div className="dealer-list__search-field">
                <span className="dealer-list__search-icon"><Icon name="search" size={15} /></span>
                <input
                  value={search}
                  onChange={(event) => handleSearchChange(event.target.value)}
                  placeholder="Search by name, code, email, or region…"
                />
                {search && (
                  <button type="button" className="dealer-list__search-clear" onClick={() => handleSearchChange("")} aria-label="Clear search">
                    <Icon name="x" size={13} />
                  </button>
                )}
              </div>

              <Dropdown
                ariaLabel="Filter by region"
                value={regionFilter}
                onChange={handleRegionChange}
                options={regionDropdownOptions}
              />

              {hasActiveFilters && (
                <button type="button" className="dealer-list__clear-filters" onClick={clearFilters}>
                  <Icon name="filterOff" size={14} />
                  Clear filters
                </button>
              )}
            </div>

            <div className="dealer-list__toolbar-actions">
              <label className="dealer-list__switch">
                <input
                  type="checkbox"
                  checked={showRemoved}
                  onChange={(event) => {
                    setShowRemoved(event.target.checked);
                    setPageIndex(0);
                  }}
                />
                <span className="dealer-list__switch-track"><span className="dealer-list__switch-thumb" /></span>
                Show removed
              </label>

              <div className="dealer-list__column-menu" ref={columnMenuRef}>
                <button
                  type="button"
                  className="dealer-list__column-toggle"
                  onClick={() => setColumnMenuOpen((open) => !open)}
                >
                  <Icon name="columns" size={14} />
                  Columns
                </button>
                {columnMenuOpen && (
                  <div className="dealer-list__column-dropdown">
                    <div className="dealer-list__column-dropdown-header">
                      <span>Visible columns</span>
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleColumns((prev) => {
                            const allOn = ALL_COLUMNS.every((c) => prev[c.key]);
                            return Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, !allOn]));
                          })
                        }
                      >
                        Toggle all
                      </button>
                    </div>
                    {ALL_COLUMNS.map((c) => (
                      <label key={c.key} className="dealer-list__checkbox">
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
            </div>
          </div>

          {loading ? (
            <TableSkeleton columnCount={columns.length} rowCount={pageSize} />
          ) : (
            <Table
              columns={columns}
              rows={pageRows}
              loading={loading}
              emptyMessage="No dealers match your search"
              onRowClick={(row) => setSelectedDealer(row)}
            />
          )}

          <div className="dealer-list__pagination">
            <div className="dealer-list__page-size">
              <span>Rows per page</span>
              <Dropdown
                ariaLabel="Rows per page"
                size="sm"
                value={String(pageSize)}
                onChange={handlePageSizeChange}
                options={pageSizeOptions}
              />
            </div>

            <div className="dealer-list__page-nav">
              <button
                className="dealer-list__page-btn"
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                aria-label="Previous page"
              >
                <Icon name="chevronLeft" size={15} />
              </button>
              <span>
                Page {currentPage + 1} of {pageCount} · {filtered.length} dealer{filtered.length === 1 ? "" : "s"}
              </span>
              <button
                className="dealer-list__page-btn"
                onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
                disabled={currentPage >= pageCount - 1}
                aria-label="Next page"
              >
                <Icon name="chevronRight" size={15} />
              </button>
            </div>
          </div>
          <DealerDetailsOffcanvas dealer={selectedDealer} onClose={() => setSelectedDealer(null)} />
        </>
      ) : activeTab === "active" ? (
        <DealerInvitations statusFilter="active" />
      ) : (
        <DealerInvitations statusFilter="pending" />
      )}
    </div>
  );
}