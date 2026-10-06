import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Building2,
  ArrowLeftRight,
  ScrollText,
  AlertTriangle,
  Plug,
  Users,
  Settings as SettingsIcon,
  Car,
  CheckCircle2,
  XCircle,
  Search,
  CornerDownLeft,
  X,
} from "lucide-react";
import { useAuth } from "../../../contexts/AuthContext";
import { APP_ROLES } from "../../../constants/auth.constants";
import { adminDashboardService } from "../../../services/api/adminDashboardService";
import { dealerPortalService } from "../../../services/api/dealerPortalService";
import { SCENARIO_META } from "../../../pages/Overview/Overview";
import { isAdminSide, runSearch } from "../../../utils/globalSearch";
import "./NavbarSearch.css";

const ICONS = {
  overview: LayoutDashboard,
  dealers: Building2,
  dealer: Building2,
  leads: ArrowLeftRight,
  lead: Car,
  logs: ScrollText,
  integrations: AlertTriangle,
  crm: Plug,
  users: Users,
  settings: SettingsIcon,
  happy: CheckCircle2,
  unhappy: XCircle,
};

const EXPANDED_MAX_WIDTH = 680;
const MOBILE_BREAKPOINT = 700;

// Leads and dealers are fetched once, when the search opens, then reused for
// a few minutes — typing never triggers a request, and the lists the Lead
// Exchange / Dealers pages load are untouched.
const CACHE_TTL_MS = 5 * 60 * 1000;
let dataCache = { key: null, at: 0, leads: [], dealers: [] };

async function loadSearchData(role, userKey) {
  const cacheKey = `${role}:${userKey}`;
  if (dataCache.key === cacheKey && Date.now() - dataCache.at < CACHE_TTL_MS) return dataCache;

  let leads = [];
  let dealers = [];
  if (isAdminSide(role)) {
    const [leadsResult, dealersResult] = await Promise.allSettled([
      adminDashboardService.listLeads(),
      adminDashboardService.listDealers(),
    ]);
    leads = leadsResult.status === "fulfilled" ? leadsResult.value || [] : [];
    dealers = dealersResult.status === "fulfilled" ? dealersResult.value || [] : [];
  } else if (role === APP_ROLES.DEALER) {
    try {
      const result = await dealerPortalService.myLeads();
      leads = result?.leads || [];
    } catch {
      leads = [];
    }
  }
  dataCache = { key: cacheKey, at: Date.now(), leads, dealers };
  return dataCache;
}

/* ------------------------------------------------------------------ */
/* The expanded search: blurred backdrop + a bar that grows out of the */
/* navbar box, with grouped results beneath it.                        */
/* ------------------------------------------------------------------ */

function SearchOverlay({ startRect, onClose }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const role = user?.appRole;
  const userKey = user?.email_id || user?.user_id || "";

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [entered, setEntered] = useState(false);
  const [data, setData] = useState({ leads: [], dealers: [] });
  const [dataLoading, setDataLoading] = useState(false);

  const inputRef = useRef(null);
  const listId = useId();

  // Start exactly where the navbar box is, then grow to the expanded size.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch leads/dealers once for result matching.
  useEffect(() => {
    let cancelled = false;
    if (!role || role === APP_ROLES.UNKNOWN) return undefined;
    setDataLoading(true);
    loadSearchData(role, userKey)
      .then((loaded) => {
        if (!cancelled) setData({ leads: loaded.leads, dealers: loaded.dealers });
      })
      .finally(() => {
        if (!cancelled) setDataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [role, userKey]);

  // Escape closes even if focus has wandered off the input.
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const results = useMemo(
    () => runSearch(query, { role, leads: data.leads, dealers: data.dealers, scenarios: SCENARIO_META }),
    [query, role, data]
  );

  // Group while keeping one flat index for keyboard navigation.
  const groups = useMemo(() => {
    const map = new Map();
    results.forEach((r, index) => {
      if (!map.has(r.group)) map.set(r.group, []);
      map.get(r.group).push({ ...r, index });
    });
    return Array.from(map.entries());
  }, [results]);

  const choose = useCallback(
    (result) => {
      if (!result) return;
      navigate(result.to);
      onClose();
    },
    [navigate, onClose]
  );

  const handleKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[active] || results[0]);
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  // Geometry: collapsed = the navbar box; expanded = centred, wider.
  const viewportW = typeof window === "undefined" ? 1280 : window.innerWidth;
  const isMobile = viewportW <= MOBILE_BREAKPOINT;
  const expandedWidth = isMobile ? viewportW - 24 : Math.min(EXPANDED_MAX_WIDTH, viewportW - 32);
  const shellStyle = entered
    ? {
        top: isMobile ? 12 : Math.max(12, (startRect?.top ?? 24) - 4),
        left: (viewportW - expandedWidth) / 2,
        width: expandedWidth,
      }
    : {
        top: startRect?.top ?? 24,
        left: startRect?.left ?? (viewportW - 330) / 2,
        width: startRect?.width ?? 330,
      };

  const placeholder = isAdminSide(role)
    ? "Search dealers, leads, logs, scenarios..."
    : "Search your leads, pages...";
  const activeId = results.length ? `${listId}-opt-${active}` : undefined;

  return createPortal(
    <div className={`nsearch${entered ? " nsearch--entered" : ""}`} onMouseDown={onClose}>
      <div
        className="nsearch__shell"
        style={shellStyle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="nsearch__bar">
          <Search size={18} className="nsearch__icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={handleKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="nsearch__chip nsearch__chip--button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          ) : (
            <button type="button" className="nsearch__chip nsearch__chip--button" onClick={onClose} aria-label="Close search">
              Esc
            </button>
          )}
        </div>

        {results.length > 0 && (
          <div className="nsearch__panel" id={listId} role="listbox" aria-label="Search results">
            {groups.map(([group, items]) => (
              <div className="nsearch__group" key={group} role="presentation">
                <p className="nsearch__group-label">{group}</p>
                {items.map((item) => {
                  const Icon = ICONS[item.icon] || Search;
                  const isActive = item.index === active;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      id={`${listId}-opt-${item.index}`}
                      role="option"
                      aria-selected={isActive}
                      className={`nsearch__item${isActive ? " nsearch__item--active" : ""}`}
                      onMouseEnter={() => setActive(item.index)}
                      onClick={() => choose(item)}
                    >
                      <span className="nsearch__item-icon"><Icon size={16} /></span>
                      <span className="nsearch__item-text">
                        <span className="nsearch__item-label">{item.label}</span>
                        {item.hint && <span className="nsearch__item-hint">{item.hint}</span>}
                      </span>
                      {isActive && <CornerDownLeft size={13} className="nsearch__item-enter" />}
                    </button>
                  );
                })}
              </div>
            ))}

            <div className="nsearch__footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span><kbd>Enter</kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
              {dataLoading && <span className="nsearch__loading">Loading leads…</span>}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* The search box that sits in the navbar. Clicking it (or pressing   */
/* "/") opens the expanded search above.                              */
/* ------------------------------------------------------------------ */

export default function NavbarSearch() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [startRect, setStartRect] = useState(null);
  const triggerRef = useRef(null);

  const openSearch = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setStartRect(rect ? { top: rect.top, left: rect.left, width: rect.width } : null);
    setOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // "/" opens the search from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) return;
      event.preventDefault();
      openSearch();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSearch]);

  const placeholder = isAdminSide(user?.appRole) ? "Search dealers, leads, logs..." : "Search your leads, pages...";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="navbar__search navbar-search-trigger"
        onClick={openSearch}
        aria-label="Search"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Search size={18} aria-hidden="true" />
        <span className="navbar-search-trigger__text">{placeholder}</span>
        <span className="navbar__search-shortcut">/</span>
      </button>
      {open && <SearchOverlay startRect={startRect} onClose={closeSearch} />}
    </>
  );
}
