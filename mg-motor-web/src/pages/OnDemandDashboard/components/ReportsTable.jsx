import { useMemo, useState } from "react";
import useLiquidPointer from "../hooks/useLiquidPointer";
import { ChevronRightIcon, DownloadIcon } from "./icons";

const COLUMNS = [
  { key: "name", label: "Report" },
  { key: "source", label: "Source" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "date", label: "Date" },
];

const STATUS_TONE = {
  Complete: "ok",
  "Needs review": "warn",
  Failed: "danger",
};

export default function ReportsTable({ rows, delay = 0 }) {
  const liquidRef = useLiquidPointer();
  const [sort, setSort] = useState({ key: "date", dir: "desc" });

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  const toggleSort = (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  return (
    <div ref={liquidRef} className="odd-card odd-liquid odd-table-panel" style={{ "--odd-reveal-delay": `${delay}ms` }}>
      <div className="odd-chart-panel__head">
        <div>
          <h3 className="odd-chart-panel__title">Recent Reports</h3>
          <p className="odd-chart-panel__subtitle">Live app data and uploaded-file reports, in one place.</p>
        </div>
        <button type="button" className="odd-btn odd-btn--ghost">
          <DownloadIcon size={13} /> Export
        </button>
      </div>

      <div className="odd-table-scroll">
        <table className="odd-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sort.key === col.key && <span className="odd-table__sort">{sort.dir === "asc" ? "↑" : "↓"}</span>}
                </th>
              ))}
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id}>
                <td className="odd-table__name">{row.name}</td>
                <td>{row.source}</td>
                <td>{row.type}</td>
                <td>
                  <span className={`odd-badge odd-badge--${STATUS_TONE[row.status] || "ok"}`}>{row.status}</span>
                </td>
                <td>{row.date}</td>
                <td className="odd-table__chevron">
                  <ChevronRightIcon size={15} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}