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

  // "Forgot password" is handled here, in our own themed form, rather than
  // by Catalyst's embedded page (which renders with Catalyst's default
  // styling). The embedded sign-in iframe stays mounted but hidden while
  // this form is showing, so going back is instant.
  const [view, setView] = useState("signin"); // "signin" | "forgot"
  const [resetEmail, setResetEmail] = useState("");
  const [reset, setReset] = useState({ sending: false, sent: false, error: "" });

  const handleReset = async (event) => {
    event.preventDefault();
    const email = resetEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setReset({ sending: false, sent: false, error: "Enter a valid email address." });
      return;
    }
    setReset({ sending: true, sent: false, error: "" });
    try {
      await authService.sendPasswordReset(email);
      setReset({ sending: false, sent: true, error: "" });
    } catch {
      setReset({
        sending: false,
        sent: false,
        error: "We could not send the reset email. Check the address and try again.",
      });
    }
  };

  const showSignIn = () => {
    setView("signin");
    setReset({ sending: false, sent: false, error: "" });
  };

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
        <h1 className="login-page__title">{view === "forgot" ? "Reset your password" : "Welcome Back"}</h1>
        <p className="login-page__subtitle">
          {view === "forgot"
            ? "Enter your account email and we will send you a link to reset your password."
            : "Sign in to your dealer account to continue."}
        </p>
      </div>

      {view === "forgot" && (
        <form className="login-page__reset" onSubmit={handleReset} noValidate>
          {reset.sent ? (
            <div className="login-page__reset-success" role="status">
              <strong>Check your inbox</strong>
              <span>
                If an account exists for {resetEmail.trim()}, a password reset link is on its way.
              </span>
            </div>
          ) : (
            <>
              <label className="login-page__field">
                <span>Email address</span>
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@dealership.com.au"
                  value={resetEmail}
                  onChange={(event) => setResetEmail(event.target.value)}
                  disabled={reset.sending}
                />
              </label>
              {reset.error && (
                <p className="login-page__reset-error" role="alert">{reset.error}</p>
              )}
              <button type="submit" className="login-page__primary-btn" disabled={reset.sending}>
                {reset.sending ? "Sending…" : "Send reset link"}
              </button>
            </>
          )}
          <button type="button" className="login-page__link" onClick={showSignIn}>
            ← Back to sign in
          </button>
        </form>
      )}

      <div className={`login-page__form-area${view === "forgot" ? " login-page__form-area--hidden" : ""}`}>
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

      {view === "signin" && (
        <button type="button" className="login-page__link login-page__link--forgot" onClick={() => setView("forgot")}>
          Forgot password?
        </button>
      )}

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