// Start the next timer after the current request settles; hidden pages do
// not poll, and returning to the page refreshes immediately.
export function startVisiblePolling(task, intervalMs, page = document) {
  let stopped = false;
  let running = false;
  let timer;
  const schedule = () => {
    if (!stopped && !page.hidden) timer = setTimeout(run, intervalMs);
  };
  const run = async () => {
    if (stopped || page.hidden || running) return;
    clearTimeout(timer);
    running = true;
    try {
      await task();
    } catch {
      // Callers present their own error; the next visible poll can recover.
    } finally {
      running = false;
      schedule();
    }
  };
  const onVisibilityChange = () => {
    clearTimeout(timer);
    if (!page.hidden) run();
  };
  page.addEventListener("visibilitychange", onVisibilityChange);
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    page.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
// Manual and automatic callers may share a task. A second call waits for the
// same operation; failures clear the slot so the next attempt can recover.
export function createSingleFlight(task) {
  let pending;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(task).then((value) => {
        pending = null;
        return value;
      }, (err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}

