// src/ui/Offcanvas/DealerDetailsTabs.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Fingerprint,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  TrendingUp,
  Users,
} from "lucide-react";
import Badge from "../Badge/Badge";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { dealerCrmIntegrationService } from "../../services/api/dealerCrmIntegrationService";
import { ROUTES } from "../../constants/routes.constants";
import "./DealerDetailsTabs.css";

/* ---------------------------------------------------------------- helpers */

const DAY_MS = 86400000;

function parseTime(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  const d = new Date(m ? `${m[1]}T${m[2]}` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(v) {
  const d = parseTime(v);
  return d ? d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function fmtShortDay(d) {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function leadTone(status) {
  const s = String(status || "").toLowerCase();
  if (/convert|deliver/.test(s)) return "success";
  if (/lost|drop|not qualified|reject|unavailable|unattended/.test(s)) return "danger";
  if (/progress|future|pending|quotation|test drive/.test(s)) return "warning";
  if (/contact|follow|new/.test(s)) return "info";
  return "neutral";
}

const TONE_VAR = {
  success: "var(--color-success)",
  danger: "var(--color-danger)",
  warning: "var(--color-warning)",
  info: "var(--color-info)",
  neutral: "var(--color-text-muted)",
};

function isLogSuccess(log) {
  return String(log.status || "").toUpperCase() === "SUCCESS";
}

function cellText(v) {
  return v && String(v).trim() ? v : "—";
}

function syncBadgeTone(status) {
  if (status === "Removed" || status === "Error") return "danger";
  if (status === "Synced" || status === "Active") return "active";
  if (status === "Pending" || status === "Syncing") return "pending";
  return "neutral";
}

/* ------------------------------------------------------------------ data */

/** Per-dealer leads + integration logs, fetched once when the dealer changes. */
export function useDealerActivity(dealerCode) {
  const [state, setState] = useState({ loading: true, leads: [], logs: [], leadsError: false, logsError: false });

  useEffect(() => {
    if (!dealerCode) return undefined;
    let cancelled = false;
    setState({ loading: true, leads: [], logs: [], leadsError: false, logsError: false });
    Promise.allSettled([
      adminDashboardService.listLeads({ dealerCode }),
      dealerCrmIntegrationService.getLogs(dealerCode),
    ]).then(([leadsRes, logsRes]) => {
      if (cancelled) return;
      const logsData = logsRes.status === "fulfilled" ? logsRes.value : null;
      setState({
        loading: false,
        leads: leadsRes.status === "fulfilled" ? leadsRes.value || [] : [],
        logs: Array.isArray(logsData) ? logsData : logsData?.logs || [],
        leadsError: leadsRes.status === "rejected",
        logsError: logsRes.status === "rejected",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dealerCode]);

  return state;
}

/* ------------------------------------------------------------- UI pieces */

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="dd-tooltip">
      <strong>{label}</strong>
      {payload.map((p) => (
        <span key={p.dataKey}>
          <i style={{ background: p.color }} />
          {p.name}: {p.value}
        </span>
      ))}
    </div>
  );
}

function KpiTile({ icon: Icon, label, value, hint, tone = "neutral" }) {
  return (
    <div className={`dd-kpi dd-kpi--${tone}`}>
      <span className="dd-kpi__icon">
        <Icon size={16} />
      </span>
      <div>
        <span className="dd-kpi__label">{label}</span>
        <span className="dd-kpi__value">{value}</span>
        {hint && <span className="dd-kpi__hint">{hint}</span>}
      </div>
    </div>
  );
}

function Card({ icon: Icon, title, aside, children }) {
  return (
    <section className="dd-card">
      <header className="dd-card__head">
        <h3>
          <Icon size={14} /> {title}
        </h3>
        {aside && <span className="dd-card__aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Empty({ icon: Icon, children }) {
  return (
    <div className="dd-empty">
      <Icon size={20} />
      <p>{children}</p>
    </div>
  );
}

function Skeleton({ rows = 3 }) {
  return (
    <div className="dd-skeleton" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} className="dd-skeleton__bar" />
      ))}
    </div>
  );
}

function Ring({ percent, tone }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 80 80" className="dd-ring" aria-hidden="true">
      <circle cx="40" cy="40" r={r} className="dd-ring__track" />
      <circle
        cx="40"
        cy="40"
        r={r}
        className="dd-ring__bar"
        style={{ stroke: TONE_VAR[tone], strokeDasharray: `${(percent / 100) * c} ${c}` }}
        transform="rotate(-90 40 40)"
      />
      <text x="40" y="45" textAnchor="middle" className="dd-ring__text">
        {Math.round(percent)}%
      </text>
    </svg>
  );
}

function buildDailySeries(items, getDate, days, isOk) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * DAY_MS);
    buckets.push({ key: dayKey(d), label: fmtShortDay(d), total: 0, ok: 0, failed: 0 });
  }
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
  items.forEach((item) => {
    const d = parseTime(getDate(item));
    const b = d && byKey[dayKey(d)];
    if (!b) return;
    b.total += 1;
    if (isOk) {
      if (isOk(item)) b.ok += 1;
      else b.failed += 1;
    }
  });
  return buckets;
}

function WaveChart({ data, series, height = 170 }) {
  return (
    <div className="dd-chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`dd-grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.45} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={22}
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
          />
          <Tooltip content={<ChartTooltip />} />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2.2}
              fill={`url(#dd-grad-${s.key})`}
              dot={false}
              activeDot={{ r: 3.5 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ProgressRow({ label, count, total, tone }) {
  const pct = total ? (count / total) * 100 : 0;
  return (
    <div className="dd-progress">
      <div className="dd-progress__top">
        <span>{label}</span>
        <strong>
          {count} <em>{Math.round(pct)}%</em>
        </strong>
      </div>
      <div className="dd-progress__track">
        <span className="dd-progress__fill" style={{ width: `${pct}%`, background: TONE_VAR[tone] }} />
      </div>
    </div>
  );
}

function InfoCard({ icon: Icon, label, children, mono }) {
  return (
    <div className="dd-contact">
      <span className="dd-contact__icon">
        <Icon size={18} />
      </span>
      <div>
        <span className="dd-contact__label">{label}</span>
        <span className={`dd-contact__value ${mono ? "dd-contact__value--mono" : ""}`}>{children}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tabs */

export function OverviewTab({ dealer, activity }) {
  const { loading, leads, logs } = activity;

  const stats = useMemo(() => {
    const active = leads.filter((l) => l.sync_status !== "Removed");
    const byStatus = {};
    active.forEach((l) => {
      const s = l.lead_status || "Unknown";
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    const statusRows = Object.entries(byStatus)
      .map(([status, count]) => ({ status, count, tone: leadTone(status) }))
      .sort((a, b) => b.count - a.count);
    const converted = active.filter((l) => leadTone(l.lead_status) === "success").length;
    const ok = logs.filter(isLogSuccess).length;
    return {
      total: active.length,
      converted,
      conversion: active.length ? (converted / active.length) * 100 : 0,
      statusRows,
      syncRate: logs.length ? (ok / logs.length) * 100 : null,
      failed: logs.length - ok,
      leadSeries: buildDailySeries(active, (l) => l.CREATEDTIME, 14),
      syncSeries: buildDailySeries(logs, (l) => l.created_at || l.CREATEDTIME, 14, isLogSuccess),
    };
  }, [leads, logs]);

  const healthTone =
    stats.syncRate === null ? "neutral" : stats.syncRate >= 90 ? "success" : stats.syncRate >= 60 ? "warning" : "danger";

  return (
    <div className="dd-stack">
      <div className="dd-kpis">
        <KpiTile icon={Users} label="Total leads" value={loading ? "…" : stats.total} tone="info" />
        <KpiTile
          icon={TrendingUp}
          label="Converted"
          value={loading ? "…" : stats.converted}
          hint={loading ? undefined : `${Math.round(stats.conversion)}% conversion`}
          tone="success"
        />
        <KpiTile
          icon={AlertTriangle}
          label="Failed syncs"
          value={loading ? "…" : stats.failed}
          hint="recent attempts"
          tone={stats.failed ? "danger" : "neutral"}
        />
        <KpiTile icon={Clock} label="Last synced" value={dealer.last_synced_at ? fmtDateTime(dealer.last_synced_at) : "—"} />
      </div>

      <Card icon={TrendingUp} title="Leads received" aside="Last 14 days">
        {loading ? (
          <Skeleton rows={4} />
        ) : stats.total === 0 ? (
          <Empty icon={Users}>No leads assigned to this dealer yet.</Empty>
        ) : (
          <WaveChart data={stats.leadSeries} series={[{ key: "total", name: "Leads", color: "var(--color-info)" }]} />
        )}
      </Card>

      <div className="dd-two">
        <Card icon={RefreshCw} title="Sync health">
          {loading ? (
            <Skeleton rows={3} />
          ) : stats.syncRate === null ? (
            <Empty icon={RefreshCw}>No sync activity recorded.</Empty>
          ) : (
            <div className="dd-health">
              <Ring percent={stats.syncRate} tone={healthTone} />
              <div className="dd-health__text">
                <strong>
                  {logs.length - stats.failed} of {logs.length}
                </strong>
                <span>recent syncs succeeded</span>
              </div>
            </div>
          )}
        </Card>

        <Card icon={CheckCircle2} title="Lead status mix">
          {loading ? (
            <Skeleton rows={3} />
          ) : stats.statusRows.length === 0 ? (
            <Empty icon={Users}>No leads yet.</Empty>
          ) : (
            <div className="dd-progress-list">
              {stats.statusRows.slice(0, 5).map((r) => (
                <ProgressRow key={r.status} label={r.status} count={r.count} total={stats.total} tone={r.tone} />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card icon={RefreshCw} title="Sync activity" aside="Last 14 days">
        {loading ? (
          <Skeleton rows={4} />
        ) : logs.length === 0 ? (
          <Empty icon={FileText}>No integration activity for this dealer.</Empty>
        ) : (
          <WaveChart
            data={stats.syncSeries}
            series={[
              { key: "ok", name: "Successful", color: "var(--color-success)" },
              { key: "failed", name: "Failed", color: "var(--color-danger)" },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

export function ContactTab({ dealer }) {
  const place = [dealer.city, dealer.state].filter(Boolean).join(", ");
  return (
    <div className="dd-contact-grid">
      <InfoCard icon={Mail} label="Email">
        {dealer.email_address ? <a href={`mailto:${dealer.email_address}`}>{dealer.email_address}</a> : "—"}
      </InfoCard>
      <InfoCard icon={Phone} label="Phone">
        {dealer.phone_number ? <a href={`tel:${dealer.phone_number}`}>{dealer.phone_number}</a> : "—"}
      </InfoCard>
      <InfoCard icon={MapPin} label="Location">
        {cellText(place)}
      </InfoCard>
      <InfoCard icon={MapPin} label="Region">
        {cellText(dealer.region)}
      </InfoCard>
    </div>
  );
}

export function SyncDetailsTab({ dealer }) {
  return (
    <div className="dd-stack">
      <div className="dd-sync-hero">
        <span className="dd-sync-hero__icon">
          <RefreshCw size={20} />
        </span>
        <div>
          <span className="dd-sync-hero__label">Sync status</span>
          <Badge tone={syncBadgeTone(dealer.sync_status)} fixed>
            {dealer.sync_status || "Synced"}
          </Badge>
        </div>
      </div>
      <div className="dd-contact-grid">
        <InfoCard icon={Clock} label="Last synced">
          {fmtDateTime(dealer.last_synced_at)}
        </InfoCard>
        <InfoCard icon={Database} label="Record created">
          {fmtDateTime(dealer.CREATEDTIME)}
        </InfoCard>
        <InfoCard icon={RefreshCw} label="Record modified">
          {fmtDateTime(dealer.MODIFIEDTIME)}
        </InfoCard>
        <InfoCard icon={Fingerprint} label="CRM record ID" mono>
          {cellText(dealer.crm_record_id)}
        </InfoCard>
      </div>
    </div>
  );
}

export function LeadActivityTab({ activity }) {
  const navigate = useNavigate();
  const { loading, leads, leadsError } = activity;

  const rows = useMemo(
    () =>
      [...leads]
        .sort((a, b) => (parseTime(b.CREATEDTIME)?.getTime() || 0) - (parseTime(a.CREATEDTIME)?.getTime() || 0))
        .slice(0, 25),
    [leads]
  );

  if (loading) return <Skeleton rows={5} />;
  if (leadsError) return <Empty icon={AlertTriangle}>Couldn't load leads for this dealer.</Empty>;
  if (!rows.length) return <Empty icon={Users}>No leads assigned to this dealer yet.</Empty>;

  return (
    <Card icon={Users} title="Recent leads" aside={`${rows.length} of ${leads.length}`}>
      <ul className="dd-list">
        {rows.map((lead) => (
          <li key={lead.ROWID}>
            <button type="button" className="dd-lead" onClick={() => navigate(`${ROUTES.LEAD_EXCHANGE}/${lead.ROWID}`)}>
              <span className="dd-lead__avatar">{(lead.customer_name || "?").trim().charAt(0).toUpperCase()}</span>
              <span className="dd-lead__main">
                <strong>{cellText(lead.customer_name)}</strong>
                <em>{[lead.vehicle_model, lead.lead_source].filter(Boolean).join(" · ") || "—"}</em>
              </span>
              <span className="dd-lead__meta">
                <Badge tone={leadTone(lead.lead_status)}>{lead.lead_status || "—"}</Badge>
                <em>{fmtDateTime(lead.CREATEDTIME)}</em>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function LogsTab({ activity }) {
  const { loading, logs, logsError } = activity;
  const [filter, setFilter] = useState("all");

  const shown = useMemo(
    () => logs.filter((l) => (filter === "all" ? true : filter === "ok" ? isLogSuccess(l) : !isLogSuccess(l))),
    [logs, filter]
  );

  if (loading) return <Skeleton rows={5} />;
  if (logsError) return <Empty icon={AlertTriangle}>Couldn't load sync logs for this dealer.</Empty>;
  if (!logs.length) return <Empty icon={FileText}>No integration logs for this dealer.</Empty>;

  const failedCount = logs.filter((l) => !isLogSuccess(l)).length;
  const chips = [
    { id: "all", label: `All ${logs.length}` },
    { id: "ok", label: `Success ${logs.length - failedCount}` },
    { id: "failed", label: `Failed ${failedCount}` },
  ];

  return (
    <Card icon={FileText} title="Integration logs" aside="Newest first">
      <div className="dd-chips">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`dd-chip ${filter === c.id ? "dd-chip--active" : ""}`}
            onClick={() => setFilter(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Empty icon={FileText}>Nothing matches this filter.</Empty>
      ) : (
        <ul className="dd-timeline">
          {shown.slice(0, 50).map((log, i) => {
            const ok = isLogSuccess(log);
            const inbound = log.direction === "EXTERNAL_CRM_TO_ZOHO";
            const Dir = inbound ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={log.ROWID || i} className={`dd-log ${ok ? "dd-log--ok" : "dd-log--bad"}`}>
                <span className="dd-log__dot">{ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}</span>
                <div className="dd-log__body">
                  <div className="dd-log__top">
                    <strong>{String(log.operation || "SYNC").replace(/_/g, " ").toLowerCase()}</strong>
                    <Badge tone={ok ? "success" : "danger"}>{ok ? "Success" : log.status || "Failed"}</Badge>
                  </div>
                  <span className="dd-log__dir">
                    <Dir size={12} /> {inbound ? "Dealer CRM → MG" : "MG → Dealer CRM"}
                    {log.happy_unhappy_path_name ? ` · ${log.happy_unhappy_path_name}` : ""}
                  </span>
                  {!ok && log.error_message && <p className="dd-log__error">{log.error_message}</p>}
                  <time>{fmtDateTime(log.created_at || log.CREATEDTIME)}</time>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
