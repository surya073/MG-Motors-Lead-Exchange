import { useEffect, useState } from "react";
import IconButton from "../../../ui/IconButton/IconButton";
import { SearchIcon } from "../../../ui/icons";
import SearchModal from "./SearchModal";

/**
 * GlobalSearch.jsx
 * -----------------------------------------------------------------------
 * Previously an inline input centered via flex:1 in the navbar â€” that
 * meant its on-screen position shifted left/right whenever the
 * breadcrumb (to its left) changed length, since "centered in the
 * remaining space" isn't the same as "centered on the page" once the
 * space on either side is uneven.
 *
 * Fixed by making this a small fixed-width trigger (same size as every
 * other navbar icon) that opens a modal instead of growing to fill
 * space. A fixed-width element can't shift based on a sibling's width â€”
 * the layout bug is structurally impossible now, not just visually
 * patched over.
 */
export default function GlobalSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <IconButton icon={SearchIcon} label="Search" onClick={() => setOpen(true)} />
      {open && <SearchModal onClose={() => setOpen(false)} />}
    </>
  );
}
