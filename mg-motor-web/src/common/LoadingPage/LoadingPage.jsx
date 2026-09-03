import "./LoadingPage.css";

/**
 * Full-viewport loading state. Used as a route-level Suspense fallback
 * and during session validation on app boot.
 */
export default function LoadingPage({ label = "Loading" }) {
  return (
    <div className="loading-page" role="status" aria-live="polite">
      <div className="loading-page__mark">
        <span className="loading-page__bar" />
        <span className="loading-page__bar" />
        <span className="loading-page__bar" />
      </div>
      <p className="loading-page__label">{label}</p>
    </div>
  );
}

