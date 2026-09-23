import { useLocation } from "react-router-dom";
import { ROUTE_LABELS } from "../../../constants/navigation.constants";
import "./Breadcrumb.css";

/**
 * Breadcrumb.jsx
 * -----------------------------------------------------------------------
 * Reads the current route and resolves it against ROUTE_LABELS (shared
 * with Sidebar) rather than maintaining its own copy of route names.
 * Only two levels for now (Home / Current Section) since nothing nests
 * deeper than that yet â€” dealer/lead detail pages arriving on their
 * respective days will extend this, not replace it.
 */
export default function Breadcrumb() {
  const location = useLocation();
  const currentLabel = ROUTE_LABELS[location.pathname] || "";

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <span className="breadcrumb__item breadcrumb__item--muted">MG Motor</span>
      {currentLabel && (
        <>
          <span className="breadcrumb__separator">/</span>
          <span className="breadcrumb__item">{currentLabel}</span>
        </>
      )}
    </nav>
  );
}

