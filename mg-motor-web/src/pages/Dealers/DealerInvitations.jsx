import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, BadgeCheck, RefreshCw } from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { inviteDealer, removeDealer, resendDealerInvite } from "../../services/api/dealerInviteService";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import mgLogo from "../../assets/images/mg-logo-single.png";
import "./DealerInvitations.css";
import TableSkeleton from "../../ui/Skeleton/TableSkeleton";
import Skeleton from "../../ui/Skeleton/Skeleton";
import "../../ui/Skeleton/Skeleton.css";
import "../../ui/Skeleton/TableSkeleton.css";

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

// invite_status values expected from backend: 'not_invited' | 'invited' | 'active'
function isCatalystVerified(row) {
  const raw = row.catalyst_confirmed ?? row.confirmed ?? row.confirm;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.trim().toLowerCase() === "yes";
  return false;
}

function statusBadge(status) {
  if (status === "active") return <Badge tone="active" fixed>Active dealer</Badge>;
  if (status === "invited") return <Badge tone="pending" fixed>Invited</Badge>;
  return <Badge tone="neutral" fixed>Not invited</Badge>;
}

function emailLink(email) {
  if (!email) return "—";
  return (
    
      <a href={`mailto:${email}`}
      className="dealer-invitations__mail-link"
      onClick={(e) => e.stopPropagation()}
    >
      {email}
    </a>
  );
}

/**
 * statusFilter:
 *  "all"    — every CRM dealer (default, unfiltered)
 *  "active" — invite_status === "active" only        → used by the "Active dealers" tab
 *  "pending"— invite_status !== "active"              → used by the "Invite dealers" tab
 *             (covers both "not_invited" and "invited")
 */
export default function DealerInvitations({ statusFilter = "all" } = {}) {
  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [busyCode, setBusyCode] = useState(null);
  const [message, setMessage] = useState(null);

  const [view, setView] = useState("grid"); // "grid" | "list" — grid is now the default
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [confirmRemove, setConfirmRemove] = useState(null); // dealer object pending confirmation

  const load = async ({ silent = false } = {}) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const result = await adminDashboardService.dealerInvitations();
      setDealers(result);
    } catch (err) {
      setError(err?.response?.data?.error || "Couldn't load dealer invitations. Try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Reset to page 1 whenever the scope changes (e.g. the same mounted
  // component is reused for both "active" and "pending" via prop change).
  useEffect(() => {
    setPageIndex(0);
  }, [statusFilter]);

  const handleRefresh = () => {
    load({ silent: true });
  };

  const scopedDealers = useMemo(() => {
    if (statusFilter === "active") return dealers.filter((d) => d.invite_status === "active");
    if (statusFilter === "pending") return dealers.filter((d) => d.invite_status !== "active");
    return dealers;
  }, [dealers, statusFilter]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return scopedDealers;
    return scopedDealers.filter((d) =>
      [d.dealer_name, d.dealer_code, d.email, d.region].filter(Boolean).some((f) => f.toLowerCase().includes(term))
    );
  }, [scopedDealers, search]);

   const pageSizeOptions = useMemo(
    () => PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
    []
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageRows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const handleSearchChange = (value) => {
    setSearch(value);
    setPageIndex(0);
  };

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    setPageIndex(0);
  };

  const handleInvite = async (dealer) => {
    setBusyCode(dealer.dealer_code);
    setMessage(null);
    try {
      await inviteDealer(dealer.crmRecordId);
      setMessage(`Invited ${dealer.dealer_name} (${dealer.dealer_code}) at ${dealer.email}.`);
      await load({ silent: true });
    } catch (err) {
      setMessage(err?.response?.data?.error || `Couldn't invite ${dealer.dealer_name}. Try again.`);
    } finally {
      setBusyCode(null);
    }
  };

  const handleResend = async (dealer) => {
    setBusyCode(dealer.dealer_code);
    setMessage(null);
    try {
      await resendDealerInvite(dealer.dealer_code);
      setMessage(`Sent a new invite to ${dealer.dealer_name} (${dealer.dealer_code}) at ${dealer.email}.`);
      await load({ silent: true });
    } catch (err) {
      setMessage(err?.response?.data?.error || `Couldn't resend the invite to ${dealer.dealer_name}. Try again.`);
    } finally {
      setBusyCode(null);
    }
  };

  const handleRemove = async (dealer) => {
    setBusyCode(dealer.dealer_code);
    setMessage(null);
    try {
      await removeDealer(dealer.dealer_code);
      setMessage(`Removed ${dealer.dealer_name} (${dealer.dealer_code}) as a dealer user.`);
      await load({ silent: true });
    } catch (err) {
      setMessage(err?.response?.data?.error || `Couldn't remove ${dealer.dealer_name}. Try again.`);
    } finally {
      setBusyCode(null);
      setConfirmRemove(null);
    }
  };

  const actionCell = (row) => {
    if (row.invite_status === "active") {
      return (
        <button
          className="dealer-invitations__remove-btn"
          onClick={() => setConfirmRemove(row)}
          disabled={busyCode === row.dealer_code}
        >
          {busyCode === row.dealer_code ? "Removing…" : "Remove dealer"}
        </button>
      );
    }
    if (row.invite_status === "invited") {
      return (
        <div className="dealer-invitations__invite-meta">
          <span className="dealer-invitations__sent">
            Sent {row.invited_at ? row.invited_at.split(" ")[0] : ""}
          </span>
          <button
            className="dealer-invitations__resend-button"
            onClick={() => handleResend(row)}
            disabled={busyCode === row.dealer_code}
          >
            {busyCode === row.dealer_code ? "Sending…" : "Send again"}
          </button>
        </div>
      );
    }
    return (
      <button
        className="dealer-invitations__invite-button"
        onClick={() => handleInvite(row)}
        disabled={busyCode === row.dealer_code}
      >
        {busyCode === row.dealer_code ? "Inviting…" : "Invite"}
      </button>
    );
  };

    const columns = [
      { key: "dealer_code", label: "Code" },
      { key: "dealer_name", label: "Dealer" },
      { key: "email", label: "CRM email", render: (row) => emailLink(row.email) },
      { key: "region", label: "Region", render: (row) => <Badge tone="neutral" fixed>{row.region || "—"}</Badge> },
      { key: "status", label: "Invite status", render: (row) => statusBadge(row.invite_status) },
      { key: "actions", label: "", render: actionCell },
    ];

  const emptyMessage =
    statusFilter === "active"
      ? "No active dealers yet"
      : statusFilter === "pending"
      ? "No dealers waiting on an invite"
      : "No CRM dealers found";

   return (
    <div className="dealer-invitations">
      {message && <div className="dealer-invitations__notice">{message}</div>}
      {error && <div className="dealer-invitations__notice dealer-invitations__notice--error">{error}</div>}

      <div className="dealer-invitations__toolbar">
        <div className="dealer-invitations__search">
          <input
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by name, code, email, or region…"
          />
        </div>

       <div className="dealer-invitations__view--refresh">

         <div className="dealer-invitations__view-toggle" role="group" aria-label="Switch view">
          <button
            type="button"
            className={view === "grid" ? "dealer-invitations__view-btn--active" : ""}
            onClick={() => setView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            title="Grid view"
          >
            <LayoutGrid size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className={view === "list" ? "dealer-invitations__view-btn--active" : ""}
            onClick={() => setView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
            title="List view"
          >
            <List size={16} strokeWidth={2} />
          </button>
        </div>

        <button
          type="button"
          className="dealer-invitations__refresh-btn"
          onClick={handleRefresh}
          disabled={loading || refreshing}
          aria-label="Refresh dealer list"
          title="Refresh"
        >
          <RefreshCw size={16} strokeWidth={2} className={refreshing ? "dealer-invitations__refresh-icon--spinning" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        </div>
      </div>

      {view === "list" ? (
        loading ? (
          <TableSkeleton columnCount={columns.length} rowCount={pageSize} />
        ) : (
          <Table columns={columns} rows={pageRows} loading={loading} emptyMessage={emptyMessage} />
        )
      ) : (
        <div className="dealer-invitations__grid">
          {loading ? (
            Array.from({ length: pageSize }).map((_, i) => (
              <div key={i} className="dealer-invitations__card dealer-invitations__card--skeleton">
                <div className="dealer-invitations__card-top">
                  <Skeleton width={60} height={11} />
                  <Skeleton width={70} height={20} radius="var(--radius-full)" />
                </div>
                <Skeleton width="70%" height={15} />
                <Skeleton width="85%" height={12} />
                <Skeleton width={64} height={20} radius="var(--radius-full)" />
                <Skeleton width={90} height={28} radius="var(--radius-md)" />
              </div>
            ))
          ) : pageRows.length === 0 ? (
            <div className="dealer-invitations__grid-loading">{emptyMessage}</div>
          ) : (
            pageRows.map((row) => (
              <div
                key={row.dealer_code}
                className={`dealer-invitations__card ${row.invite_status === "active" ? "dealer-invitations__card--active" : ""}`}
              >
                <div className="dealer-invitations__card-top">
                  <div className="dealer-invitations__card-brand">
                    <span className="dealer-invitations__card-logo-chip">
                      <img src={mgLogo} alt="MG" className="dealer-invitations__card-logo" />
                      {isCatalystVerified(row) && (
                        <span className="dealer-invitations__verified-badge" title="Catalyst account verified">
                          <BadgeCheck size={11} strokeWidth={2.5} />
                        </span>
                      )}
                    </span>
                    <span className="dealer-invitations__card-code">{row.dealer_code}</span>
                  </div>
                  {statusBadge(row.invite_status)}
                </div>
                <h3>{row.dealer_name}</h3>
                <p className="dealer-invitations__card-email">{emailLink(row.email)}</p>
                <Badge tone="neutral">{row.region || "—"}</Badge>
                <div className="dealer-invitations__card-actions">{actionCell(row)}</div>
              </div>
            ))
          )}
        </div>
      )}

      <div className="dealer-invitations__pagination">
        <div className="dealer-invitations__page-size">
          <span>Rows per page</span>
          <Dropdown
            ariaLabel="Rows per page"
            size="sm"
            value={String(pageSize)}
            onChange={handlePageSizeChange}
            options={pageSizeOptions}
          />
        </div>
        <div className="dealer-invitations__page-nav">
          <button onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={currentPage === 0}>‹</button>
          <span>Page {currentPage + 1} of {pageCount} · {filtered.length} dealer{filtered.length === 1 ? "" : "s"}</span>
          <button onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))} disabled={currentPage >= pageCount - 1}>›</button>
        </div>
      </div>

      {confirmRemove && (
        <div className="dealer-invitations__confirm-backdrop" onClick={() => setConfirmRemove(null)}>
          <div className="dealer-invitations__confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Remove {confirmRemove.dealer_name}?</h3>
            <p>
              This deletes their Catalyst account and revokes portal access. They'll need a fresh
              invite to sign in again.
            </p>
            <div className="dealer-invitations__confirm-actions">
              <button onClick={() => setConfirmRemove(null)}>Cancel</button>
              <button
                className="dealer-invitations__remove-btn"
                onClick={() => handleRemove(confirmRemove)}
                disabled={busyCode === confirmRemove.dealer_code}
              >
                {busyCode === confirmRemove.dealer_code ? "Removing…" : "Confirm remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}