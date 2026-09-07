import "./LoadingPage.css";
import logoMorrisGarages from "../../assets/images/logo-morris-garages.png";

/**
 * Full-viewport loading state. Used as a route-level Suspense fallback
 * and during session validation on app boot.
 */
export default function LoadingPage({ label = "Loading" }) {
  return (
    <div className="loading-page" role="status" aria-live="polite">
      <img
        className="loading-page__logo"
        src={logoMorrisGarages}
        alt="MG Motor"
      />
      <div className="loading-page__mark">
        <span className="loading-page__bar" />
        <span className="loading-page__bar" />
        <span className="loading-page__bar" />
      </div>
      <p className="loading-page__label">{label}</p>
    </div>
  );
}