import Skeleton from "./Skeleton";
import "./TableSkeleton.css";

/**
 * TableSkeleton.jsx
 * -----------------------------------------------------------------------
 * Stands in for <Table /> while data is loading. Takes columnCount so
 * the skeleton grid roughly matches whatever column set is currently
 * visible (varies on DealerListPage since columns are user-toggleable).
 */
export default function TableSkeleton({ columnCount = 5, rowCount = 8 }) {
  return (
    <div className="table-skeleton" role="status" aria-label="Loading data">
      <div className="table-skeleton__head" style={{ gridTemplateColumns: `repeat(${columnCount}, 1fr)` }}>
        {Array.from({ length: columnCount }).map((_, i) => (
          <Skeleton key={i} width="60%" height={11} />
        ))}
      </div>

      {Array.from({ length: rowCount }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="table-skeleton__row"
          style={{ gridTemplateColumns: `repeat(${columnCount}, 1fr)`, animationDelay: `${rowIdx * 40}ms` }}
        >
          {Array.from({ length: columnCount }).map((_, colIdx) => (
            <Skeleton key={colIdx} width={colIdx === 0 ? "50%" : "75%"} height={13} />
          ))}
        </div>
      ))}
    </div>
  );
}