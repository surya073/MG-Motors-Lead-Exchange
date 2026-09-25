import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { APP_ROLES } from "../../constants/auth.constants";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { dealerPortalService } from "../../services/api/dealerPortalService";
import { aiAssistantService } from "../../services/api/aiAssistantService";
import "./Overview.css";

// Hero/backdrop artwork — used to give the two overview screens a bit of
// showroom feel instead of reading as a bare data grid. Adjust the import
// path below if this component ever moves out of src/components/Overview.
//
// grayMgCarBg is still used as a faint corner watermark photo on one of
// the Admin panel cards (see AdminOverview) — unrelated to the hero.
// blueMgCarBg / skyBlueMgCarBg were the old hero background photos and
// are no longer used now that the hero is a flat dark graphic instead
// of a photo slideshow.
import grayMgCarBg from "../../assets/dashboardimgs/grayMgCarBg.jpg";
import mgCarPng1 from "../../assets/dashboardimgs/mgcarpng1.png";
import mgCarPng2 from "../../assets/dashboardimgs/mgcarpng2.png";
import mgCarPng3 from "../../assets/dashboardimgs/mgcarpng3.png";
import mgCarPng4 from "../../assets/dashboardimgs/mgcarpng4.png";
import mgLogo from "../../assets/images/logo-morris-garages.png";

// Cutout PNGs the hero cycles through, floating in front of the glow —
// these must be transparent-background car cutouts, not full rectangular
// photos, or the car will show a visible box edge over the glow/map.
const HERO_CAR_CUTOUTS = [mgCarPng1, mgCarPng2, mgCarPng3, mgCarPng4];
const SLIDE_DURATION_MS = 7000;

const STATUS_CARDS = [
  { key: "new", label: "New", color: "var(--color-info, #3B82F6)", icon: "spark" },
  { key: "contacted", label: "Contacted", color: "var(--color-accent, #DC2626)", icon: "phone" },
  { key: "test_drive", label: "Test Drive", color: "var(--color-warning, #F59E0B)", icon: "car" },
  { key: "quotation", label: "Quotation", color: "var(--color-violet, #7C4DDA)", icon: "doc" },
  { key: "delivered", label: "Delivered", color: "var(--color-success, #16A34A)", icon: "check" },
  { key: "lost", label: "Lost", color: "var(--color-danger, #DC2626)", icon: "x" },
];

// Illustrative trend deltas for the admin KPI row until the dashboard
// API returns real period-over-period comparisons (needs a historical
// snapshot table or a date-filtered leads query to compute honestly).
// Swap each entry for adminDashboardService's actual delta once that
// field exists — the shape ({ direction, value }) is what KpiCard
// already expects.
const DUMMY_KPI_DELTAS = {
  dealers: { direction: "up", value: "+6.25%" },
  leads: { direction: "up", value: "+12.5%" },
  pipeline: { direction: "up", value: "+8.3%" },
  conversion: { direction: "up", value: "+1.2%" },
};

export default function Overview() {
  const { user } = useAuth();
  const isDealer = user?.appRole === APP_ROLES.DEALER;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const [drawer, setDrawer] = useState({ open: false, title: "", subtitle: "", content: null });
  const openDrawer = (title, subtitle, content) => setDrawer({ open: true, title, subtitle, content });
  const closeDrawer = () => setDrawer((d) => ({ ...d, open: false }));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = isDealer
          ? await dealerPortalService.myLeadsSummary()
          : await adminDashboardService.dashboardSummary();
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err?.response?.data?.error || "Couldn't load dashboard data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [isDealer]);

  return (
    <>
      {loading ? (
        <OverviewSkeleton isDealer={isDealer} />
      ) : error ? (
        <div className="overview__state overview__state--error">{error}</div>
      ) : (
        <>
          {isDealer ? (
            <DealerOverview summary={data} openDrawer={openDrawer} />
          ) : (
            <AdminOverview data={data} openDrawer={openDrawer} />
          )}
          <Drawer open={drawer.open} onClose={closeDrawer} title={drawer.title} subtitle={drawer.subtitle}>
            {drawer.content}
          </Drawer>
        </>
      )}
      <AIAssistantPanel isDealer={isDealer} />
    </>
  );
}


/* ------------------------------------------------------------------ */
/* Loading skeleton — avoids a layout jump when real data lands       */
/* ------------------------------------------------------------------ */

function OverviewSkeleton({ isDealer }) {
  const kpiCount = isDealer ? 7 : 4;
  return (
    <div className="overview">
      <div className="overview__kpis">
        {Array.from({ length: kpiCount }).map((_, i) => (
          <div className="kpi-card kpi-card--skeleton" key={i}>
            <div className="skeleton-line skeleton-line--sm" />
            <div className="skeleton-line skeleton-line--lg" />
          </div>
        ))}
      </div>
      <div className="skeleton-block" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icons — small hand-rolled line icons so we don't add a new         */
/* dependency. Swap for lucide-react etc. later if the project        */
/* adopts one; call sites only care about the `Icon` prop shape.      */
/* ------------------------------------------------------------------ */

const ICONS = {
  spark: "M12 2l1.6 5.6L19 9l-5.4 1.4L12 16l-1.6-5.6L5 9l5.4-1.4L12 2z",
  phone: "M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z",
  car: "M5 17h14M5 17a2 2 0 100-4 2 2 0 000 4zM19 17a2 2 0 100-4 2 2 0 000 4zM5 13l1.5-4.5A2 2 0 018.4 7h7.2a2 2 0 011.9 1.5L19 13H5z",
  doc: "M8 3h5l5 5v13a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM13 3v5h5",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  users: "M17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M9.5 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  trending: "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
  clock: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15",
  bell: "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9zM13.7 21a2 2 0 01-3.4 0",
  chat: "M21 11.5a8.4 8.4 0 01-1 4 8.5 8.5 0 01-7.5 4.5 8.4 8.4 0 01-4-1L3 20l1-5.5a8.4 8.4 0 01-1-4 8.5 8.5 0 014.5-7.5 8.4 8.4 0 014-1h.5a8.5 8.5 0 018 8v.5z",
  zap: "M13 2L3 14h7l-1 8 10-12h-7l1-8z",
  calendar: "M8 2v4M16 2v4M3 9h18M4 5h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a1 1 0 00.9 1.5h18.6a1 1 0 00.9-1.5L13.7 3.9a1 1 0 00-1.7 0z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  chevron: "M9 18l6-6-6-6",
  chevronDown: "M6 9l6 6 6-6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  building: "M3 21h18M6 21V7l6-4 6 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1",
  download: "M12 3v11m0 0l-4-4m4 4l4-4M4 20h16",
  pencil: "M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z",
  trophy: "M8 21h8M12 17v4M7 4h10v4a5 5 0 01-10 0V4zM7 5H4a3 3 0 003 3M17 5h3a3 3 0 01-3 3",
  mic: "M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v1a7 7 0 01-14 0v-1M12 18v4m-4 0h8",
  square: "M5 5h14v14H5z",
};

function Icon({ name, size = 18, className = "" }) {
  const d = ICONS[name] || ICONS.spark;
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
      <path d={d} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* FadeImage — plain <img> with a shimmer placeholder underneath until */
/* it finishes loading, so photography never pops in with a hard cut. */
/* ------------------------------------------------------------------ */

function FadeImage({ src, alt = "", className = "" }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className={`fade-img ${className}`}>
      {!loaded && <span className="fade-img__placeholder" aria-hidden="true" />}
      <img
        src={src}
        alt={alt}
        className={`fade-img__el${loaded ? " fade-img__el--visible" : ""}`}
        onLoad={() => setLoaded(true)}
        loading="lazy"
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* OverviewHero — the network-overview strip at the top of both       */
/* dashboards: flat dark background, a pulsing dot-map with           */
/* connection lines, a red glow wedge, a floating car cutout that     */
/* cycles on a timer, a gradient two-line title, stat badges, the MG  */
/* logo, and a row of pagination dots tracking the active cutout.     */
/* ------------------------------------------------------------------ */

const MAP_DOTS = [
  { x: 60, y: 90 }, { x: 90, y: 70 }, { x: 120, y: 100 }, { x: 150, y: 60 },
  { x: 180, y: 85 }, { x: 40, y: 130 }, { x: 100, y: 140 }, { x: 200, y: 40 },
  { x: 230, y: 95 }, { x: 70, y: 160 }, { x: 160, y: 130 }, { x: 210, y: 150 },
];

const MAP_HOTSPOTS = [
  { x: 60, y: 90 }, { x: 150, y: 60 }, { x: 210, y: 150 }, { x: 40, y: 130 },
];

function OverviewHero({ eyebrow, title, titleAccent, subtitle, stats = [] }) {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveIdx((i) => (i + 1) % HERO_CAR_CUTOUTS.length);
    }, SLIDE_DURATION_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="overview-hero">
      <div className="overview-hero__map" aria-hidden="true">
        <svg viewBox="0 0 260 200" preserveAspectRatio="xMidYMid slice">
          {MAP_DOTS.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r="1.4" className="overview-hero__map-dot" />
          ))}
          {MAP_HOTSPOTS.map((h, i) => (
            <g key={i}>
              <line x1={h.x} y1={h.y} x2={130} y2={100} className="overview-hero__map-line" />
              <circle cx={h.x} cy={h.y} r="3" className="overview-hero__map-hotspot" />
            </g>
          ))}
        </svg>
      </div>

      <div className="overview-hero__glow" aria-hidden="true" />

      <div className="overview-hero__car-wrap" aria-hidden="true">
        {HERO_CAR_CUTOUTS.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            className={
              "overview-hero__car" + (i === activeIdx ? " overview-hero__car--active" : "")
            }
          />
        ))}
      </div>

      <div className="overview-hero__content">
        <div className="overview-hero__text-in">
          <span className="overview-hero__eyebrow">
            {eyebrow}
            <span className="overview-hero__eyebrow-rule" aria-hidden="true" />
          </span>

          <h1 className="overview-hero__title">
            <span className="overview-hero__title-line">{title}</span>
            {titleAccent && (
              <span className="overview-hero__title-line overview-hero__title-line--accent">
                {titleAccent}
              </span>
            )}
          </h1>

          <p className="overview-hero__subtitle">{subtitle}</p>

          {stats.length > 0 && (
            <div className="overview-hero__stats">
              {stats.map((s) => (
                <div className="overview-hero__stat" key={s.label}>
                  <span className={`overview-hero__stat-icon overview-hero__stat-icon--${s.tone || "neutral"}`}>
                    <Icon name={s.icon} size={16} />
                  </span>
                  <span className="overview-hero__stat-text">
                    <strong>{s.value}</strong>
                    <span>{s.label}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <img src={mgLogo} alt="MG Motor" className="overview-hero__logo" />

      <div className="overview-hero__dots" role="tablist" aria-label="Hero slide">
        {HERO_CAR_CUTOUTS.map((_, i) => (
          <span
            key={i}
            className={"overview-hero__dot" + (i === activeIdx ? " overview-hero__dot--active" : "")}
            role="tab"
            aria-selected={i === activeIdx}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* useCountUp — lightweight number animation for KPI values.          */
/* Design-ready: purely cosmetic, no data dependency.                 */
/* ------------------------------------------------------------------ */

function useCountUp(target, duration = 700) {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) return;
    let raf;
    const start = performance.now();

    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setValue(Math.round(from + (to - from) * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return value;
}

/* ------------------------------------------------------------------ */
/* KpiCard — glassmorphism-lite stat card with a per-tone tinted       */
/* background, a faint watermark icon, an icon badge, an animated      */
/* value, and an optional delta pill. Reused by both dashboards; the   */
/* watermark and delta are opt-in via props so simpler call sites      */
/* (e.g. dealer status cards) don't have to supply them.               */
/* ------------------------------------------------------------------ */

function KpiCard({
  icon,
  label,
  value,
  suffix = "",
  tone = "neutral",
  meta,
  delta, // { direction: "up" | "down", value: "+6.25%" }
  deltaLabel = "vs last 30 days",
  onClick,
  accent = false,
  watermark, // icon name for the large background glyph; defaults to `icon`
}) {
  const animated = useCountUp(typeof value === "number" ? value : Number(value) || 0);
  const displayValue = typeof value === "number" || !Number.isNaN(Number(value)) ? animated : value;

  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`kpi-card kpi-card--v2${accent ? " kpi-card--accent" : ""}${onClick ? " kpi-card--interactive" : ""}`}
      data-tone={tone}
      onClick={onClick}
    >
      <span className="kpi-card__dots" aria-hidden="true" />
      <Icon name={watermark || icon} size={76} className="kpi-card__watermark" />

      <div className="kpi-card__top">
        <span className={`kpi-card__icon kpi-card__icon--${tone}`}>
          <Icon name={icon} size={18} />
        </span>
        {onClick && <Icon name="chevron" size={14} className="kpi-card__chevron" />}
      </div>

      <p className="kpi-card__label">{label}</p>

      <div className="kpi-card__row">
        <span className="kpi-card__value">{displayValue}{suffix}</span>
      </div>

      {meta && <p className="kpi-card__meta">{meta}</p>}

      {delta && (
        <div className="kpi-card__delta-row">
          <span className={`kpi-card__delta kpi-card__delta--${delta.direction}`}>
            <span className="kpi-card__delta-arrow" aria-hidden="true">
              {delta.direction === "down" ? "↘" : "↗"}
            </span>
            {delta.value}
          </span>
          {deltaLabel && <span className="kpi-card__delta-caption">{deltaLabel}</span>}
        </div>
      )}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/* Drawer — generic right-side detail panel. Any card, chart or row   */
/* on the dashboard can push content into this via openDrawer().      */
/* ------------------------------------------------------------------ */

function Drawer({ open, onClose, title, subtitle, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-backdrop${open ? " drawer-backdrop--visible" : ""}`} onClick={onClose} />
      <aside className={`drawer${open ? " drawer--open" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer__header">
          <div>
            <h3 className="drawer__title">{title}</h3>
            {subtitle && <p className="drawer__subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="drawer__close" onClick={onClose} aria-label="Close panel">
            ×
          </button>
        </div>
        <div className="drawer__body">{children}</div>
      </aside>
    </>
  );
}

/** Small reusable stat block used inside drawers. */
function DrawerStat({ label, value }) {
  return (
    <div className="drawer-stat">
      <span className="drawer-stat__value">{value}</span>
      <span className="drawer-stat__label">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ActivityTimeline — reusable timeline used by both dashboards.      */
/* Admin side is now fed real sync_logs events (see AdminOverview);   */
/* dealer side still uses DUMMY_TIMELINE_DEALER until per-lead event  */
/* history exists.                                                    */
/* ------------------------------------------------------------------ */

function ActivityTimeline({ items }) {
  return (
    <ul className="timeline">
      {items.map((item, i) => (
        <li className="timeline__item" key={i}>
          <span className={`timeline__icon timeline__icon--${item.tone || "neutral"}`}>
            <Icon name={item.icon} size={14} />
          </span>
          <div className="timeline__content">
            <p className="timeline__title">{item.title}</p>
            <p className="timeline__meta">{item.meta}</p>
          </div>
          <span className="timeline__time mono">{item.time}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* DonutChart — stroke color is now set via inline `style` instead of */
/* the SVG `stroke` attribute. SVG presentation attributes have the   */
/* lowest possible CSS specificity, so any global rule touching       */
/* `circle` or `svg` (resets, icon-system styles, etc.) can silently  */
/* override it and leave the ring colorless even though the legend    */
/* (which already used inline style) renders fine. Also switched to   */
/* pathLength="100" so dasharray/dashoffset are plain percentages —   */
/* removes circumference math as a possible source of bugs too.       */
/* ------------------------------------------------------------------ */

/**
 * polarToCartesian / describeDonutWedge — small geometry helpers that turn
 * "this segment covers X% to Y% of the ring" into an SVG <path> `d` string
 * for a solid, filled annular wedge (outer arc, straight edge in, inner
 * arc back, straight edge out, close). 0° is at the top (12 o'clock),
 * increasing clockwise, matching how the legend/percentages read.
 */
function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function describeDonutWedge(cx, cy, innerR, outerR, startAngle, endAngle) {
  // Guard the "one segment covers the whole ring" edge case: a 360°
  // sweep degenerates in the arc-flag math below, so split it into two
  // 180° halves instead.
  if (endAngle - startAngle >= 359.999) {
    const mid = startAngle + 180;
    return [
      describeDonutWedge(cx, cy, innerR, outerR, startAngle, mid),
      describeDonutWedge(cx, cy, innerR, outerR, mid, endAngle),
    ].join(" ");
  }

  const startOuter = polarToCartesian(cx, cy, outerR, endAngle);
  const endOuter = polarToCartesian(cx, cy, outerR, startAngle);
  const startInner = polarToCartesian(cx, cy, innerR, endAngle);
  const endInner = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    "M", startOuter.x, startOuter.y,
    "A", outerR, outerR, 0, largeArc, 0, endOuter.x, endOuter.y,
    "L", endInner.x, endInner.y,
    "A", innerR, innerR, 0, largeArc, 1, startInner.x, startInner.y,
    "Z",
  ].join(" ");
}

/*
 * DonutChart — solid filled wedges, not stroked/dashed circles.
 *
 * The previous version stacked six full <circle> elements and used
 * strokeDasharray/strokeDashoffset/pathLength plus a `rotate(...)`
 * transform to make each one *look* like it only covers part of the
 * ring. That's a common technique, but it depends on several finicky
 * things lining up (pathLength support on <circle>, transform-origin
 * behavior on SVG elements combined with a presentation-attribute
 * `transform`) — and evidently something in this app's rendering
 * environment wasn't honoring it, which is why the ring kept coming
 * back empty no matter what color the stroke was set to.
 *
 * This version sidesteps all of that: each segment is computed as an
 * actual annular wedge shape (outer arc + inner arc) and filled
 * directly with its color. There's no stroke, no dasharray, no
 * rotation — just a shape with a fill, which every SVG renderer
 * handles the same way.
 */
function DonutChart({ segments, size = 176, strokeWidth = 26 }) {
  const [activeKey, setActiveKey] = useState(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const outerRadius = size / 2 - 4; // leave 4px breathing room so the hover "pop" never clips
  const innerRadius = outerRadius - strokeWidth;
  const cx = size / 2;
  const cy = size / 2;
  const popOut = 5; // px the active wedge grows outward/inward on hover

  let cumulativeAngle = 0;
  const arcs = segments
    .map((s) => {
      const pct = total > 0 ? s.value / total : 0;
      const startAngle = cumulativeAngle;
      const endAngle = cumulativeAngle + pct * 360;
      cumulativeAngle = endAngle;
      return { ...s, pct, startAngle, endAngle };
    })
    .filter((arc) => arc.pct > 0); // zero-value segments have no shape to draw/hover

  // Draw the active wedge last so its "pop" shadow isn't tucked behind
  // its neighbours, without ever touching a CSS transform (see note below).
  const orderedArcs = activeKey
    ? [...arcs.filter((a) => a.key !== activeKey), ...arcs.filter((a) => a.key === activeKey)]
    : arcs;

  const active = activeKey ? segments.find((s) => s.key === activeKey) : null;
  const centerLabel = active ? active.label : "Total leads";
  const centerValue = active ? active.value : total;

  return (
    <div className="donut">
      <svg
        className="donut__svg"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label="Lead status distribution"
      >
        {/* Faint full-ring track underneath, so any uncovered share (leads
            in a status outside this list) still reads as "ring", not gaps. */}
        <circle
          cx={cx}
          cy={cy}
          r={(innerRadius + outerRadius) / 2}
          fill="none"
          style={{ stroke: "var(--color-surface-alt, #E5E7EB)" }}
          strokeWidth={strokeWidth}
        />

        {orderedArcs.map((arc) => {
          const isActive = activeKey === arc.key;
          // Growing the wedge's own outer/inner radius (rather than a CSS
          // `transform: scale()`) is what actually fixes the hover pop:
          // an annular wedge's bounding box is never centred on the donut,
          // so scaling it from `transform-origin: center` (fill-box) drags
          // the shape sideways instead of growing it in place. Recomputing
          // the path with a slightly larger radius keeps the same centre
          // and pivot the whole time, so it reads as a clean pop, not a skew.
          const r0 = isActive ? innerRadius - popOut * 0.4 : innerRadius;
          const r1 = isActive ? outerRadius + popOut : outerRadius;
          return (
            <path
              key={arc.key}
              d={describeDonutWedge(cx, cy, r0, r1, arc.startAngle, arc.endAngle)}
              className={`donut__segment${isActive ? " donut__segment--active" : ""}`}
              style={{
                fill: arc.color,
                opacity: activeKey && !isActive ? 0.35 : 1,
              }}
              onMouseEnter={() => setActiveKey(arc.key)}
              onMouseLeave={() => setActiveKey(null)}
              tabIndex={0}
              onFocus={() => setActiveKey(arc.key)}
              onBlur={() => setActiveKey(null)}
            >
              <title>{`${arc.label}: ${arc.value} (${Math.round(arc.pct * 100)}%)`}</title>
            </path>
          );
        })}
      </svg>
      <div className="donut__center">
        <span className="donut__center-value">{centerValue}</span>
        <span className="donut__center-label">{centerLabel}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RangeFilter — small pill-style dropdown used by the lead status     */
/* card. Purely a display filter for now: swap the onChange handler   */
/* for a real date-scoped fetch once the summary endpoint accepts a   */
/* range param.                                                        */
/* ------------------------------------------------------------------ */

const RANGE_OPTIONS = [
  { key: "10d", label: "Last 10 days" },
  { key: "1w", label: "Last 7 days" },
  { key: "1m", label: "Last 30 days" },
  { key: "all", label: "All time" },
];

function RangeFilter({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = RANGE_OPTIONS.find((o) => o.key === value) || RANGE_OPTIONS[3];

  return (
    <div className="range-filter">
      <button
        type="button"
        className="range-filter__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Icon name="calendar" size={13} />
        {current.label}
        <Icon name="chevronDown" size={12} className="range-filter__chevron" />
      </button>
      {open && (
        <>
          <div className="range-filter__scrim" onClick={() => setOpen(false)} />
          <ul className="range-filter__menu" role="listbox">
            {RANGE_OPTIONS.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  className={`range-filter__option${o.key === value ? " range-filter__option--active" : ""}`}
                  onClick={() => { onChange(o.key); setOpen(false); }}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DonutLegend({ segments, total, onSelect }) {
  const [activeKey, setActiveKey] = useState(null);
  return (
    <ul className="donut-legend">
      {segments.map((s) => {
        const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
        return (
          <li
            key={s.key}
            className={`donut-legend__item${activeKey === s.key ? " donut-legend__item--active" : ""}${onSelect ? " donut-legend__item--clickable" : ""}`}
            onMouseEnter={() => setActiveKey(s.key)}
            onMouseLeave={() => setActiveKey(null)}
            onClick={() => onSelect && onSelect(s)}
          >
            <span className="donut-legend__dot" style={{ backgroundColor: s.color }} />
            <span className="donut-legend__label">{s.label}</span>
            <span className="donut-legend__value">{s.value}</span>
            <span className="donut-legend__pct">{pct}%</span>
          </li>
        );
      })}
    </ul>
  );
}

/** zigzagPath — plain point-to-point line, no curve smoothing. */
function zigzagPath(coords) {
  if (coords.length === 0) return "";
  return coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
}

/**
 * niceCeiling — rounds a value up to a "friendly" axis ceiling
 * (1 / 2 / 5 × a power of ten), so the y-axis reads 0/20/40/60/80/100
 * style numbers instead of an arbitrary max like "87".
 */
function niceCeiling(value) {
  if (value <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/**
 * Sync volume trend — plots real fetched/inserted/updated/failed
 * counts from a dedicated, deeper sync_logs fetch (see AdminOverview's
 * `trendLogs` state, pulled via adminDashboardService.syncLogs({limit:20})
 * rather than the 5-row dashboard summary). No dummy data: every point
 * and every stat tile is derived from actual sync_logs rows.
 *
 * Layout: icon-badge header with a range dropdown + refresh button,
 * a row of 4 stat tiles, an axis-labelled area/line chart with light
 * gridlines, and a footer with a legend plus edit/export actions.
 */
const SYNC_RUN_OPTIONS = [10, 20, 50];

function SyncTrendChart({ logs }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const [runsLimit, setRunsLimit] = useState(20);

  const points = useMemo(() => {
    return [...logs]
      .slice(0, runsLimit)
      .reverse()
      .map((log) => ({
        label: log.start_time,
        fetched: Number(log.total_records_fetched) || 0,
        inserted: Number(log.records_inserted) || 0,
        updated: Number(log.records_updated) || 0,
        failed: Number(log.records_failed) || 0,
        status: log.status,
        trigger: log.sync_trigger,
        type: log.sync_type,
      }));
  }, [logs, runsLimit]);

  if (points.length === 0) {
    return <p className="overview__empty-note">No sync runs recorded yet.</p>;
  }

  const totalRuns = points.length;
  const successRuns = points.filter((p) => p.status === "Success").length;
  const successRate = Math.round((successRuns / totalRuns) * 100);
  const totalFailed = points.reduce((sum, p) => sum + p.failed, 0);
  const avgFetched = Math.round(points.reduce((sum, p) => sum + p.fetched, 0) / totalRuns);

  const width = 640;
  const height = 220;
  const padX = 8;
  const padTop = 10;
  const padBottom = 28;
  const maxVal = Math.max(1, ...points.map((p) => p.fetched));
  const axisMax = niceCeiling(maxVal);
  const gridSteps = 5; // draws 6 gridlines: 0, 20%, 40%, 60%, 80%, 100% of axisMax

  const xFor = (i) => (points.length === 1
    ? width / 2
    : padX + (i / (points.length - 1)) * (width - padX * 2));
  const yFor = (val) => padTop + (1 - val / axisMax) * (height - padTop - padBottom);

  const coords = points.map((p, i) => ({ ...p, x: xFor(i), y: yFor(p.fetched) }));
  const linePath = zigzagPath(coords);
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${height - padBottom} L ${coords[0].x} ${height - padBottom} Z`;

  const statusColor = (status) =>
    status === "Success" ? "var(--color-success)" : status === "Partial" ? "var(--color-warning)" : "var(--color-danger)";

  const stats = [
    { icon: "check", tone: "success", value: `${successRate}%`, label: "Success rate" },
    { icon: "download", tone: "info", value: avgFetched.toLocaleString(), label: "Avg fetched" },
    { icon: "x", tone: "danger", value: totalFailed.toLocaleString(), label: "Failed runs" },
    { icon: "trending", tone: "neutral", value: totalRuns, label: "Total runs" },
  ];

  return (
    <div className="sync-trend">
      <div className="sync-trend__header">
        <div className="sync-trend__title-group">
          <span className="sync-trend__badge"><Icon name="trending" size={16} /></span>
          <div>
            <h3>Sync volume trend</h3>
            <p>Overview of sync performance over time</p>
          </div>
        </div>
        <div className="sync-trend__controls">
          <div className="sync-trend__runs-picker">
            <button
              type="button"
              className="sync-trend__dropdown"
              onClick={() => setRunsOpen((o) => !o)}
              aria-expanded={runsOpen}
            >
              Last {Math.min(runsLimit, logs.length)} runs <Icon name="chevronDown" size={14} />
            </button>
            {runsOpen && (
              <>
                <div className="sync-trend__runs-scrim" onClick={() => setRunsOpen(false)} />
                <ul className="sync-trend__runs-menu" role="listbox">
                  {SYNC_RUN_OPTIONS.map((n) => (
                    <li key={n}>
                      <button
                        type="button"
                        className={`sync-trend__runs-option${n === runsLimit ? " sync-trend__runs-option--active" : ""}`}
                        onClick={() => { setRunsLimit(n); setRunsOpen(false); }}
                      >
                        Last {n} runs
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="sync-trend__stats">
        {stats.map((s) => (
          <div className="sync-trend__stat" key={s.label}>
            <span className={`sync-trend__stat-icon sync-trend__stat-icon--${s.tone}`}>
              <Icon name={s.icon} size={14} />
            </span>
            <div>
              <span className="sync-trend__stat-value">{s.value}</span>
              <span className="sync-trend__stat-label">{s.label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="sync-trend__chart">
        <div className="sync-trend__yaxis">
          {Array.from({ length: gridSteps + 1 }).map((_, i) => (
            <span key={i}>{Math.round(axisMax - (axisMax / gridSteps) * i)}</span>
          ))}
        </div>

        <div className="sync-trend__plot">
          <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
            <defs>
              <linearGradient id="syncTrendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-danger, #DC2626)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="var(--color-danger, #DC2626)" stopOpacity="0" />
              </linearGradient>
              <marker id="syncTrendArrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10Z" fill="var(--color-danger, #DC2626)" />
              </marker>
            </defs>

            {Array.from({ length: gridSteps + 1 }).map((_, i) => {
              const y = padTop + (i / gridSteps) * (height - padTop - padBottom);
              return (
                <line
                  key={i}
                  x1={padX}
                  x2={width - padX}
                  y1={y}
                  y2={y}
                  stroke="var(--color-border, #E5E7EB)"
                  strokeWidth="1"
                  strokeDasharray={i === 0 ? "4 4" : undefined}
                />
              );
            })}

            <path d={areaPath} fill="url(#syncTrendFill)" stroke="none" />
            <path
              d={linePath}
              fill="none"
              stroke="var(--color-danger, #DC2626)"
              strokeWidth="2.5"
              strokeLinecap="butt"
              strokeLinejoin="miter"
              markerEnd="url(#syncTrendArrow)"
            />

            {coords.map((c, i) => (
              <circle
                key={i}
                cx={c.x}
                cy={c.y}
                r={hoverIdx === i ? 5 : 3}
                style={{ fill: statusColor(c.status) }}
                stroke="var(--color-surface, #fff)"
                strokeWidth="2"
                className="sparkline__dot"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              />
            ))}
          </svg>

          {hoverIdx !== null && (
            <div className="sparkline__tooltip" style={{ left: `${(coords[hoverIdx].x / width) * 100}%` }}>
              <strong>{coords[hoverIdx].fetched.toLocaleString()}</strong> fetched
              <span>{coords[hoverIdx].inserted} inserted · {coords[hoverIdx].updated} updated · {coords[hoverIdx].failed} failed</span>
              <span className="mono">{coords[hoverIdx].type} · {coords[hoverIdx].trigger}</span>
            </div>
          )}

          <div className="sync-trend__xaxis">
            <span>{coords[0].label}</span>
            <span>{coords[coords.length - 1].label}</span>
          </div>
        </div>
      </div>

      <div className="sync-trend__footer">
        <div className="sync-trend__legend">
          <span><span className="sync-trend__legend-swatch sync-trend__legend-swatch--line" /> Sync volume</span>
          <span><span className="sync-trend__legend-swatch sync-trend__legend-swatch--dashed" /> Success threshold (100%)</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Horizontal pipeline / funnel bar — same status data as the donut,
 * shown as a single proportional bar. (unchanged logic)
 */
function PipelineFunnelBar({ segments, total }) {
  return (
    <div className="funnel-bar">
      <div className="funnel-bar__track">
        {segments.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={s.key}
              className="funnel-bar__segment"
              style={{ width: `${pct}%`, backgroundColor: s.color }}
              title={`${s.label}: ${s.value} (${Math.round(pct)}%)`}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * DealerRankList — ranked leaderboard rows with an inline progress bar
 * per dealer, scaled against the top performer. Reads better than a
 * bare bar chart once dealer names get long, and the rank badge gives
 * the "who's winning" read at a glance.
 */
function DealerRankList({ dealers }) {
  const max = Math.max(1, ...dealers.map((d) => d.value));
  const medalTone = ["gold", "silver", "bronze"];

  return (
    <ul className="rank-list">
      {dealers.map((d, i) => {
        const pct = Math.round((d.value / max) * 100);
        return (
          <li className="rank-list__row" key={d.label}>
            <span className={`rank-list__badge${i < 3 ? ` rank-list__badge--${medalTone[i]}` : ""}`}>
              {i + 1}
            </span>
            <div className="rank-list__body">
              <div className="rank-list__top">
                <span className="rank-list__name">{d.label}</span>
                <span className="rank-list__value">{d.value.toLocaleString()} leads</span>
              </div>
              <div className="rank-list__track">
                <div className="rank-list__fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * PipelineStageBar — a stepped, labelled progress meter across the
 * lead lifecycle (New → Contacted → Test Drive → Quotation → Delivered),
 * each stage sized by its share of the pipeline. Sits where a generic
 * "quick actions" grid used to be — this card actually says something.
 */
function PipelineStageBar({ segments, total }) {
  const stages = segments.filter((s) => s.key !== "lost");
  return (
    <div className="stage-bar">
      {stages.map((s) => {
        const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
        return (
          <div className="stage-bar__stage" key={s.key}>
            <div className="stage-bar__head">
              <span className="stage-bar__dot" style={{ backgroundColor: s.color }} />
              <span className="stage-bar__label">{s.label}</span>
              <span className="stage-bar__pct">{pct}%</span>
            </div>
            <div className="stage-bar__track">
              <div
                className="stage-bar__fill"
                style={{ width: `${pct}%`, backgroundColor: s.color }}
              />
            </div>
            <span className="stage-bar__count">{s.value.toLocaleString()} leads</span>
          </div>
        );
      })}
    </div>
  );
}

const ADMIN_AI_SUGGESTIONS = [
  "Top performing dealer",
  "Leads for [dealer name]",
  "How is [dealer name] performing?",
  "Details on lead [customer name]",
  "Network lead summary",
  "Dealers in [region]",
];

const DEALER_AI_SUGGESTIONS = [
  "Show my recent leads",
  "Details on [customer name]",
  "What does 'delivered' mean?",
  "How often does data sync?",
  "My pending leads",
  "How is a lead marked lost?",
];

function AIAssistantPanel({ isDealer }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioPlayerRef = useRef(null);
  const messagesEndRef = useRef(null);


  const busy = sending || recording || transcribing;

  useEffect(() => {
  messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending, transcribing]);

  function historyForApi() {
    return messages.map((m) => ({ role: m.role, text: m.text }));
  }

  async function handleSend(text) {
    const prompt = (text ?? input).trim();
    if (!prompt || busy) return;

    const priorHistory = historyForApi();
    setMessages((m) => [...m, { role: "user", text: prompt }]);
    setInput("");
    setSending(true);
    try {
      const { reply } = await aiAssistantService.ask(prompt, priorHistory);
      setMessages((m) => [...m, { role: "assistant", text: reply }]);
    } catch (err) {
      setMessages((m) => [...m, {
        role: "assistant",
        text: err?.response?.data?.error || "Sorry, I couldn't reach the assistant just now.",
      }]);
    } finally {
      setSending(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find(
        (t) => window.MediaRecorder?.isTypeSupported?.(t)
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        await handleVoiceMessage(blob);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (_) {
      setMessages((m) => [...m, {
        role: "assistant",
        text: "I need microphone access to hear you — please allow it and try again.",
      }]);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function handleVoiceMessage(blob) {
    const priorHistory = historyForApi();
    setTranscribing(true);
    try {
      const { transcript, reply, audio } = await aiAssistantService.askByVoice(blob, priorHistory);
      if (transcript) setMessages((m) => [...m, { role: "user", text: transcript }]);
      setMessages((m) => [...m, { role: "assistant", text: reply }]);
      if (audio && audioPlayerRef.current) {
        audioPlayerRef.current.src = `data:audio/wav;base64,${audio}`;
        audioPlayerRef.current.play().catch(() => {});
      }
    } catch (err) {
      setMessages((m) => [...m, {
        role: "assistant",
        text: err?.response?.data?.error || "Sorry, I couldn't process that recording.",
      }]);
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ai-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open AI Assistant"
      >
        <Icon name="chat" size={22} />
      </button>

      <div className={`ai-panel${open ? " ai-panel--open" : ""}`} role="dialog" aria-label="AI Assistant">
        <div className="ai-panel__header">
          <div className="ai-panel__title">
            <span className="ai-panel__badge"><Icon name="zap" size={14} /></span>
            <div>
              <h3>AI Assistant</h3>
              <p>{isDealer ? "Your dealer copilot" : "Your network copilot"}</p>
            </div>
          </div>
          <button type="button" className="drawer__close" onClick={() => setOpen(false)} aria-label="Close AI Assistant">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="ai-panel__search">
          <Icon name="search" size={15} />
          <input
            type="text"
            placeholder={recording ? "Listening…" : "Ask about leads, dealers, syncs…"}
            value={input}
            disabled={recording || transcribing}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
          />
          <button
            type="button"
            className={`ai-panel__mic${recording ? " ai-panel__mic--recording" : ""}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={sending || transcribing}
            aria-pressed={recording}
            aria-label={recording ? "Stop recording" : "Ask by voice"}
          >
            <Icon name={recording ? "square" : "mic"} size={15} />
          </button>
          <button type="button" onClick={() => handleSend()} disabled={busy} aria-label="Send">
            <Icon name="send" size={15} />
          </button>
        </div>

        <div className="ai-panel__body">
          {messages.length === 0 ? (
            <div className="ai-panel__empty">
              <span className="ai-panel__empty-icon"><Icon name="zap" size={20} /></span>
              <p>Ask me anything about your dashboard, or try a suggestion below.</p>
            </div>
          ) : (
            <div className="ai-panel__messages">
              {messages.map((m, i) => (
                <div key={i} className={`ai-msg ai-msg--${m.role}`}>{m.text}</div>
              ))}
              {(sending || transcribing) && (
                <div className="ai-msg ai-msg--assistant ai-msg--typing">
                  <span className="ai-typing-dot" />
                  <span className="ai-typing-dot" />
                  <span className="ai-typing-dot" />
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="ai-panel__suggestions">
          {(isDealer ? DEALER_AI_SUGGESTIONS : ADMIN_AI_SUGGESTIONS).map((s) => (
            <button type="button" key={s} className="ai-chip" onClick={() => handleSend(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>

        <audio ref={audioPlayerRef} hidden />
      </div>
    </>
  );
}

/* ==================================================================== */
/* NEW — Lead Exchange Health / Middleware Monitoring Dashboard.        */
/* Everything below is additive: no component above this line was      */
/* modified, and the dealer-side dashboard is untouched. Data comes     */
/* entirely from adminDashboardService.getLeadExchangeHealth() and      */
/* .getIntegrationLogs() (see the two new backend routes) — nothing     */
/* here is hardcoded.                                                   */
/* ==================================================================== */

// Trigger source + plain-English description per Happy/Unhappy scenario.
// This is DISPLAY TEXT ONLY — every count, dealer-affected number and
// timestamp shown next to it comes from the real integration_logs rows
// the backend returns; this map never supplies a number. Matches the
// same 15-path register already used in LeadDetailView.jsx and
// pathPolicyService.js, so a lead's detail view and this dashboard never
// disagree on what a given path means.
const SCENARIO_META = {
  "Happy 1": { trigger: "OEM CRM", description: "New enquiry validated and routed to the dealer CRM successfully." },
  "Happy 2": { trigger: "Dealer CRM", description: "Dealer progresses the enquiry; status changes sync back automatically." },
  "Happy 3": { trigger: "Middleware", description: "A duplicate enquiry was detected and safely linked instead of resent." },
  "Happy 4": { trigger: "Scheduler", description: "Delivery recovered after an outage; queued enquiries replayed without duplicates." },
  "Happy 5": { trigger: "Dealer CRM", description: "Dealer-side field updates synchronised back to the OEM." },
  "Unhappy 1": { trigger: "Middleware", description: "Push to the dealer failed (timeout / 5xx / connection error) — retried automatically." },
  "Unhappy 2": { trigger: "Middleware", description: "Mandatory data missing or invalid on ingest — held, not retried." },
  "Unhappy 3": { trigger: "Scheduler", description: "Dealer unavailable — failure unresolved past the 24h escalation window." },
  "Unhappy 4": { trigger: "Middleware", description: "A dealer status update could not be written back to the OEM." },
  "Unhappy 5": { trigger: "Middleware", description: "Routing failed — no dealer, ambiguous dealer, or invalid mapping." },
  "Unhappy 6": { trigger: "Middleware", description: "OEM and dealer both changed the same field — resolved by ownership rules." },
  "Unhappy 7": { trigger: "Middleware", description: "A status update arrived before its enquiry record existed — held for replay." },
  "Unhappy 8": { trigger: "Middleware", description: "Consent/privacy data missing or mismatched — held pending validation." },
  "Unhappy 9": { trigger: "Dealer CRM", description: "Dealer explicitly marked the enquiry as spam or junk." },
  "Unhappy 10": { trigger: "Scheduler", description: "Dealer took no action within the SLA window — escalated." },
  "Unhappy 11": { trigger: "Middleware", description: "Partial transaction — OEM recorded delivery but the dealer record is missing." },
  "Unhappy 12": { trigger: "Scheduler", description: "Dealer CRM migration/offboarding — enquiry re-routed." },
};

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

/** One Happy/Unhappy path card — count + dealers affected + last occurrence are all real. */
function PathCard({ scenario }) {
  const meta = SCENARIO_META[scenario.name] || {};
  return (
    <div className={`path-card path-card--${scenario.type}`}>
      <div className="path-card__top">
        <span className={`path-card__badge path-card__badge--${scenario.type}`}>{scenario.name}</span>
        <span className="path-card__count">{scenario.count}</span>
      </div>
      <p className="path-card__title">{scenario.message || meta.description || scenario.name}</p>
      {meta.description && scenario.message && meta.description !== scenario.message && (
        <p className="path-card__desc">{meta.description}</p>
      )}
      <div className="path-card__meta-row">
        {meta.trigger && <span>Trigger: {meta.trigger}</span>}
        <span>Dealers affected: {scenario.dealersAffected}</span>
      </div>
      <p className="path-card__time mono">Last occurrence: {scenario.lastOccurrence || "—"}</p>
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
    <div className="panel-card overview__table">
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
        <div className="skeleton-block" style={{ height: 200 }} />
      ) : error ? (
        <div className="overview__state overview__state--error">{error}</div>
      ) : data.logs.length === 0 ? (
        <p className="overview__empty-note">No integration activity found for the selected filters.</p>
      ) : (
        <>
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

/**
 * LeadExchangeHealthPanel — owns the date-range/dealer filter state,
 * fetches getLeadExchangeHealth() once per "Apply", and renders the
 * health summary cards, Happy/Unhappy Path cards, the Error Report,
 * Dealer Health and SLA/Duplicate Leads sections. This is the single
 * new addition wired into AdminOverview below.
 */
function LeadExchangeHealthPanel() {
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

  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Dealer list for the filter dropdown — fetched once, reused by both
  // the filter bar and the Error Report's own dealer filter, so it is
  // never re-fetched on every filter change.
  useEffect(() => {
    adminDashboardService.listDealers().then(setDealers).catch(() => setDealers([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminDashboardService.getLeadExchangeHealth(appliedFilters)
      .then((result) => { if (!cancelled) setHealth(result); })
      .catch((err) => { if (!cancelled) setError(err?.response?.data?.error || "Couldn't load Lead Exchange health."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [appliedFilters]);

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
    <div className="health-panel">
      <div className="panel-card">
        <div className="panel-card__header">
          <h3>Lead Exchange Overview</h3>
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

      {loading ? (
        <div className="skeleton-block" style={{ height: 200 }} />
      ) : error ? (
        <div className="overview__state overview__state--error">
          {error}
          <button type="button" className="health-filterbar__apply" style={{ marginLeft: 12 }} onClick={handleApply}>
            Retry
          </button>
        </div>
      ) : !health ? null : (
        <>
          <div className="overview__kpis">
            <KpiCard icon="car" label="Total Leads" value={health.leadStatusSummary.total} tone="info" meta="In selected range" />
            <KpiCard icon="check" label="Successful" value={health.exchangeHealth.successfulExchanges} tone="success" />
            <KpiCard icon="x" label="Failed" value={health.exchangeHealth.failedExchanges} tone="danger" />
            <KpiCard icon="trending" label="Success Rate" value={health.exchangeHealth.successRate} suffix="%" tone="violet" />
            <KpiCard
              icon="alert"
              label="SLA Breaches"
              value={health.sla.breached}
              tone="danger"
              meta={`${health.sla.breachPercent}% of ${health.sla.monitored} monitored`}
            />
            <KpiCard
              icon="refresh"
              label="Duplicate Leads"
              value={health.duplicates.total}
              tone="warning"
              meta={`${health.duplicates.dealersAffected} dealer(s) affected`}
            />
            <KpiCard
              icon="building"
              label="Inactive Dealers"
              value={health.dealerHealth.noSuccessfulSyncInRange}
              tone="danger"
              meta={`of ${health.dealerHealth.total} dealers`}
            />
            <KpiCard icon="check" label="Active Dealers" value={health.dealerHealth.activeInRange} tone="success" />
          </div>

          {health.truncated && (
            <p className="overview__empty-note">
              This range has more integration events than a single fetch covers — narrow the date range for a complete count.
            </p>
          )}

          <div className="panel-card">
            <div className="panel-card__header"><h3>Happy Paths</h3></div>
            {health.happyPaths.length === 0 ? (
              <p className="overview__empty-note">No successful integration flows in this range.</p>
            ) : (
              <div className="path-card-grid">
                {health.happyPaths.map((s) => <PathCard key={s.name} scenario={s} />)}
              </div>
            )}
          </div>

          <div className="panel-card">
            <div className="panel-card__header"><h3>Unhappy Paths</h3></div>
            {health.unhappyPaths.length === 0 ? (
              <p className="overview__empty-note">No integration failures in this range.</p>
            ) : (
              <div className="path-card-grid">
                {health.unhappyPaths.map((s) => <PathCard key={s.name} scenario={s} />)}
              </div>
            )}
          </div>

          <ErrorReportTable
            fromDate={appliedFilters.fromDate}
            toDate={appliedFilters.toDate}
            dealerCode={appliedFilters.dealerCode}
            dealers={dealers}
          />

          <div className="overview__mid">
            <div className="panel-card">
              <div className="panel-card__header"><h3>Dealer Health</h3></div>
              <div className="drawer-stats">
                <DrawerStat label="Total dealers" value={health.dealerHealth.total} />
                <DrawerStat label="Active" value={health.dealerHealth.activeInRange} />
                <DrawerStat label="No successful sync" value={health.dealerHealth.noSuccessfulSyncInRange} />
                <DrawerStat label="With errors" value={health.dealerHealth.withErrorsInRange} />
              </div>
              <p className="drawer-note">{health.dealerHealth.definitionNote}</p>
            </div>

            <div className="panel-card">
              <div className="panel-card__header"><h3>SLA Monitoring</h3></div>
              <div className="drawer-stats">
                <DrawerStat label="Monitored" value={health.sla.monitored} />
                <DrawerStat label="Met" value={health.sla.met} />
                <DrawerStat label="Breached" value={health.sla.breached} />
                <DrawerStat label="Breach %" value={`${health.sla.breachPercent}%`} />
                <DrawerStat label="Avg breach" value={health.sla.avgBreachMinutes != null ? `${health.sla.avgBreachMinutes} min` : "—"} />
                <DrawerStat label="Max breach" value={health.sla.maxBreachMinutes != null ? `${health.sla.maxBreachMinutes} min` : "—"} />
              </div>
              {health.sla.recentBreaches.length > 0 && (
                <ul className="task-list">
                  {health.sla.recentBreaches.slice(0, 5).map((b, i) => (
                    <li className="task-list__item" key={i}>
                      <span className="task-list__title">{b.dealerCode || "—"} · {b.leadId || "—"}</span>
                      <span className="task-list__time mono">
                        {b.breachDurationMinutes != null ? `${b.breachDurationMinutes} min over` : b.date}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header"><h3>Duplicate Leads</h3></div>
            <div className="drawer-stats">
              <DrawerStat label="Total leads" value={health.leadStatusSummary.total} />
              <DrawerStat label="Duplicates" value={health.duplicates.total} />
              <DrawerStat
                label="Duplicate %"
                value={health.leadStatusSummary.total > 0
                  ? `${Math.round((health.duplicates.total / health.leadStatusSummary.total) * 100)}%`
                  : "0%"}
              />
              <DrawerStat label="Dealers affected" value={health.duplicates.dealersAffected} />
            </div>
            {health.duplicates.recent.length > 0 && (
              <ul className="task-list">
                {health.duplicates.recent.slice(0, 5).map((d, i) => (
                  <li className="task-list__item" key={i}>
                    <span className="task-list__title">
                      {d.dealerCode || "—"} · linked {d.linkedLeadId || "—"} → {d.originalLeadId || "—"}
                    </span>
                    <span className="task-list__time mono">
                      {d.gapMinutes != null ? `${d.gapMinutes} min gap` : d.date}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dummy data helpers — STILL DUMMY, clearly isolated so they're      */
/* trivial to swap for real API responses later. Each block below is  */
/* labelled with exactly what backend support it needs.               */
/* ------------------------------------------------------------------ */

// Dealer-side timeline — needs an updated_at/status-history column on
// leads (or a lead_activity_log table) to become real, same gap noted
// for the admin timeline in adminDashboardService.js.
const DUMMY_TIMELINE_DEALER = [
  { icon: "phone", tone: "accent", title: "Follow-up call logged", meta: "Lead: R. Sharma — Test Drive stage", time: "20 min ago" },
  { icon: "check", tone: "success", title: "Lead closed — delivered", meta: "MG Hector · A. Fernandes", time: "1 hr ago" },
  { icon: "spark", tone: "info", title: "New lead assigned", meta: "MG Astor enquiry", time: "3 hr ago" },
  { icon: "calendar", tone: "warning", title: "Test drive scheduled", meta: "Tomorrow, 11:00 AM", time: "4 hr ago" },
];

// Needs: a tasks/reminders table (dealer-scoped) — nothing like this
// exists in the current schema.
const DUMMY_NOTIFICATIONS = [
  { icon: "bell", title: "3 leads waiting over 48 hrs", tone: "warning" },
  { icon: "check", title: "Monthly target 82% complete", tone: "success" },
  { icon: "refresh", title: "Your data last synced 6 min ago", tone: "info" },
];

const DUMMY_TASKS = [
  { icon: "phone", title: "Call back R. Sharma", time: "Today, 3:00 PM" },
  { icon: "car", title: "Test drive — MG4 Electric", time: "Today, 5:30 PM" },
  { icon: "doc", title: "Send quotation to A. Iyer", time: "Tomorrow, 10:00 AM" },
];

/* ------------------------------------------------------------------ */
/* Dealer view                                                        */
/* ------------------------------------------------------------------ */

function DealerOverview({ summary, openDrawer }) {
  const segments = STATUS_CARDS.map((c) => ({ ...c, value: summary[c.key] || 0 }));
  const conversionPct = summary.total > 0
    ? Math.round(((summary.delivered || 0) / summary.total) * 100)
    : 0;

  function openStatusDetail(segment) {
    openDrawer(segment.label, "Lead status breakdown", (
      <>
        <div className="drawer-stats">
          <DrawerStat label="Count" value={segment.value} />
          <DrawerStat label="Share of total" value={`${summary.total > 0 ? Math.round((segment.value / summary.total) * 100) : 0}%`} />
        </div>
        <p className="drawer-note">
          Detailed record list for this status will appear here once the leads
          endpoint supports server-side status filtering from this panel.
        </p>
      </>
    ));
  }

  return (
    <div className="overview">
      <OverviewHero
        eyebrow="Dealer portal"
        title="Your leads,"
        titleAccent="at a glance"
        subtitle={`${summary.total || 0} leads in your pipeline`}
        stats={[
          { icon: "car", value: summary.total || 0, label: "Total leads", tone: "danger" },
          { icon: "check", value: summary.delivered || 0, label: "Delivered", tone: "accent" },
          { icon: "clock", value: summary.pending || 0, label: "Pending", tone: "success" },
        ]}
      />

      <div className="overview__kpis">
        <KpiCard icon="car" label="Total leads" value={summary.total} tone="accent" accent />
        {STATUS_CARDS.map((c) => (
          <KpiCard
            key={c.key}
            icon={c.icon}
            label={c.label}
            value={summary[c.key] || 0}
            tone={c.key === "lost" ? "danger" : c.key === "delivered" ? "success" : "neutral"}
            onClick={() => openStatusDetail({ ...c, value: summary[c.key] || 0 })}
          />
        ))}
      </div>

      <div className="panel-card panel-card--art">
        <FadeImage src={mgCarPng4} alt="" className="panel-card__watermark-img" />
        <div className="panel-card__header">
          <h3>Your pipeline</h3>
          <span className="panel-card__meta">{conversionPct}% delivered</span>
        </div>
        <PipelineFunnelBar segments={segments} total={summary.total} />
        <DonutLegend segments={segments} total={summary.total} onSelect={openStatusDetail} />
      </div>

      <div className="overview__mid">
        <div className="panel-card">
          <div className="panel-card__header">
            <h3>Upcoming tasks</h3>
            <span className="panel-card__meta panel-card__meta--dummy">Sample data</span>
          </div>
          <ul className="task-list">
            {DUMMY_TASKS.map((t, i) => (
              <li className="task-list__item" key={i}>
                <span className="task-list__icon"><Icon name={t.icon} size={14} /></span>
                <span className="task-list__title">{t.title}</span>
                <span className="task-list__time mono">{t.time}</span>
              </li>
            ))}
          </ul>
          <div className="panel-card__header panel-card__header--tight">
            <h3>Notifications</h3>
            <span className="panel-card__meta panel-card__meta--dummy">Sample data</span>
          </div>
          <ul className="notif-list">
            {DUMMY_NOTIFICATIONS.map((n, i) => (
              <li className={`notif-list__item notif-list__item--${n.tone}`} key={i}>
                <Icon name={n.icon} size={14} />
                <span>{n.title}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel-card">
          <div className="panel-card__header">
            <h3>Recent activity</h3>
            <span className="panel-card__meta panel-card__meta--dummy">Sample data</span>
          </div>
          <ActivityTimeline items={DUMMY_TIMELINE_DEALER} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Admin / Super Admin landing view                                   */
/* ------------------------------------------------------------------ */

function AdminOverview({ data, openDrawer }) {
  const {
    totalDealers,
    totalLeads,
    leadStatusSummary,
    dealerStatusSummary,
    topDealers,
    activityTimeline,
    recentSyncLogs,
  } = data;

  const segments = STATUS_CARDS.map((c) => ({ ...c, value: leadStatusSummary[c.key] || 0 }));
  const activePipeline = (leadStatusSummary.new || 0)
    + (leadStatusSummary.contacted || 0)
    + (leadStatusSummary.test_drive || 0)
    + (leadStatusSummary.quotation || 0);
  const conversionPct = totalLeads > 0
    ? Math.round(((leadStatusSummary.delivered || 0) / totalLeads) * 100)
    : 0;

  // Real values from dealerStatusSummary (adminDashboardService.js →
  // summarizeDealerStatus) — no more * 0.85 estimate.
  const {
    active: activeDealers = 0,
    inactive: inactiveDealers = 0,
    pending: pendingDealers = 0,
  } = dealerStatusSummary || {};

  // Dealer performance comparison reads real topDealers (ranked by lead
  // volume) instead of the old DUMMY_TOP_DEALERS score.
  const dealerComparison = useMemo(
    () => (topDealers || []).map((d) => ({ label: d.name?.replace("MG ", "") || d.dealer_code, value: d.total_leads })),
    [topDealers]
  );

  const [leadRange, setLeadRange] = useState("1m");

  // Dedicated deeper sync-log fetch for the trend chart — decoupled
  // from the 5-row recentSyncLogs used by the activity table, so the
  // chart has enough real points to draw a meaningful curve.
  const [trendLogs, setTrendLogs] = useState(recentSyncLogs);
  const [trendLoading, setTrendLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    adminDashboardService.syncLogs({ limit: 20 })
      .then((logs) => { if (!cancelled) setTrendLogs(logs); })
      .catch(() => { /* falls back to the 5-row summary already in state */ })
      .finally(() => { if (!cancelled) setTrendLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const recentlySyncedDealers = useMemo(
    () => recentSyncLogs.filter((l) => l.sync_type?.toLowerCase().includes("dealer")).slice(0, 5),
    [recentSyncLogs]
  );

  function openDealerDetail(dealer) {
    openDrawer(dealer.name, `${dealer.region} · ${dealer.conversion_rate}% conversion`, (
      <>
        <div className="drawer-stats">
          <DrawerStat label="Total leads" value={dealer.total_leads} />
          <DrawerStat label="Delivered" value={dealer.delivered} />
          <DrawerStat label="Conversion" value={`${dealer.conversion_rate}%`} />
          <DrawerStat label="Region" value={dealer.region} />
        </div>
      </>
    ));
  }

  function openStatusDetail(segment) {
    openDrawer(segment.label, "Network-wide lead status", (
      <>
        <div className="drawer-stats">
          <DrawerStat label="Count" value={segment.value} />
          <DrawerStat label="Share of total" value={`${totalLeads > 0 ? Math.round((segment.value / totalLeads) * 100) : 0}%`} />
        </div>
      </>
    ));
  }

  return (
    <div className="overview">
      <OverviewHero
        eyebrow="Network overview"
        title="MG Motor"
        titleAccent="Lead Exchange"
        subtitle={`${totalDealers} dealers · ${totalLeads} leads across the network`}
        stats={[
          { icon: "building", value: totalDealers, label: "Dealers", tone: "danger" },
          { icon: "car", value: totalLeads, label: "Total leads", tone: "accent" },
          { icon: "users", value: activeDealers, label: "Active today", tone: "success" },
        ]}
      />

      <div className="overview__kpis">
        <KpiCard
          icon="building"
          label="Total dealers"
          value={totalDealers}
          tone="danger"
          meta={`${activeDealers} active · ${inactiveDealers} inactive${pendingDealers ? ` · ${pendingDealers} pending` : ""}`}
          delta={DUMMY_KPI_DELTAS.dealers}
          onClick={() => openDrawer("Dealer summary", "Network overview", (
            <div className="drawer-stats">
              <DrawerStat label="Total" value={totalDealers} />
              <DrawerStat label="Active" value={activeDealers} />
              <DrawerStat label="Inactive" value={inactiveDealers} />
              <DrawerStat label="Pending" value={pendingDealers} />
            </div>
          ))}
        />
        <KpiCard
          icon="car"
          label="Total leads"
          value={totalLeads}
          tone="info"
          meta="Across all dealers"
          delta={DUMMY_KPI_DELTAS.leads}
          onClick={() => openStatusDetail({ label: "All leads", value: totalLeads })}
        />
        <KpiCard
          icon="trending"
          label="Active pipeline"
          value={activePipeline}
          tone="success"
          meta="Leads in progress"
          delta={DUMMY_KPI_DELTAS.pipeline}
        />
        <KpiCard
          icon="check"
          label="Conversion rate"
          value={conversionPct}
          suffix="%"
          tone="violet"
          meta="From pipeline"
          delta={DUMMY_KPI_DELTAS.conversion}
          accent
        />
      </div>

      {/* NEW — Lead Exchange Health / Middleware Monitoring dashboard.
          Self-contained: owns its own date-range/dealer filters and
          fetches its own data (getLeadExchangeHealth / getIntegrationLogs),
          independent of the dashboardSummary-driven sections below. */}
      <LeadExchangeHealthPanel />

      <div className="panel-card">
        <div className="panel-card__header">
          <h3>Lead status distribution</h3>
          <RangeFilter value={leadRange} onChange={setLeadRange} />
        </div>
        <div className="overview__donut-row">
          <DonutChart segments={segments} />
          <DonutLegend segments={segments} total={totalLeads} onSelect={openStatusDetail} />
        </div>
      </div>

      <div className="panel-card">
        {trendLoading ? (
          <div className="skeleton-block" style={{ height: 280 }} />
        ) : (
          <SyncTrendChart logs={trendLogs} />
        )}
      </div>

      <div className="overview__mid">
        <div className="panel-card panel-card--art">
          <FadeImage src={mgCarPng3} alt="" className="panel-card__watermark-img" />
          <div className="panel-card__header">
            <h3>Dealer performance comparison</h3>
            <span className="panel-card__meta">By lead volume</span>
          </div>
          {dealerComparison.length === 0 ? (
            <p className="overview__empty-note">No dealers with leads yet.</p>
          ) : (
            <DealerRankList dealers={dealerComparison} />
          )}
        </div>

        <div className="panel-card panel-card--art">
          <FadeImage src={grayMgCarBg} alt="" className="panel-card__watermark-img panel-card__watermark-img--bg" />
          <div className="panel-card__header">
            <h3>Pipeline progress</h3>
            <span className="panel-card__meta">Share of active leads</span>
          </div>
          <PipelineStageBar segments={segments} total={totalLeads} />
        </div>
      </div>

      <div className="overview__mid">
        <div className="panel-card">
          <div className="panel-card__header">
            <h3>Top performing dealers</h3>
            <span className="panel-card__meta">By lead volume</span>
          </div>
          {(topDealers || []).length === 0 ? (
            <p className="overview__empty-note">No dealers with leads yet.</p>
          ) : (
            <ul className="dealer-list">
              {topDealers.map((d) => (
                <li key={d.dealer_code} className="dealer-list__item" onClick={() => openDealerDetail(d)}>
                  <span className="dealer-list__avatar">{d.name?.split(" ")[1]?.[0] || d.name?.[0] || "?"}</span>
                  <div className="dealer-list__info">
                    <span className="dealer-list__name">{d.name}</span>
                    <span className="dealer-list__region">{d.region}</span>
                  </div>
                  <span className="dealer-list__score">{d.total_leads} leads</span>
                  <Icon name="chevron" size={14} className="dealer-list__chevron" />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel-card">
          <div className="panel-card__header"><h3>Recently synced dealers</h3></div>
          {recentlySyncedDealers.length === 0 ? (
            <p className="overview__empty-note">No dealer sync runs recorded yet.</p>
          ) : (
            <ul className="dealer-list">
              {recentlySyncedDealers.map((log) => (
                <li key={log.ROWID} className="dealer-list__item dealer-list__item--static">
                  <span className="dealer-list__avatar"><Icon name="refresh" size={14} /></span>
                  <div className="dealer-list__info">
                    <span className="dealer-list__name">{log.sync_trigger}</span>
                    <span className="dealer-list__region mono">{log.start_time}</span>
                  </div>
                  <span
                    className={`status-pill status-pill--${
                      log.status === "Success" ? "success" : log.status === "Partial" ? "pending" : "danger"
                    }`}
                  >
                    {log.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card__header">
          <h3>Recent activity</h3>
        </div>
        {(activityTimeline || []).length === 0 ? (
          <p className="overview__empty-note">No sync activity recorded yet.</p>
        ) : (
          <ActivityTimeline items={activityTimeline} />
        )}
      </div>

      <div className="panel-card overview__table">
        <div className="panel-card__header">
          <h3>Recent sync activity</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Trigger</th>
              <th>Fetched</th>
              <th>Inserted</th>
              <th>Updated</th>
              <th>Failed</th>
              <th>Status</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {recentSyncLogs.map((log) => (
              <tr
                key={log.ROWID}
                className="overview__table-row"
                onClick={() => openDrawer("Sync run", log.start_time, (
                  <>
                    <div className="drawer-stats">
                      <DrawerStat label="Fetched" value={log.total_records_fetched} />
                      <DrawerStat label="Inserted" value={log.records_inserted} />
                      <DrawerStat label="Updated" value={log.records_updated} />
                      <DrawerStat label="Failed" value={log.records_failed} />
                    </div>
                    <p className="drawer-note">Type: {log.sync_type} · Trigger: {log.sync_trigger} · Status: {log.status}</p>
                  </>
                ))}
              >
                <td>{log.sync_type}</td>
                <td>{log.sync_trigger}</td>
                <td>{log.total_records_fetched}</td>
                <td>{log.records_inserted}</td>
                <td>{log.records_updated}</td>
                <td className={Number(log.records_failed) > 0 ? "text-danger" : undefined}>
                  {log.records_failed}
                </td>
                <td>
                  <span
                    className={`status-pill status-pill--${
                      log.status === "Success" ? "success" : log.status === "Partial" ? "pending" : "danger"
                    }`}
                  >
                    {log.status}
                  </span>
                </td>
                <td className="mono">{log.start_time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}