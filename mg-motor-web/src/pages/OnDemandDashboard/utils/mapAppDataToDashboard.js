export function mapAppDataToDashboard(summary) {
  if (!summary) return null;

  const { totalDealers, totalLeads, leadStatusSummary, dealerStatusSummary, topDealers, activityTimeline, recentSyncLogs } = summary;

  const deliveredPct = leadStatusSummary?.total
    ? Math.round((leadStatusSummary.delivered / leadStatusSummary.total) * 100)
    : 0;

  const flat = (n) => [1, 1, 1, 1, 1, 1, 1].map(() => n || 1);

  const kpis = [
    { id: "leads", label: "Total Leads", value: totalLeads || 0, suffix: "", delta: 0, direction: "up", icon: "layers", spark: flat(totalLeads) },
    { id: "dealers", label: "Active Dealers", value: dealerStatusSummary?.active || 0, suffix: "", delta: 0, direction: "up", icon: "grid", spark: flat(dealerStatusSummary?.active) },
    { id: "conversion", label: "Conversion Rate", value: deliveredPct, suffix: "%", delta: 0, direction: "up", icon: "sparkles", spark: flat(deliveredPct) },
    { id: "new", label: "New Leads", value: leadStatusSummary?.new || 0, suffix: "", delta: 0, direction: "up", icon: "zap", spark: flat(leadStatusSummary?.new) },
  ];

  const charts = [
    {
      type: "donut",
      title: "Leads by Status",
      data: Object.entries(leadStatusSummary || {})
        .filter(([key]) => key !== "total")
        .map(([label, value], i) => ({
          label,
          value,
          color: ["var(--odd-red)", "var(--odd-white)", "var(--odd-muted)"][i % 3],
        })),
    },
    {
      type: "bar",
      title: "Top Dealers by Lead Volume",
      data: (topDealers || []).map((d) => ({ label: d.name, value: d.total_leads })),
    },
  ];

  const activity = (activityTimeline || []).map((a, i) => ({
    id: i,
    text: `${a.title} — ${a.meta}`,
    time: a.time ? new Date(a.time).toLocaleString() : "",
    tone: a.tone === "success" ? "default" : a.tone === "warning" ? "warning" : "danger",
  }));

  const table = (recentSyncLogs || []).map((log, i) => ({
    id: log.ROWID || i,
    name: `${log.sync_type || "Sync"} run`,
    source: "App Data",
    type: "Live",
    status: log.status === "Success" ? "Complete" : log.status === "Partial" ? "Needs review" : "Failed",
    date: (log.start_time || "").split("T")[0] || log.start_time || "",
  }));

  return { kpis, charts, activity, table };
}
