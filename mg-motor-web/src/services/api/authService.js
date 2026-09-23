/**
 * authService.js
 * -----------------------------------------------------------------------
 * The Catalyst Web SDK isn't an npm package here â€” it's loaded via
 * <script> tags in public/index.html and attaches itself to `window.catalyst`
 * asynchronously. Every other file in the app should go through this
 * service instead of touching `window.catalyst` directly, for two reasons:
 *
 *   1. It's the one place that waits for the SDK to actually be ready,
 *      so a component mounting before the script finishes loading
 *      doesn't throw "window.catalyst is undefined".
 *   2. It's the one place that would need to change if Catalyst's SDK
 *      API shape ever changes.
 */

const SDK_READY_POLL_INTERVAL_MS = 50;
const SDK_READY_TIMEOUT_MS = 10000;

function waitForCatalystSdk() {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    (function poll() {
      if (window.catalyst && window.catalyst.auth) {
        resolve(window.catalyst);
        return;
      }
      if (Date.now() - start > SDK_READY_TIMEOUT_MS) {
        reject(
          new Error(
            "Catalyst Web SDK did not load in time. Check that the SDK <script> tags are present in public/index.html and that the app is being served through Catalyst (catalyst serve), not a bare CRA dev server."
          )
        );
        return;
      }
      setTimeout(poll, SDK_READY_POLL_INTERVAL_MS);
    })();
  });
}

/**
 * Resolves with the authenticated user's profile if a valid session
 * exists, or rejects if the user is not signed in. Mirrors the promise
 * behavior of catalyst.auth.isUserAuthenticated() directly.
 */
async function getCurrentSession() {
  const catalyst = await waitForCatalystSdk();
  const result = await catalyst.auth.isUserAuthenticated();
  console.log('[AUTH-DEBUG] isUserAuthenticated raw result:', JSON.stringify(result));
  return result?.content ?? null;
}

/**
 * Embeds Catalyst's sign-in iframe into the DOM node with id `elementId`.
 * Does not return a promise â€” the iframe drives the actual sign-in flow
 * and Catalyst redirects the browser to `config.service_url` on success.
 */
async function renderSignIn(elementId, config) {
  const catalyst = await waitForCatalystSdk();
  catalyst.auth.signIn(elementId, config);
}

/**
 * Signs the current user out and redirects the browser to `redirectUrl`.
 * Does not return a promise (matches the underlying SDK method).
 */
async function signOut(redirectUrl) {
  const catalyst = await waitForCatalystSdk();
  catalyst.auth.signOut(redirectUrl);
}

/**
 * Resolves the logged-in user's Dealer_Code by querying the backend's
 * dealer_user_mapping table via the logged-in user's Catalyst user ID.
 * Returns null if no mapping exists (e.g. user isn't a Dealer, or the
 * mapping wasn't created yet) â€” callers must treat null as "context not
 * resolved," never fall back to showing all leads.
 */
async function generateAuthToken() {
  const catalyst = await waitForCatalystSdk();
  const response = await catalyst.auth.generateAuthToken();
  return response?.access_token ?? null;
}

async function getDealerContext(profile) {
  const userId = profile?.user_id ?? null;
  if (!userId) return null;

  try {
    const token = await generateAuthToken();
    const response = await fetch(`/server/mg_motors_au_function/dealer-context/${userId}`, {
      credentials: 'include',
      headers: token ? { Authorization: token } : {},
    });
    const json = await response.json();
    return json?.dealer_code ?? null;
  } catch {
    return null;
  }
}

async function sendPasswordReset(email) {
  const catalyst = await waitForCatalystSdk();
  await catalyst.auth.forgotPassword(email, {
    platform_type: "web",
  });
}

export const authService = {
  getCurrentSession,
  renderSignIn,
  signOut,
  getDealerContext,
  generateAuthToken,
  sendPasswordReset
};

