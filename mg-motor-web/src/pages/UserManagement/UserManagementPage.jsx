import { useEffect, useMemo, useState } from "react";
import { UserPlus, RefreshCw, LayoutGrid, List, Pencil, Check, X as XIcon } from "lucide-react";
import { adminUserService, ADMIN_ROLE_OPTIONS } from "../../services/api/adminUserService";
import { useAuth } from "../../contexts/AuthContext";
import { APP_ROLES } from "../../constants/auth.constants";
import Table from "../../ui/Table/Table";
import Badge from "../../ui/Badge/Badge";
import Dropdown from "../../ui/Dropdown/Dropdown";
import Skeleton from "../../ui/Skeleton/Skeleton";
import TableSkeleton from "../../ui/Skeleton/TableSkeleton";
import { useAlerts } from "../../ui/Alerts/Alerts";
import "../../ui/Skeleton/Skeleton.css";
import "../../ui/Skeleton/TableSkeleton.css";
import "./UserManagementPage.css";

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "Invited", label: "Invited" },
  { value: "Active", label: "Active" },
  { value: "Removed", label: "Removed" },
];

const CURRENT_USER_ROLE_LABELS = {
  [APP_ROLES.SUPER_ADMIN]: "Super Admin",
  [APP_ROLES.ADMIN]: "Admin",
  [APP_ROLES.DEALER]: "Dealer",
};

function roleOptionsForDropdown() {
  return ADMIN_ROLE_OPTIONS;
}

function roleLabelFor(roleId) {
  return ADMIN_ROLE_OPTIONS.find((r) => r.value === String(roleId))?.label || "Admin";
}

// invite_status values from backend: 'Invited' | 'Active' | 'Removed'
function statusBadge(status) {
  if (status === "Active") return <Badge tone="active" fixed>Active</Badge>;
  if (status === "Removed") return <Badge tone="neutral" fixed>Removed</Badge>;
  return <Badge tone="pending" fixed>Invited</Badge>;
}

export default function UserManagementPage() {
  const { user } = useAuth();
  const { showAlert } = useAlerts();
  const isSuperAdmin = user?.appRole === APP_ROLES.SUPER_ADMIN;
  const currentEmail = (user?.email_id || "").toLowerCase();

  const currentDisplayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email_id || "Your account";
  const currentRoleLabel = CURRENT_USER_ROLE_LABELS[user?.appRole] || "—";

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [inviting, setInviting] = useState(false);

  const [confirmRemove, setConfirmRemove] = useState(null);

  const [view, setView] = useState("grid"); // "grid" | "list" — grid is default
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Inline edit state — one row editable at a time.
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);
    try {
      const { users: result } = await adminUserService.fetchAdminUsers();
      setUsers(result);
    } catch (err) {
      const message = err?.response?.data?.error || "Couldn't load users. Try again.";
      setLoadError(message);
      showAlert("error", message, { title: "Load failed" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (isSuperAdmin) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!email.trim()) {
      showAlert("warning", "Enter an email address to invite.");
      return;
    }
    setInviting(true);
    try {
      await adminUserService.inviteAdminUser({ email: email.trim(), name: name.trim() });
      showAlert("success", `Invited ${email.trim()}.`);
      setEmail("");
      setName("");
      await load({ silent: true });
    } catch (err) {
      showAlert("error", err?.response?.data?.error || `Couldn't invite ${email.trim()}. Try again.`, {
        title: "Invite failed",
      });
    } finally {
      setInviting(false);
    }
  };

  const handleResend = async (row) => {
    setBusyId(row.ROWID);
    try {
      await adminUserService.resendAdminUserInvite(row.ROWID);
      showAlert("success", `Sent a new invite to ${row.admin_email}.`);
      await load({ silent: true });
    } catch (err) {
      showAlert(
        "error",
        err?.response?.data?.error || `Couldn't resend the invite to ${row.admin_email}. Try again.`,
        { title: "Resend failed" }
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (row) => {
    setBusyId(row.ROWID);
    try {
      await adminUserService.removeAdminUser(row.ROWID);
      showAlert("success", `Removed access for ${row.admin_email}.`);
      await load({ silent: true });
    } catch (err) {
      showAlert("error", err?.response?.data?.error || `Couldn't remove ${row.admin_email}. Try again.`, {
        title: "Remove failed",
      });
    } finally {
      setBusyId(null);
      setConfirmRemove(null);
    }
  };

  const startEdit = (row) => {
    setEditingId(row.ROWID);
    setEditName(row.admin_name || "");
    setEditRole(String(row.role_id || ADMIN_ROLE_OPTIONS[1].value));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditRole("");
  };

  const saveEdit = async (row) => {
    setSaving(true);
    try {
      await adminUserService.updateAdminUser(row.ROWID, {
        admin_name: editName.trim(),
        role_id: editRole,
      });
      showAlert("success", `Updated ${row.admin_email}.`);
      cancelEdit();
      await load({ silent: true });
    } catch (err) {
      showAlert("error", err?.response?.data?.error || `Couldn't update ${row.admin_email}. Try again.`, {
        title: "Update failed",
      });
    } finally {
      setSaving(false);
    }
  };

  const isSelf = (row) => (row.admin_email || "").toLowerCase() === currentEmail;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((u) => {
      const matchesSearch =
        !term ||
        [u.admin_name, u.admin_email].filter(Boolean).some((f) => f.toLowerCase().includes(term));
      const matchesStatus = !statusFilter || u.invite_status === statusFilter;
      const matchesRole = !roleFilter || String(u.role_id) === roleFilter;
      return matchesSearch && matchesStatus && matchesRole;
    });
  }, [users, search, statusFilter, roleFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageRows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const pageSizeOptions = useMemo(
    () => PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
    []
  );

  const roleFilterOptions = useMemo(
    () => [{ value: "", label: "All roles" }, ...ADMIN_ROLE_OPTIONS],
    []
  );

  const resetPage = () => setPageIndex(0);

  const handleSearchChange = (value) => {
    setSearch(value);
    resetPage();
  };

  const handleStatusChange = (value) => {
    setStatusFilter(value);
    resetPage();
  };

  const handleRoleChange = (value) => {
    setRoleFilter(value);
    resetPage();
  };

  const handlePageSizeChange = (value) => {
    setPageSize(Number(value));
    resetPage();
  };

  const hasActiveFilters = Boolean(search) || Boolean(statusFilter) || Boolean(roleFilter);

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("");
    setRoleFilter("");
    resetPage();
  };

  // Shared action cell — used by both the table column and the grid card.
  const actionCell = (row) => {
    const self = isSelf(row);

    if (editingId === row.ROWID) {
      return (
        <div className="user-mgmt__edit-actions">
          <button className="user-mgmt__save-btn" onClick={() => saveEdit(row)} disabled={saving}>
            <Check size={14} strokeWidth={2.5} />
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="user-mgmt__cancel-btn" onClick={cancelEdit} disabled={saving}>
            <XIcon size={14} strokeWidth={2.5} />
            Cancel
          </button>
        </div>
      );
    }

    if (row.invite_status === "Removed") {
      return <span className="user-mgmt__removed-note">Access revoked</span>;
    }

    return (
      <div className="user-mgmt__row-actions">
        <button className="user-mgmt__edit-btn" onClick={() => startEdit(row)} disabled={busyId === row.ROWID}>
          <Pencil size={13} strokeWidth={2.5} />
          Edit
        </button>

        {row.invite_status === "Invited" && (
          <button
            className="user-mgmt__resend-button"
            onClick={() => handleResend(row)}
            disabled={busyId === row.ROWID}
          >
            {busyId === row.ROWID ? "Sending…" : "Resend"}
          </button>
        )}

        <button
          className="user-mgmt__remove-btn"
          onClick={() => setConfirmRemove(row)}
          disabled={busyId === row.ROWID || self}
          title={self ? "You can't remove your own account" : undefined}
        >
          Remove
        </button>
      </div>
    );
  };

  const selfTag = () => <span className="user-mgmt__self-tag">You</span>;

  // Shared name/role cell content for editable state.
  const nameCell = (row) => {
    if (editingId === row.ROWID) {
      return (
        <input
          className="user-mgmt__inline-input"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Name"
          autoFocus
        />
      );
    }
    return row.admin_name || "—";
  };

  const roleCell = (row) => {
    const self = isSelf(row);
    if (editingId === row.ROWID) {
      return (
        <Dropdown
          ariaLabel="Select role"
          size="sm"
          value={editRole}
          onChange={setEditRole}
          options={roleOptionsForDropdown()}
          disabled={self}
        />
      );
    }
    return (
      <Badge tone={row.role_id === ADMIN_ROLE_OPTIONS[0].value ? "info" : "neutral"} fixed>
        {row.role_label || roleLabelFor(row.role_id)}
      </Badge>
    );
  };

  const columns = [
    { key: "admin_name", label: "Name", render: nameCell },
    { key: "admin_email", label: "Email" },
    { key: "role", label: "Role", render: roleCell },
    { key: "status", label: "Status", render: (row) => statusBadge(row.invite_status) },
    { key: "invited_at", label: "Invited" },
    { key: "actions", label: "", render: actionCell },
  ];

  if (!isSuperAdmin) {
    return (
      <div className="user-mgmt user-mgmt--denied">
        <p>User Management is only available to Super Admins.</p>
      </div>
    );
  }

  return (
    <div className="user-mgmt">
      <div className="user-mgmt__self-card">
        <div className="user-mgmt__self-avatar">
          {currentDisplayName.charAt(0).toUpperCase()}
        </div>
        <div className="user-mgmt__self-info">
          <div className="user-mgmt__self-name-row">
            <span className="user-mgmt__self-name">{currentDisplayName}</span>
            <span className="user-mgmt__self-badge">You</span>
          </div>
          {user?.email_id && <span className="user-mgmt__self-email">{user.email_id}</span>}
        </div>
        <span className="user-mgmt__self-role">{currentRoleLabel}</span>
      </div>

      {loadError && (
        <div className="user-mgmt__notice user-mgmt__notice--error">
          {loadError}
          <button
            type="button"
            className="user-mgmt__notice-close"
            onClick={() => setLoadError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <form className="user-mgmt__invite-form" onSubmit={handleInvite}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email to invite (e.g. name@gmail.com)"
          required
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
        />
        <button type="submit" className="user-mgmt__invite-button" disabled={inviting}>
          <UserPlus size={15} strokeWidth={2.5} />
          {inviting ? "Inviting…" : "Invite Admin"}
        </button>
      </form>

      <div className="user-mgmt__toolbar">
        <div className="user-mgmt__search">
          <input
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by name or email…"
          />
        </div>

        <Dropdown
          ariaLabel="Filter by status"
          value={statusFilter}
          onChange={handleStatusChange}
          options={STATUS_OPTIONS}
        />

        <Dropdown
          ariaLabel="Filter by role"
          value={roleFilter}
          onChange={handleRoleChange}
          options={roleFilterOptions}
        />

        {hasActiveFilters && (
          <button type="button" className="user-mgmt__clear-filters" onClick={clearFilters}>
            Clear filters
          </button>
        )}

        <div className="user-mgmt__view-toggle" role="group" aria-label="Switch view">
          <button
            type="button"
            className={view === "grid" ? "user-mgmt__view-btn--active" : ""}
            onClick={() => setView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            title="Grid view"
          >
            <LayoutGrid size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className={view === "list" ? "user-mgmt__view-btn--active" : ""}
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
          className="user-mgmt__refresh-btn"
          onClick={() => load({ silent: true })}
          disabled={loading || refreshing}
        >
          <RefreshCw size={16} strokeWidth={2} className={refreshing ? "user-mgmt__refresh-icon--spinning" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {view === "list" ? (
        loading ? (
          <TableSkeleton columnCount={columns.length} rowCount={pageSize} />
        ) : (
          <Table columns={columns} rows={pageRows} loading={loading} emptyMessage="No users found" />
        )
      ) : (
        <div className="user-mgmt__grid">
          {loading ? (
            Array.from({ length: pageSize }).map((_, i) => (
              <div key={i} className="user-mgmt__card user-mgmt__card--skeleton">
                <div className="user-mgmt__card-top">
                  <Skeleton width="60%" height={15} />
                  <Skeleton width={70} height={20} radius="var(--radius-full)" />
                </div>
                <Skeleton width="85%" height={12} />
                <Skeleton width={64} height={20} radius="var(--radius-full)" />
                <Skeleton width={90} height={28} radius="var(--radius-md)" />
              </div>
            ))
          ) : pageRows.length === 0 ? (
            <div className="user-mgmt__grid-empty">No users found</div>
          ) : (
            pageRows.map((row) => {
              const initial = (row.admin_name || row.admin_email || "?").charAt(0).toUpperCase();
              return (
                <div
                  key={row.ROWID}
                  className={`user-mgmt__card ${row.invite_status === "Removed" ? "user-mgmt__card--removed" : ""}`}
                >
                  <div className="user-mgmt__card-banner">
                    <div className="user-mgmt__card-avatar">{initial}</div>
                  </div>

                  <div className="user-mgmt__card-body">
                    <div className="user-mgmt__card-name-row">
                      <h3>{nameCell(row)}</h3>
                    </div>
                    <p className="user-mgmt__card-email">{row.admin_email}</p>

                    <div className="user-mgmt__card-meta">
                      {statusBadge(row.invite_status)}
                      {roleCell(row)}
                    </div>

                    {row.invited_at && (
                      <p className="user-mgmt__card-invited">Invited {row.invited_at.split(" ")[0]}</p>
                    )}

                    <div className="user-mgmt__card-actions">{actionCell(row)}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      <div className="user-mgmt__pagination">
        <div className="user-mgmt__page-size">
          <span>Rows per page</span>
          <Dropdown
            ariaLabel="Rows per page"
            size="sm"
            value={String(pageSize)}
            onChange={handlePageSizeChange}
            options={pageSizeOptions}
          />
        </div>
        <div className="user-mgmt__page-nav">
          <button onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={currentPage === 0}>
            Previous
          </button>
          <span>
            Page {currentPage + 1} of {pageCount} · {filtered.length} user{filtered.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
            disabled={currentPage >= pageCount - 1}
          >
            Next
          </button>
        </div>
      </div>

      {confirmRemove && (
        <div className="user-mgmt__confirm-backdrop" onClick={() => setConfirmRemove(null)}>
          <div className="user-mgmt__confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Remove {confirmRemove.admin_name || confirmRemove.admin_email}?</h3>
            <p>
              This deletes their Catalyst account and revokes Admin access immediately.
              They'll need a fresh invite to sign in again.
            </p>
            <div className="user-mgmt__confirm-actions">
              <button className="user-mgmt__confirm-cancel" onClick={() => setConfirmRemove(null)}>
                Cancel
              </button>
              <button
                className="user-mgmt__remove-btn"
                onClick={() => handleRemove(confirmRemove)}
                disabled={busyId === confirmRemove.ROWID}
              >
                {busyId === confirmRemove.ROWID ? "Removing…" : "Confirm remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}