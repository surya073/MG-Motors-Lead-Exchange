import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { authService } from "../../services/api/authService";
import { CATALYST_SIGNIN_ELEMENT_ID, CATALYST_SIGNIN_CONFIG } from "../../constants/auth.constants";
import { SESSION_STATUS } from "../../constants/app.constants";
import { ROUTES, APP_BASE_PATH } from "../../constants/routes.constants";
import Logo from "../../ui/Logo/Logo";
import LoadingPage from "../../common/LoadingPage/LoadingPage";
import "./LoginPage.css";

/**
 * LoginPage.jsx
 * -----------------------------------------------------------------------
 * The MG-branded shell around Catalyst's embedded sign-in iframe. What
 * this component owns: the surrounding layout, copy, and the loading
 * state while (a) an existing session is being checked and (b) the
 * iframe itself is being injected. What it does NOT own: the actual
 * credential form — that's Catalyst's iframe, styled via
 * CATALYST_SIGNIN_CONFIG.css_url (public/embedded-auth.css) rather than
 * rebuilt from scratch, since Embedded Authentication doesn't expose a
 * way to submit credentials through your own form fields.
 */
export default function LoginPage() {
  const { status } = useAuth();
  const location = useLocation();
  const containerRef = useRef(null);
  const [iframeLoading, setIframeLoading] = useState(true);

  // Where to send the user after Catalyst's iframe completes a
  // successful sign-in. Prefers wherever ProtectedRoute redirected them
  // from, falling back to the dashboard. This is a full-page redirect
  // handled by Catalyst's iframe, not client-side navigation — so unlike
  // <Link>/<Navigate>, it has to be built as a real URL by hand: the real
  // static file lives at {origin}/app/ (Catalyst's Web Client Hosting
  // path), and everything after that is a hash route our HashRouter
  // picks up client-side without ever hitting the server again.
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

    // Catalyst injects the iframe into our container asynchronously with
    // no callback of its own — a MutationObserver is the simplest honest
    // way to know it actually landed, so the loading state doesn't just
    // guess with a fixed timeout. `subtree: true` in case Catalyst inserts
    // an empty wrapper first and populates it a moment later. A fallback
    // timeout hides the overlay regardless, so a mutation shape we didn't
    // anticipate can't leave it stuck forever.
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

  // Already signed in (e.g. user navigated to /login manually) — skip
  // the form entirely instead of flashing it before redirecting away.
  if (status === SESSION_STATUS.AUTHENTICATED) {
    return <Navigate to={ROUTES.DASHBOARD} replace />;
  }

  if (status === SESSION_STATUS.UNKNOWN) {
    return <LoadingPage label="Checking session" />;
  }

  return (
    <div className="login-page">
      <div className="login-page__brand">
        <Logo size="md" />
        <p className="eyebrow login-page__eyebrow">Lead Exchange Platform</p>
        <h1 className="login-page__title">Sign in to your account</h1>
        <p className="login-page__subtitle">
          Enter your credentials to access the dealer and lead management
          console.
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

      <p className="login-page__footnote">
        Access is restricted to authorised MG dealer and admin accounts.
      </p>
    </div>
  );
}