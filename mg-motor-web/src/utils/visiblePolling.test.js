import { createSingleFlight, startVisiblePolling } from "./visiblePolling";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fakePage(hidden = false) {
  const listeners = new Set();
  return { hidden, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
    change(value) { this.hidden = value; listeners.forEach((fn) => fn()); }, listeners };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("visible polling refreshes immediately, then every two minutes after completion", async () => {
  const task = jest.fn().mockResolvedValue(undefined);
  const stop = startVisiblePolling(task, 120000, fakePage());
  await flush();
  expect(task).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(119999);
  expect(task).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1);
  await flush();
  expect(task).toHaveBeenCalledTimes(2);
  stop();
});

test("hidden pages do no polling and returning visible refreshes immediately", async () => {
  const task = jest.fn().mockResolvedValue(undefined);
  const page = fakePage(true);
  const stop = startVisiblePolling(task, 120000, page);
  jest.advanceTimersByTime(600000);
  expect(task).not.toHaveBeenCalled();
  page.change(false);
  await flush();
  expect(task).toHaveBeenCalledTimes(1);
  page.change(true);
  jest.advanceTimersByTime(600000);
  expect(task).toHaveBeenCalledTimes(1);
  page.change(false);
  await flush();
  expect(task).toHaveBeenCalledTimes(2);
  stop();
});

test("a slow request never overlaps on timers or repeated visibility changes", async () => {
  let resolve;
  const task = jest.fn(() => new Promise((done) => { resolve = done; }));
  const page = fakePage();
  const stop = startVisiblePolling(task, 120000, page);
  jest.advanceTimersByTime(600000);
  page.change(true);
  page.change(false);
  page.change(false);
  expect(task).toHaveBeenCalledTimes(1);
  resolve();
  await flush();
  jest.advanceTimersByTime(120000);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
  resolve();
  await flush();
});

test("manual refresh shares an ongoing automatic request and remains immediate between polls", async () => {
  let resolve;
  const task = jest.fn(() => new Promise((done) => { resolve = done; }));
  const load = createSingleFlight(task);
  const stop = startVisiblePolling(load, 120000, fakePage());
  await flush();
  const manual = load();
  expect(task).toHaveBeenCalledTimes(1);
  resolve("first");
  await expect(manual).resolves.toBe("first");
  await flush();
  const nextManual = load();
  await flush();
  expect(task).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(120000);
  expect(task).toHaveBeenCalledTimes(2);
  resolve("second");
  await expect(nextManual).resolves.toBe("second");
  await flush();
  stop();
});

test("cleanup prevents rescheduling after a pending request completes", async () => {
  let resolve;
  const task = jest.fn(() => new Promise((done) => { resolve = done; }));
  const page = fakePage();
  const stop = startVisiblePolling(task, 120000, page);
  stop();
  resolve();
  await flush();
  page.change(false);
  jest.advanceTimersByTime(600000);
  expect(task).toHaveBeenCalledTimes(1);
  expect(page.listeners.size).toBe(0);
});

test("a rejected shared request clears its slot and the next request can recover", async () => {
  const task = jest.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce("recovered");
  const load = createSingleFlight(task);
  await expect(load()).rejects.toThrow("temporary");
  await expect(load()).resolves.toBe("recovered");
  expect(task).toHaveBeenCalledTimes(2);
});
