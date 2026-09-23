import { useNavigate, useRouteError } from "react-router-dom";
import "./ErrorPage.css";

/**
 * Route-level error page. React Router renders this via the route's
 * `errorElement` when a loader/render error occurs anywhere below it.
 */
export default function ErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();

  return (
    <div className="error-page">
      <p className="eyebrow text-accent">Something went wrong</p>
      <h1 className="error-page__title">Unexpected error</h1>
      <p className="error-page__description">
        The application hit a problem it couldn't recover from. Try
        reloading, or return to the dashboard.
      </p>
      {error?.statusText || error?.message ? (
        <pre className="error-page__detail">
          {error.statusText || error.message}
        </pre>
      ) : null}
      <div className="error-page__actions">
        <button className="error-page__button" onClick={() => navigate(0)}>
          Reload
        </button>
        <button
          className="error-page__button error-page__button--ghost"
          onClick={() => navigate("/")}
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}

