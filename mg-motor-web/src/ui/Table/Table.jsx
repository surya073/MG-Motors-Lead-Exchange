import EmptyState from "../../common/EmptyState/EmptyState";
import "./Table.css";

const SKELETON_WIDTHS = ["70%", "45%", "85%", "55%", "40%", "60%", "50%", "35%"];

export default function Table({
  columns,
  rows,
  keyField = "ROWID",
  loading = false,
  emptyMessage = "No records found",
  onRowClick = null,
  skeletonRows = 8,
}) {
  if (loading) {
    return (
      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, rowIndex) => (
              <tr key={rowIndex} className="table__row--skeleton">
                {columns.map((col, colIndex) => (
                  <td key={col.key}>
                    <span
                      className="table__skeleton-bar"
                      style={{
                        width: SKELETON_WIDTHS[(rowIndex + colIndex) % SKELETON_WIDTHS.length],
                        animationDelay: `${(rowIndex * columns.length + colIndex) * 30}ms`,
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return <EmptyState title={emptyMessage} description="Nothing to show yet." />;
  }

  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row[keyField]}
              className={onRowClick ? "table__row--clickable" : ""}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key}>{col.render ? col.render(row) : row[col.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}