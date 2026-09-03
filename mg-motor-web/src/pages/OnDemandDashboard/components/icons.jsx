/**
 * icons.jsx
 * -----------------------------------------------------------------------
 * Local inline-SVG icon set for the On-Demand Dashboard, following the
 * same pattern as ui/icons used by Sidebar.jsx (each icon is a small
 * component accepting `size` and forwarding the rest of its props).
 * Kept local to this feature so it doesn't collide with the app-wide
 * NAV_ICONS set, and so this feature stays self-contained.
 */

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const SearchIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

export const BellIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
    <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
  </svg>
);

export const MoonIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
  </svg>
);

export const SettingsIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13a7.9 7.9 0 0 0 0-2l2-1.5-2-3.4-2.3.9a8 8 0 0 0-1.7-1L15 3.6h-4L10.6 6a8 8 0 0 0-1.7 1l-2.3-.9-2 3.4L6.6 11a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9a8 8 0 0 0 1.7 1L11 20.4h4l.4-2.4a8 8 0 0 0 1.7-1l2.3.9 2-3.4-2-1.5Z" />
  </svg>
);

export const RefreshIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M20 11a8 8 0 0 0-14.6-4.5M4 5v5h5" />
    <path d="M4 13a8 8 0 0 0 14.6 4.5M20 19v-5h-5" />
  </svg>
);

export const SparklesIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
  </svg>
);

export const UploadIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

export const FilePdfIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v4h4" />
    <path d="M9 15.5h1.2c.7 0 1.3-.6 1.3-1.3S10.9 13 10.2 13H9v4.5" />
    <path d="M13.2 17.5V13h1a1.75 1.75 0 0 1 0 4.5h-1Z" />
    <path d="M17.8 13H16v4.5" />
    <path d="M16 15.2h1.6" />
  </svg>
);

export const FileSheetIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v4h4" />
    <path d="M8 13h8M8 16.5h8M11 13v6.5" />
  </svg>
);

export const TrendUpIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 16l6-6 4 4 6-8" />
    <path d="M14 6h6v6" />
  </svg>
);

export const TrendDownIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 8l6 6 4-4 6 8" />
    <path d="M14 18h6v-6" />
  </svg>
);

export const BotIcon = ({ size = 20, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 8V4M9 4h6" />
    <circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    <path d="M9 17h6" />
  </svg>
);

export const SendIcon = ({ size = 16, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M21 3 3 10.5l7 2.5 2 7L21 3Z" />
    <path d="M10 13l4.5-4.5" />
  </svg>
);

export const XIcon = ({ size = 16, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const CheckIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 12.5 9.5 18 20 6" />
  </svg>
);

export const ClockIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const GridIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
  </svg>
);

export const LayersIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z" />
    <path d="M3.5 12l8.5 4.5L20.5 12" />
    <path d="M3.5 16l8.5 4.5L20.5 16" />
  </svg>
);

export const BarChartIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M5 20V10M12 20V4M19 20v-7" />
    <path d="M3 20h18" />
  </svg>
);

export const ZapIcon = ({ size = 16, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
  </svg>
);

export const DownloadIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 4v11M8 12l4 4 4-4" />
    <path d="M5 19h14" />
  </svg>
);

export const AlertIcon = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 4 2.5 20h19L12 4Z" />
    <path d="M12 10.5V14.5" />
    <circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const UsersIcon = ({ size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19c.7-3 2.8-4.6 5.5-4.6s4.8 1.6 5.5 4.6" />
    <path d="M15.5 5.2A3.2 3.2 0 0 1 17 11.2" />
    <path d="M16 14.5c2.3.3 3.9 1.9 4.5 4.5" />
  </svg>
);

export const ChevronRightIcon = ({ size = 16, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...p}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);