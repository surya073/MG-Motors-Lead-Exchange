import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
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
 * Drop-in shape: options = [{ value, label }], value/onChange behave
 * like a controlled <select>. Not a multi-select — see MultiDropdown
 * (not built here) if that's ever needed.
 */
export default function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled = false,
  size = "md", // "sm" | "md"
  className = "",
  ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  // Close on outside click.
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

  // Scroll the highlighted option into view as keyboard nav moves.
  useEffect(() => {
    if (!open || highlightedIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[highlightedIndex];
    item?.scrollIntoView({ block: "nearest" });
  }, [open, highlightedIndex]);

  const openDropdown = () => {
    if (disabled) return;
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const commitSelection = (index) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
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

  const handleListKeyDown = (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((i) => Math.min(options.length - 1, i + 1));
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
        setOpen(false);
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

      {open && (
        <ul
          className="dropdown__panel"
          role="listbox"
          id={listboxId}
          ref={listRef}
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        >
          {options.map((option, index) => {
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
      )}
    </div>
  );
}