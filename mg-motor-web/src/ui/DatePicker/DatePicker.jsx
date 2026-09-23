import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import "./DatePicker.css";

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIsoDate(value) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatDisplay(date) {
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function buildMonthGrid(viewDate) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startOffset);

  return Array.from({ length: 42 }, (_, i) => {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    return cellDate;
  });
}

/**
 * DatePicker.jsx
 * -----------------------------------------------------------------------
 * Custom date picker replacing native <input type="date"> — the native
 * control's calendar popup can't be styled at all (it's OS-rendered,
 * not part of the page DOM), so it always looks out of place next to a
 * themed UI. This renders its own panel, follows the app's design
 * tokens including dark theme, and stores/emits plain ISO date strings
 * (YYYY-MM-DD) so it's a drop-in replacement wherever that format was
 * already used.
 */
export default function DatePicker({ value, onChange, placeholder = "Select date…", disabled = false }) {
  const [open, setOpen] = useState(false);
  const selectedDate = useMemo(() => parseIsoDate(value), [value]);
  const [viewDate, setViewDate] = useState(() => selectedDate || new Date());
  const containerRef = useRef(null);

  useEffect(() => {
    if (selectedDate) setViewDate(selectedDate);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const monthGrid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const changeMonth = (delta) => {
    setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  const selectDate = (date) => {
    onChange(toIsoDate(date));
    setOpen(false);
  };

  const isSameDay = (a, b) => a && b && a.toDateString() === b.toDateString();

  return (
    <div className="datepicker" ref={containerRef}>
      <button
        type="button"
        className={`datepicker__trigger ${open ? "datepicker__trigger--open" : ""}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
      >
        <Calendar size={15} strokeWidth={2} className="datepicker__icon" />
        <span className={`datepicker__value ${!selectedDate ? "datepicker__value--placeholder" : ""}`}>
          {selectedDate ? formatDisplay(selectedDate) : placeholder}
        </span>
      </button>

      {open && (
        <div className="datepicker__panel">
          <div className="datepicker__panel-header">
            <button type="button" className="datepicker__nav-btn" onClick={() => changeMonth(-1)} aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <span className="datepicker__month-label">
              {viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <button type="button" className="datepicker__nav-btn" onClick={() => changeMonth(1)} aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="datepicker__weekdays">
            {WEEKDAY_LABELS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>

          <div className="datepicker__grid">
            {monthGrid.map((date) => {
              const outsideMonth = date.getMonth() !== viewDate.getMonth();
              const isSelected = isSameDay(date, selectedDate);
              const isToday = isSameDay(date, today);
              return (
                <button
                  type="button"
                  key={date.toISOString()}
                  className={`datepicker__day ${outsideMonth ? "datepicker__day--outside" : ""} ${
                    isSelected ? "datepicker__day--selected" : ""
                  } ${isToday && !isSelected ? "datepicker__day--today" : ""}`}
                  onClick={() => selectDate(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="datepicker__footer">
            <button type="button" className="datepicker__footer-btn" onClick={() => selectDate(today)}>
              Today
            </button>
            {value && (
              <button
                type="button"
                className="datepicker__footer-btn datepicker__footer-btn--clear"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}