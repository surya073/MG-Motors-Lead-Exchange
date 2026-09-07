import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { authService } from "../../services/api/authService";
import { CATALYST_SIGNIN_ELEMENT_ID, CATALYST_SIGNIN_CONFIG } from "../../constants/auth.constants";
import { SESSION_STATUS } from "../../constants/app.constants";
import { ROUTES, APP_BASE_PATH } from "../../constants/routes.constants";
import LoadingPage from "../../common/LoadingPage/LoadingPage";
import mgLogo from "../../assets/images/mg-logo-single.png";
import "./LoginPage.css";

export default function LoginPage() {
  const { status } = useAuth();
  const location = useLocation();
  const containerRef = useRef(null);
  const [iframeLoading, setIframeLoading] = useState(true);

  const targetPath = location.state?.from?.pathname || ROUTES.DASHBOARD;
  const redirectTarget = `${window.location.origin}${APP_BASE_PATH}/#${targetPath}`;

  useEffect(() => {
    if (status !== SESSION_STATUS.UNAUTHENTICATED && status !== SESSION_STATUS.EXPIRED) {
      return undefined;
    }

    authService.renderSignIn(CATALYST_SIGNIN_ELEMENT_ID, {
      ...CATALYST_SIGNIN_CONFIG,
      service_url: redirectTarget,
    });

    const node = containerRef.current;
    const observer = new MutationObserver(() => {
      if (node && node.childNodes.length > 0) {
        setIframeLoading(false);
        observer.disconnect();
      }
    });
    if (node) {
      observer.observe(node, { childList: true, subtree: true });
    }
    const fallback = setTimeout(() => setIframeLoading(false), 4000);

    return () => {
      observer.disconnect();
      clearTimeout(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps

    
    // Complete the pending AI chat integration in the dashboard and verify the end-to-end flow.
// Start reviewing the Dealer CRM configuration requirements.
// Analyze the integration approach for Dealer CRM, including webhook/API connectivity, authentication, access-token handling, and required configuration details.
// Review the required field mapping and data exchange flow between Dealer CRM, Catalyst middleware, and MG Zoho CRM.
// Identify any pending requirements or dependencies needed to proceed with the Dealer CRM integration.
  }, [status]);

  if (status === SESSION_STATUS.AUTHENTICATED) {
    return <Navigate to={ROUTES.DASHBOARD} replace />;
  }

  if (status === SESSION_STATUS.UNKNOWN) {
    return <LoadingPage label="Checking session" />;
  }

  return (
    <div className="login-page">
      <img src={mgLogo} alt="MG Motor" className="login-page__logo" />

      <div className="login-page__brand">
        <h1 className="login-page__title">Welcome Back</h1>
        <p className="login-page__subtitle">
          Sign in to your dealer account to continue.
        </p>
      </div>

      <div className="login-page__form-area">
        {iframeLoading && (
          <div className="login-page__loading" aria-live="polite">
            <span className="login-page__spinner" />
            <span>Loading sign-in</span>
          </div>
        )}
        <div
          ref={containerRef}
          id={CATALYST_SIGNIN_ELEMENT_ID}
          className="login-page__iframe-slot"
        />
      </div>

      <div className="login-page__divider" role="presentation">
        <span />
        <span className="login-page__divider-text">OR</span>
        <span />
      </div>

      {/* TODO: wire up the actual contact-admin flow (mailto, route, modal) */}
      <button type="button" className="login-page__contact-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        Contact Admin
      </button>
    </div>
  );
}