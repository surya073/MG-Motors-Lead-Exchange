/**
 * mockDashboardData.js
 * -----------------------------------------------------------------------
 * Placeholder data for the On-Demand Dashboard's first visual pass.
 *
 * Swap-out plan (later phase):
 *   - kpis            -> GET /api/on-demand/kpis  (or existing leads/dealers service)
 *   - uploadsTrend     -> derived from stored upload history
 *   - leadsTrend        -> existing lead-exchange analytics endpoint
 *   - fileTypeSplit    -> derived from stored upload history
 *   - reports          -> GET /api/on-demand/reports
 *   - activity         -> GET /api/on-demand/activity (or a shared activity feed service)
 * Once both sources exist, they can be merged in OnDemandDashboard.jsx
 * behind the same shape these mocks already use, so components don't change.
 */

export const kpis = [
  {
    id: "reports",
    label: "Reports Generated",
    value: 1284,
    suffix: "",
    delta: 12.4,
    direction: "up",
    icon: "layers",
    spark: [4, 6, 5, 8, 7, 9, 12],
  },
  {
    id: "files",
    label: "Files Processed",
    value: 342,
    suffix: "",
    delta: 8.1,
    direction: "up",
    icon: "grid",
    spark: [2, 3, 3, 5, 4, 6, 7],
  },
  {
    id: "insights",
    label: "AI Insights Generated",
    value: 96,
    suffix: "",
    delta: -3.2,
    direction: "down",
    icon: "sparkles",
    spark: [9, 8, 8, 7, 6, 7, 6],
  },
  {
    id: "avg-time",
    label: "Avg. Processing Time",
    value: 4.6,
    decimals: 1,
    suffix: "s",
    delta: 18.5,
    direction: "up",
    icon: "zap",
    spark: [7, 6, 6, 5, 5, 4, 4],
  },
];

export const uploadsTrend = [
  { label: "Mon", value: 18 },
  { label: "Tue", value: 26 },
  { label: "Wed", value: 22 },
  { label: "Thu", value: 34 },
  { label: "Fri", value: 41 },
  { label: "Sat", value: 19 },
  { label: "Sun", value: 12 },
];

export const leadsTrend = [
  { label: "Mar", value: 210 },
  { label: "Apr", value: 248 },
  { label: "May", value: 236 },
  { label: "Jun", value: 289 },
  { label: "Jul", value: 312 },
  { label: "Aug", value: 356 },
];

export const fileTypeSplit = [
  { label: "Excel / CSV", value: 58, color: "var(--odd-red)" },
  { label: "PDF", value: 34, color: "var(--odd-white)" },
  { label: "Other", value: 8, color: "var(--odd-muted)" },
];

export const reports = [
  { id: "RPT-2041", name: "Q2 Dealer Performance.xlsx", source: "Upload", type: "Excel", status: "Complete", date: "2026-08-18" },
  { id: "RPT-2040", name: "Lead Exchange — Live", source: "App Data", type: "Live", status: "Complete", date: "2026-08-18" },
  { id: "RPT-2039", name: "North Zone Sync Report.pdf", source: "Upload", type: "PDF", status: "Complete", date: "2026-08-17" },
  { id: "RPT-2038", name: "Dealer Onboarding Batch.csv", source: "Upload", type: "CSV", status: "Needs review", date: "2026-08-17" },
  { id: "RPT-2037", name: "Monthly Conversion Summary", source: "App Data", type: "Live", status: "Complete", date: "2026-08-16" },
  { id: "RPT-2036", name: "Service Center Audit.pdf", source: "Upload", type: "PDF", status: "Failed", date: "2026-08-15" },
];

export const activity = [
  { id: 1, text: "AI generated 6 new insights from Q2 Dealer Performance.xlsx", time: "3m ago", tone: "highlight" },
  { id: 2, text: "Live lead data synced from Lead Exchange", time: "22m ago", tone: "default" },
  { id: 3, text: "North Zone Sync Report.pdf processed successfully", time: "1h ago", tone: "default" },
  { id: 4, text: "Dealer Onboarding Batch.csv flagged for review — 3 rows missing dealer_code", time: "2h ago", tone: "warning" },
  { id: 5, text: "Service Center Audit.pdf failed to parse — unsupported scanned format", time: "5h ago", tone: "danger" },
];

export const suggestedPrompts = [
  "Show me this month's lead performance",
  "Compare dealers",
  "What changed from last month?",
  "Analyze this uploaded Excel file",
];