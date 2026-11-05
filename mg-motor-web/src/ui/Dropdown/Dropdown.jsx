import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, Search } from "lucide-react";
import "./Dropdown.css";

/**
 * Dropdown.jsx
 * -----------------------------------------------------------------------
 * Custom single-select dropdown, built to replace native <select> where
 * consistent cross-browser popup styling matters (native <option>
 * background/color rules are inconsistently honored — Chrome applies
 * them, Firefox/Safari mostly ignore them and just follow color-scheme).
 * This renders its own panel as regular DOM, so it's fully styleable
 * and automatically follows [data-theme="dark"] via the same CSS
 * variables every other component uses.
 *
 * The options panel is drawn in a portal on <body>, positioned from the
 * trigger's on-screen rectangle (position: fixed). That means it can never
 * be clipped by, or stretch, a table / card / scroll container the
 * dropdown happens to sit in, and it flips to open upwards when there is
 * not enough room below (e.g. the last row of a table).
 *
 * Drop-in shape: options = [{ value, label }], value/onChange behave
 * like a controlled <select>. Not a multi-select — see MultiDropdown
 * (not built here) if that's ever needed.
 *
 * Search: lists longer than SEARCH_AUTO_THRESHOLD options get a type-to-filter
 * box pinned at the top of the panel (case-insensitive match on the label).
 * Force it on/off with the `searchable` prop (true | false); default "auto".
 */

const PANEL_MAX_HEIGHT = 260;
const PANEL_GAP = 6;
const VIEWPORT_MARGIN = 8;
const MIN_PANEL_WIDTH = 120;
const SEARCH_AUTO_THRESHOLD = 6; // show search when there are more options than this
const SEARCH_BOX_HEIGHT = 48;

export default function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled = false,
  size = "md", // "sm" | "md"
  className = "",
  ariaLabel,
  searchable = "auto", // "auto" | true | false
  searchPlaceholder = "Search…",
}) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [panelStyle, setPanelStyle] = useState(null); // { top|bottom, left, width, maxHeight, placement }
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const listboxId = useId();

  const hasSearch = searchable === true || (searchable === "auto" && options.length > SEARCH_AUTO_THRESHOLD);

  const selectedOption = options.find((opt) => opt.value === value) || null;

  // Options actually shown: all of them, or only those matching the search text.
  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!hasSearch || !q) return options;
    return options.filter((opt) => {
      const text = typeof opt.label === "string" ? opt.label : String(opt.value ?? "");
      return text.toLowerCase().includes(q);
    });
  }, [options, query, hasSearch]);

  // Where to draw the panel: under the trigger, or above it when the space
  // below is too small to show the whole list.
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    const wanted = Math.min(PANEL_MAX_HEIGHT, options.length * 38 + 12 + (hasSearch ? SEARCH_BOX_HEIGHT : 0));
    const spaceBelow = viewportH - rect.bottom - PANEL_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - PANEL_GAP - VIEWPORT_MARGIN;
    const placeAbove = spaceBelow < wanted && spaceAbove > spaceBelow;
    const room = placeAbove ? spaceAbove : spaceBelow;

    const width = Math.max(rect.width, MIN_PANEL_WIDTH);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.left), Math.max(VIEWPORT_MARGIN, viewportW - width - VIEWPORT_MARGIN));

    setPanelStyle({
      placement: placeAbove ? "up" : "down",
      left,
      width,
      maxHeight: Math.max(96, Math.min(PANEL_MAX_HEIGHT, room)),
      ...(placeAbove
        ? { bottom: viewportH - rect.top + PANEL_GAP }
        : { top: rect.bottom + PANEL_GAP }),
    });
  }, [options.length, hasSearch]);

  // Position before paint so the panel never flashes in the wrong place.
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  // Keep the panel attached to the trigger while the page scrolls or resizes.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true); // capture: any scroll container
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  // Close on outside click. The panel lives in a portal, so it is checked separately.
  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event) => {
      const inTrigger = containerRef.current?.contains(event.target);
      const inPanel = panelRef.current?.contains(event.target);
      if (!inTrigger && !inPanel) setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Move focus into the panel once it is drawn: the search box if there is
  // one, otherwise the list (so arrow keys work straight away).
  useEffect(() => {
    if (!open || !panelStyle) return;
    (hasSearch ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, panelStyle, hasSearch]);

  // Scroll the highlighted option into view as keyboard nav moves.
  useEffect(() => {
    if (!open || highlightedIndex < 0 || !listRef.current) return;
    const item = listRef.current.querySelectorAll('[role="option"]')[highlightedIndex];
    item?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedIndex]);

  const openDropdown = () => {
    if (disabled) return;
    setQuery("");
    const idx = options.findIndex((opt) => opt.value === value);
    setHighlightedIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const commitSelection = (index) => {
    const option = visibleOptions[index];
    if (!option) return;
    onChange(option.value);
    closeAndFocusTrigger();
  };

  const handleQueryChange = (event) => {
    setQuery(event.target.value);
    setHighlightedIndex(0); // best match first
  };

  const handleTriggerKeyDown = (event) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        openDropdown();
      }
    }
  };

  // Handles keys for both the search box and the list (events bubble to the panel).
  const handlePanelKeyDown = (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((i) => Math.min(visibleOptions.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedIndex((i) => Math.max(0, i - 1));
        break;
      case "Enter":
        event.preventDefault();
        commitSelection(highlightedIndex);
        break;
      case "Escape":
        event.preventDefault();
        closeAndFocusTrigger();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className={`dropdown dropdown--${size} ${disabled ? "dropdown--disabled" : ""} ${className}`}
      ref={containerRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`dropdown__trigger ${open ? "dropdown__trigger--open" : ""}`}
        onClick={() => (open ? setOpen(false) : openDropdown())}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={`dropdown__value ${!selectedOption ? "dropdown__value--placeholder" : ""}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown size={15} strokeWidth={2} className="dropdown__chevron" />
      </button>

      {open &&
        panelStyle &&
        createPortal(
          <div
            className={`dropdown__panel dropdown__panel--${panelStyle.placement}`}
            ref={panelRef}
            onKeyDown={handlePanelKeyDown}
            style={{
              top: panelStyle.top,
              bottom: panelStyle.bottom,
              left: panelStyle.left,
              width: panelStyle.width,
              maxHeight: panelStyle.maxHeight,
            }}
          >
            {hasSearch && (
              <div className="dropdown__search">
                <Search size={14} strokeWidth={2} className="dropdown__search-icon" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="text"
                  className="dropdown__search-input"
                  value={query}
                  onChange={handleQueryChange}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  aria-controls={listboxId}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            <ul className="dropdown__list" role="listbox" id={listboxId} ref={listRef} tabIndex={-1}>
              {visibleOptions.length === 0 && <li className="dropdown__empty">No matches</li>}
              {visibleOptions.map((option, index) => {
                const isSelected = option.value === value;
                const isHighlighted = index === highlightedIndex;
                return (
                  <li
                    key={option.value}
                    role="option"
                    aria-selected={isSelected}
                    className={`dropdown__option ${isSelected ? "dropdown__option--selected" : ""} ${
                      isHighlighted ? "dropdown__option--highlighted" : ""
                    }`}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => commitSelection(index)}
                  >
                    <span className="dropdown__option-label">{option.label}</span>
                    {isSelected && <Check size={14} strokeWidth={2.5} className="dropdown__option-check" />}
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}
