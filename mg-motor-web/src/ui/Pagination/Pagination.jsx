import { ChevronLeft, ChevronRight } from "lucide-react";
import Dropdown from "../Dropdown/Dropdown";
import "./Pagination.css";

/**
 * Pagination.jsx
 * -----------------------------------------------------------------------
 * The one pagination bar for every list and table in the app, so Previous /
 * Next and the "Page X of Y · N things" label look and behave the same
 * everywhere.
 *
 *   <Pagination
 *     page={currentPage + 1}            // 1-based
 *     pageCount={pageCount}
 *     total={filtered.length}
 *     noun="lead"                       // singular; pluralised automatically
 *     onPageChange={(p) => setPageIndex(p - 1)}
 *     // optional "Rows per page" selector:
 *     pageSize={pageSize}
 *     pageSizeOptions={[10, 20, 50]}
 *     onPageSizeChange={handlePageSizeChange}
 *     // narrow containers (side panels): icon-only buttons, stacked layout
 *     compact
 *   />
 */
export default function Pagination({
  page,
  pageCount,
  total,
  noun = "result",
  onPageChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  compact = false,
}) {
  const lastPage = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), lastPage);
  const showSize = Boolean(onPageSizeChange && pageSizeOptions?.length);

  return (
    <nav className={`pagination${compact ? " pagination--compact" : ""}`} aria-label="Pagination">
      {showSize ? (
        <div className="pagination__size">
          <span>Rows per page</span>
          <Dropdown
            ariaLabel="Rows per page"
            size="sm"
            value={String(pageSize)}
            onChange={(value) => onPageSizeChange(Number(value))}
            options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </div>
      ) : (
        <span aria-hidden="true" />
      )}

      <div className="pagination__nav">
        <button
          type="button"
          className="pagination__btn"
          onClick={() => onPageChange(current - 1)}
          disabled={current <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft size={15} strokeWidth={2.4} />
          <span className="pagination__btn-text">Previous</span>
        </button>

        <span className="pagination__status" aria-live="polite">
          Page <strong>{current}</strong> of <strong>{lastPage}</strong>
          <span className="pagination__total"> · {total.toLocaleString()} {total === 1 ? noun : `${noun}s`}</span>
        </span>

        <button
          type="button"
          className="pagination__btn"
          onClick={() => onPageChange(current + 1)}
          disabled={current >= lastPage}
          aria-label="Next page"
        >
          <span className="pagination__btn-text">Next</span>
          <ChevronRight size={15} strokeWidth={2.4} />
        </button>
      </div>
    </nav>
  );
}
