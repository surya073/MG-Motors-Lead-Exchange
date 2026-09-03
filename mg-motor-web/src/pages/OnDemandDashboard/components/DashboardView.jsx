import { useState } from "react";
import KpiCard from "./KpiCard";
import ChartPanel from "./ChartPanel";
import BarChart from "./charts/BarChart";
import LineChart from "./charts/LineChart";
import DonutChart from "./charts/DonutChart";
import UploadPanel from "./UploadPanel";
import ReportsTable from "./ReportsTable";
import ActivityFeed from "./ActivityFeed";
import { AlertIcon, ChevronRightIcon, RefreshIcon } from "./icons";
import * as mock from "../data/mockDashboardData";

const CHART_COMPONENTS = { bar: BarChart, line: LineChart, donut: DonutChart };

/**
 * DashboardView
 * -----------------------------------------------------------------------
 * Renders whatever OnDemandDashboard.jsx's handleGenerate produced:
 *   - source "app"    -> utils/mapAppDataToDashboard.js output (real
 *                        dealers/leads/sync_logs, no AI involved)
 *   - source "upload" -> utils/mapAiResultToDashboard.js output (Gemini's
 *                        analysis of the uploaded file(s))
 *
 * Falls back to data/mockDashboardData.js per-section whenever `data`
 * doesn't have that section (e.g. generation failed, or the AI result
 * legitimately had no charts/table for this file) — never shows a blank
 * dashboard, but `error` (surfaced via the banner) makes it clear when
 * what's on screen is sample data rather than real data.
 */
export default function DashboardView({ source, files, data, error, onBack }) {
  const [refreshKey, setRefreshKey] = useState(0);

  const kpis = data?.kpis?.length ? data.kpis : mock.kpis;
  const charts = data?.charts?.length
    ? data.charts
    : [
        { type: "line", title: "Leads Trend", data: mock.leadsTrend },
        { type: "donut", title: "File Type Split", data: mock.fileTypeSplit },
        { type: "bar", title: "Uploads This Week", data: mock.uploadsTrend },
      ];
  const activity = data?.activity?.length ? data.activity : mock.activity;
  const tableRows = data?.table?.length ? data.table : mock.reports;

  return (
    <div className="odd-dashboard">
      <header className="odd-dashboard__header">
        <button type="button" className="odd-back odd-back--inline" onClick={onBack}>
          <ChevronRightIcon size={13} className="odd-back__icon" /> Back
        </button>

        <div className="odd-dashboard__heading">
          <h1>
            On-Demand Dashboard
            <span className="odd-source-badge">
              {source === "upload" ? `Uploaded file${files?.length > 1 ? "s" : ""}` : "Live app data"}
            </span>
          </h1>
          <p>
            {error
              ? "Couldn't generate from real data — showing sample data instead."
              : "AI-generated analytics from your uploads and live app data."}
          </p>
        </div>

        <button type="button" className="odd-icon-btn" onClick={() => setRefreshKey((k) => k + 1)} aria-label="Refresh data">
          <RefreshIcon size={17} />
        </button>
      </header>

      {error && (
        <div className="odd-error-banner">
          <AlertIcon size={14} /> {error}
        </div>
      )}

      <div className="odd-content" key={refreshKey}>
        <section className="odd-section odd-kpi-grid">
          {kpis.map((kpi, i) => (
            <KpiCard key={kpi.id} kpi={kpi} active delay={i * 90} />
          ))}
        </section>

        <section className="odd-section odd-chart-grid">
          {charts.map((chart, i) => {
            const ChartComp = CHART_COMPONENTS[chart.type] || BarChart;
            return (
              <ChartPanel key={chart.title} title={chart.title} span={i !== 1 ? "wide" : undefined} delay={80 + i * 80}>
                <ChartComp data={chart.data} active />
              </ChartPanel>
            );
          })}
        </section>

        <section className="odd-section">
          <UploadPanel delay={60} />
        </section>

        <section className="odd-section odd-split-grid">
          <ReportsTable rows={tableRows} delay={80} />
          <ActivityFeed items={activity} delay={160} />
        </section>
      </div>
    </div>
  );
}