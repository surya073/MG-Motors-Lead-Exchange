import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, SquarePen, LayoutGrid, List, Car, Megaphone, Phone, Mail, Calendar, Eye } from "lucide-react";
import { dealerPortalService } from "../../services/api/dealerPortalService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import useUrlSearch from "../../hooks/useUrlSearch";
import Skeleton from "../../ui/Skeleton/Skeleton";
import Pagination from "../../ui/Pagination/Pagination";
import LeadUpdateOffcanvas from "./LeadUpdateOffcanvas";
import { Alert, useAlerts } from "../../ui/Alerts/Alerts";
import "./MyLeadsPage.css";
import "../LeadExchange/LeadExchangePage.css";
import mgLogo from "../../assets/images/mg-logo-single.png";

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100];

// Card view shows a grid of up to 4 columns, so its page sizes are multiples
// of 12 (divisible by 1, 2, 3 and 4): every row on a full page is complete,
// instead of ending with a lone card. Table view keeps its own sizes.
const CARD_PAGE_SIZE_OPTIONS = [12, 24, 48];
const nearestSize = (sizes, value) =>
  sizes.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best), sizes[0]);
const VIEW_STORAGE_KEY = "myLeads:view";

const STATUS_CARDS = [
  { key: "Not Contacted", label: "Not Contacted" },
  { key: "Follow-up 1", label: "Follow-up 1" },
  { key: "Contacted", label: "Contacted" },
  { key: "Contact in Future", label: "Contact in Future" },
  { key: "Lost", label: "Lost" },
];

const STATUS_TONES = {
  "Not Contacted": "neutral",
  "Follow-up 1": "warning",
  "Follow-up 2": "warning",
  Contacted: "info",
  "Contact in Future": "neutral",
  "Not Qualified": "danger",
  Dropped: "danger",
  Lost: "danger",
  "Attempted to Contact": "warning",
  "Junk Lead": "danger",
  "Lost Lead": "danger",
  "Pre-Qualified": "success",
};

const LEAD_STATUS_VALUES = [
  "Not Contacted",
  "Follow-up 1",
  "Follow-up 2",
  "Contacted",
  "Contact in Future",
  "Not Qualified",
  "Dropped",
  "Lost",
  "Attempted to Contact",
  "Junk Lead",
  "Lost Lead",
  "Pre-Qualified",
];

const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All statuses" },
  ...LEAD_STATUS_VALUES.map((status) => ({ value: status, label: status })),
];

function initialsFor(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return parts.length === 1
    ? parts[0].charAt(0).toUpperCase()
    : (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** Skeleton placeholder matching the real lead-card's structure —
 * shown during the initial fetch instead of collapsing the grid to
 * plain "Loading…" text. */
function MyLeadCardSkeleton() {
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
        {Array.from({ length: 2 }).map((_, i) => (
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

export default function MyLeadsPage() {
  const { showAlert } = useAlerts();

  // `leads` is only the CURRENT PAGE — searched, filtered and sorted by the
  // server for this dealer. `total` is the number of leads matching the
  // search/filter; `counts` are the dealer's overall KPI figures.
  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ total: 0, byStatus: {} });
  const [dealerCode, setDealerCode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  useUrlSearch(setSearch); // ?search= from the navbar search
  const [activeLead, setActiveLead] = useState(null); // { lead, mode: "view" | "edit" } | null

  const [view, setView] = useState(() => {
    if (typeof window === "undefined") return "grid";
    return localStorage.getItem(VIEW_STORAGE_KEY) || "grid";
  });

  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(() => (view === "grid" ? CARD_PAGE_SIZE_OPTIONS[0] : 10));

  // Search runs on the server, so wait for a pause in typing.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Only the newest request may update the page.
  const requestSeq = useRef(0);
  const summaryLoaded = useRef(false);

  // Loads the page described by the current search, filter, sort and page.
  // The KPI counts only change when leads do, so they are fetched on the first
  // load, a manual retry, and after a lead is saved — not on every page turn.
  const loadLeads = async ({ refreshSummary = false } = {}) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await dealerPortalService.myLeadsPage({
        page: pageIndex + 1,
        pageSize,
        search: debouncedSearch,
        status: statusFilter,
        sortKey: sortKey || undefined,
        sortDir: sortKey ? sortDir : undefined,
        includeSummary: refreshSummary || !summaryLoaded.current,
      });
      if (seq !== requestSeq.current) return;

      const { total: matching, totalPages } = result.pagination;
      if (result.leads.length === 0 && matching > 0 && pageIndex > 0) {
        // The page no longer exists (e.g. leads changed): step back.
        setPageIndex(Math.max(0, totalPages - 1));
        return;
      }
      setLeads(result.leads);
      setTotal(matching);
      setDealerCode(result.dealerCode);
      if (result.summary) {
        setCounts(result.summary);
        summaryLoaded.current = true;
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const message = err?.response?.data?.error || "Couldn't load your leads. Try again.";
      setLoadError(message);
      showAlert("error", message, { title: "Load failed" });
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, pageSize, debouncedSearch, statusFilter, sortKey, sortDir]);

  const changeView = (next) => {
    setView(next);
    localStorage.setItem(VIEW_STORAGE_KEY, next);
    // Keep the page size valid for the view being switched to.
    const sizes = next === "grid" ? CARD_PAGE_SIZE_OPTIONS : PAGE_SIZE_OPTIONS;
    if (!sizes.includes(pageSize)) setPageSize(nearestSize(sizes, pageSize));
    setPageIndex(0);
  };

  // KPI cards: the dealer's overall figures from the server (not limited by
  // the search/filter, and exact however many leads the dealer has).
  const summary = {
    total: counts.total,
    ...Object.fromEntries(STATUS_CARDS.map(({ key }) => [key, counts.byStatus?.[key] || 0])),
  };

  // The server already searched, filtered, sorted and paged.
  const pageRows = leads;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);

  const resetPage = () => setPageIndex(0);

  const handleSearchChange = (value) => {
    setSearch(value);
    resetPage();
  };

  const handleStatusChange = (value) => {
    setStatusFilter(value);
    resetPage();
  };

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    resetPage();
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

  const sortableLabel = (label, key) => {
    const active = sortKey === key;
    return (
      <button
        type="button"
        className={`my-leads__sort-btn ${active ? "my-leads__sort-btn--active" : ""}`}
        onClick={() => toggleSort(key)}
      >
        {label}
        <ArrowUpDown size={12} className={active && sortDir === "desc" ? "my-leads__sort-icon--desc" : ""} />
      </button>
    );
  };

  const handleSaved = (updatedLead) => {
    setLeads((prev) => prev.map((l) => (l.ROWID === updatedLead.ROWID ? { ...l, ...updatedLead } : l)));
    setActiveLead(null);
    // A status change moves the KPI counts and may move the lead out of the
    // current filter, so re-read the page and the counts from the server.
    loadLeads({ refreshSummary: true });
    showAlert("success", `${updatedLead.customer_name || "Lead"} updated successfully.`);
  };

  const columns = [
    { key: "customer_name", label: sortableLabel("Customer", "customer_name") },
    { key: "vehicle_model", label: sortableLabel("Vehicle", "vehicle_model"), render: (row) => row.vehicle_model || "—" },
    { key: "lead_source", label: "Source", render: (row) => row.lead_source || "—" },
    {
      key: "lead_status",
      label: sortableLabel("Status", "lead_status"),
      render: (row) => <Badge tone={STATUS_TONES[row.lead_status] || "neutral"}>{row.lead_status || "—"}</Badge>,
    },
    {
      key: "last_status_update",
      label: sortableLabel("Last update", "last_status_update"),
      render: (row) => row.last_status_update || "—",
    },
    {
      key: "actions",
      label: "",
      render: (row) => (
        <button
          className="my-leads__row-action"
          onClick={(e) => {
            e.stopPropagation();
            setActiveLead({ lead: row, mode: "edit" });
          }}
        >
          <SquarePen size={13} strokeWidth={2.5} />
          Update
        </button>
      ),
    },
  ];

  return (
    <div className="my-leads">
      <div className="my-leads__header">
        <div className="my-leads__brand">
          <span className="my-leads__brand-badge">
            <img src={mgLogo} alt="MG" className="my-leads__brand-logo" />
            {dealerCode && <span className="my-leads__brand-code">{dealerCode}</span>}
          </span>
        </div>
      </div>

      {loadError && (
        <Alert
          variant="error"
          action={{ label: "Retry", onClick: () => loadLeads({ refreshSummary: true }) }}
          onClose={() => setLoadError(null)}
        >
          {loadError}
        </Alert>
      )}

      <div className="my-leads__kpis">
        <div className="kpi-card">
          <p className="kpi-card__label">Total leads</p>
          <div className="kpi-card__row">
            <span className="kpi-card__value">{summary.total}</span>
          </div>
        </div>
        {STATUS_CARDS.map(({ key, label }) => (
          <div className="kpi-card" key={key}>
            <p className="kpi-card__label">{label}</p>
            <div className="kpi-card__row">
              <span className="kpi-card__value">{summary[key]}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="my-leads__filters">
        <input
          value={search}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder="Search by customer, email, mobile, or vehicle…"
        />
        <Dropdown
          ariaLabel="Filter by status"
          value={statusFilter}
          onChange={handleStatusChange}
          options={STATUS_FILTER_OPTIONS}
        />

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
          onRowClick={(row) => setActiveLead({ lead: row, mode: "view" })}
        />
      ) : (
        <div className="lead-exchange__grid">
          {loading ? (
            Array.from({ length: pageSize }).map((_, i) => <MyLeadCardSkeleton key={i} />)
          ) : pageRows.length === 0 ? (
            <div className="lead-exchange__grid-loading">No leads match your search</div>
          ) : (
            pageRows.map((row) => {
              const tone = STATUS_TONES[row.lead_status] || "neutral";
              return (
                <div
                  key={row.ROWID}
                  className={`lead-card lead-card--tone-${tone}`}
                  onClick={() => setActiveLead({ lead: row, mode: "view" })}
                >
                  <div className="lead-card__top">
                    <div className="lead-card__identity">
                      <span className="lead-card__avatar">{initialsFor(row.customer_name)}</span>
                      <div>
                        <div className="lead-card__name-row">
                          <h3>{row.customer_name || "Unnamed lead"}</h3>
                        </div>
                        {row.ROWID && <span className="lead-card__id">Lead ID: {row.ROWID}</span>}
                      </div>
                    </div>
                    <Badge tone={tone}>{row.lead_status || "—"}</Badge>
                  </div>

                  <div className="lead-card__body">
                    <div className="lead-card__field">
                      <span className="lead-card__icon"><Car size={16} /></span>
                      <div>
                        <span className="lead-card__label">Vehicle</span>
                        <span className="lead-card__value">{row.vehicle_model || "—"}</span>
                      </div>
                    </div>
                    <div className="lead-card__field">
                      <span className="lead-card__icon"><Megaphone size={16} /></span>
                      <div>
                        <span className="lead-card__label">Source</span>
                        <span className="lead-card__value">{row.lead_source || "—"}</span>
                      </div>
                    </div>
                  </div>

                  <div className="lead-card__contact-row">
                    {row.mobile_number && (
                      
                       <a href={`tel:${row.mobile_number}`}
                        className="lead-card__contact-btn lead-card__contact-btn--call"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Phone size={14} strokeWidth={2.5} />
                        {row.mobile_number}
                      </a>
                    )}
                    {row.email_address && (
                      
                      <a  href={`mailto:${row.email_address}`}
                        className="lead-card__contact-btn lead-card__contact-btn--mail"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Mail size={14} strokeWidth={2.5} />
                        {row.email_address}
                      </a>
                    )}
                  </div>

                  <div className="lead-card__footer">
                    {row.last_status_update && (
                      <span className="lead-card__created">
                        <Calendar size={14} />
                        Updated: {row.last_status_update}
                      </span>
                    )}
                    <button
                      className="lead-card__view-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveLead({ lead: row, mode: "edit" });
                      }}
                    >
                      <SquarePen size={14} />
                      Update
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      <Pagination
        page={currentPage + 1}
        pageCount={pageCount}
        total={total}
        noun="lead"
        onPageChange={(p) => setPageIndex(p - 1)}
        pageSize={pageSize}
        pageSizeOptions={view === "grid" ? CARD_PAGE_SIZE_OPTIONS : PAGE_SIZE_OPTIONS}
        onPageSizeChange={handlePageSizeChange}
      />

      {activeLead && (
        <LeadUpdateOffcanvas
          lead={activeLead.lead}
          initialMode={activeLead.mode}
          onClose={() => setActiveLead(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
