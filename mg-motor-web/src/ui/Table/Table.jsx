import EmptyState from "../../common/EmptyState/EmptyState";
import "./Table.css";

const SKELETON_WIDTHS = ["70%", "45%", "85%", "55%", "40%", "60%", "50%", "35%"];

const SNO_COLUMN_KEY = "__sno";

export default function Table({
  columns,
  rows,
  keyField = "ROWID",
  loading = false,
  emptyMessage = "No records found",
  onRowClick = null,
  skeletonRows = 8,
  showSerial = true,
  serialOffset = 0,
}) {
  const displayColumns = showSerial
    ? [{ key: SNO_COLUMN_KEY, label: "S.No" }, ...columns]
    : columns;

  const cellClassName = (col) =>
    col.key === SNO_COLUMN_KEY ? "table__col--sno" : undefined;

  if (loading) {
    return (
      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              {displayColumns.map((col) => (
                <th key={col.key} className={cellClassName(col)}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, rowIndex) => (
              <tr key={rowIndex} className="table__row--skeleton">
                {displayColumns.map((col, colIndex) => (
                  <td key={col.key} className={cellClassName(col)}>
                    {col.key === SNO_COLUMN_KEY ? (
                      rowIndex + 1 + serialOffset
                    ) : (
                      <span
                        className="table__skeleton-bar"
                        style={{
                          width: SKELETON_WIDTHS[(rowIndex + colIndex) % SKELETON_WIDTHS.length],
                          animationDelay: `${(rowIndex * columns.length + colIndex) * 30}ms`,
                        }}
                      />
                    )}
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
            {displayColumns.map((col) => (
              <th key={col.key} className={cellClassName(col)}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={row[keyField]}
              className={onRowClick ? "table__row--clickable" : ""}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {displayColumns.map((col) => (
                <td key={col.key} className={cellClassName(col)}>
                  {col.key === SNO_COLUMN_KEY
                    ? rowIndex + 1 + serialOffset
                    : col.render
                    ? col.render(row)
                    : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}