import React, { act } from "react";
import { createRoot } from "react-dom/client";
import NotificationBell from "./NotificationBell";
import { notificationService } from "../../../services/api/notificationService";

jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }));
jest.mock("../../../contexts/AuthContext", () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock("../../../ui/Alerts/Alerts", () => ({ useAlerts: () => ({ error: jest.fn() }), getErrorMessage: (_, fallback) => fallback }));
jest.mock("../../../utils/notificationStyle", () => ({ useNotificationStyle: () => ["count"] }));
jest.mock("../../../services/api/notificationService", () => ({ notificationService: { list: jest.fn(), markRead: jest.fn(), remove: jest.fn(), markAllRead: jest.fn(), clearAll: jest.fn() } }));

let container;
let root;
let mockUser;
const row = (id = "1") => ({ ROWID: id, is_read: false, title: "Dealer update", message: "Updated", CREATEDTIME: "2026-10-01 00:00:00" });
const click = async (button) => act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const namedButton = (text) => [...container.querySelectorAll("button")].find((button) => button.textContent.includes(text));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const unreadResult = () => ({ notifications: [{ ...row("older"), title: "Older unread" }], unreadCount: 101 });
const mockFilteredList = () => notificationService.list.mockImplementation(({ unreadOnly }) => Promise.resolve(
  unreadOnly ? unreadResult() : { notifications: [{ ...row("newer"), title: "Newer read", is_read: true }], unreadCount: 101 }
));
const startBulk = async (action) => {
  if (action === "markAllRead") return click(namedButton("Mark all read"));
  await click(namedButton("Clear all"));
  await click(namedButton("Click to confirm"));
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mockUser = { user_id: "u1", appRole: "ADMIN" };
  jest.resetAllMocks();
  notificationService.list.mockResolvedValue({ notifications: [row()], unreadCount: 2101 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<NotificationBell />); });
  await click(container.querySelector('[aria-label="Notifications"]'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("a partial mark-all refreshes actual remaining count and offers a continuation action", async () => {
  notificationService.markAllRead.mockResolvedValueOnce({ markedRead: 2000, hasMore: true }).mockResolvedValueOnce({ markedRead: 101, hasMore: false });
  notificationService.list.mockResolvedValue({ notifications: [row("older")], unreadCount: 101 });
  await click(namedButton("Mark all read"));
  expect(container.textContent).toContain("More unread notifications remain");
  expect(namedButton("Mark all read")).toBeDefined();
  await click(namedButton("Mark all read"));
  expect(notificationService.markAllRead).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("More unread notifications remain");
});

test("a partial clear-all displays remaining notifications and does not claim an empty inbox", async () => {
  notificationService.clearAll.mockResolvedValue({ deleted: 2000, hasMore: true });
  notificationService.list.mockResolvedValue({ notifications: [row("older")], unreadCount: 101 });
  await click(namedButton("Clear all"));
  await click(namedButton("Click to confirm"));
  expect(notificationService.clearAll).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("More notifications remain");
  expect(container.textContent).toContain("Dealer update");
  expect(namedButton("Clear all")).toBeDefined();
});

test("unread tab requests older unread rows directly and remains switchable when empty", async () => {
  notificationService.list.mockResolvedValue({ notifications: [], unreadCount: 0 });
  await click(namedButton("Unread"));
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: true });
  expect(namedButton("All")).toBeDefined();
  await click(namedButton("All"));
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: false });
});

test("a failed refresh after partial clearing still offers the continuation action", async () => {
  notificationService.clearAll.mockResolvedValue({ deleted: 2000, hasMore: true });
  notificationService.list.mockRejectedValue(new Error("refresh unavailable"));
  await click(namedButton("Clear all"));
  await click(namedButton("Click to confirm"));
  expect(container.textContent).toContain("More notifications remain");
  expect(container.textContent).not.toContain("You're all caught up");
  expect(namedButton("Clear all")).toBeDefined();
});

test("a failed refresh after partial reading preserves a usable Mark all read action", async () => {
  notificationService.markAllRead.mockResolvedValue({ markedRead: 2000, hasMore: true });
  notificationService.list.mockRejectedValue(new Error("refresh unavailable"));
  await click(namedButton("Mark all read"));
  expect(namedButton("Mark all read")).toBeDefined();
  expect(container.textContent).toContain("More unread notifications remain");
});

test("identity changes clear old notifications while the new authenticated list loads", async () => {
  let resolve;
  notificationService.list.mockImplementation(() => new Promise((done) => { resolve = done; }));
  mockUser = { user_id: "u2", appRole: "DEALER" };
  await act(async () => { root.render(<NotificationBell />); });
  expect(container.textContent).not.toContain("Dealer update");
  await act(async () => { resolve({ notifications: [{ ...row("own"), title: "Own dealer notice" }], unreadCount: 1 }); });
  expect(container.textContent).toContain("Own dealer notice");
});

test("a failed clear from an earlier actor cannot restore their notifications into the new actor's view", async () => {
  let rejectClear;
  notificationService.clearAll.mockImplementation(() => new Promise((_, reject) => { rejectClear = reject; }));
  await click(namedButton("Clear all"));
  await click(namedButton("Click to confirm"));
  mockUser = { user_id: "u2", appRole: "DEALER" };
  notificationService.list.mockResolvedValue({ notifications: [{ ...row("own"), title: "Own dealer notice" }], unreadCount: 1 });
  await act(async () => { root.render(<NotificationBell />); });
  expect(container.textContent).toContain("Own dealer notice");
  const calls = notificationService.list.mock.calls.length;
  // A refresh failure would leave a wrongly restored old snapshot visible.
  notificationService.list.mockRejectedValue(new Error("new actor refresh unavailable"));
  await act(async () => { rejectClear(new Error("old actor clear failed")); });
  expect(container.textContent).not.toContain("Dealer update");
  expect(container.textContent).toContain("Own dealer notice");
  expect(notificationService.list).toHaveBeenCalledTimes(calls);
});

test.each(["markAllRead", "clearAll"])("partial %s completion refreshes the selected Unread tab after switching", async (action) => {
  const pending = deferred();
  notificationService[action].mockReturnValue(pending.promise);
  await startBulk(action);
  mockFilteredList();
  await click(namedButton("Unread"));
  expect(container.textContent).toContain("Older unread");
  await act(async () => { pending.resolve({ markedRead: 2000, deleted: 2000, hasMore: true }); });
  expect(container.querySelector('[role="tab"][aria-selected="true"]').textContent).toContain("Unread");
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: true });
  expect(container.textContent).toContain("Older unread");
  expect(container.textContent).not.toContain("Newer read");
  expect(namedButton("Mark all read")).toBeDefined();
});

test.each(["markAllRead", "clearAll"])("completed %s reconciles a new tab that loaded before the mutation finished", async (action) => {
  const pending = deferred();
  notificationService[action].mockReturnValue(pending.promise);
  await startBulk(action);
  mockFilteredList();
  await click(namedButton("Unread"));
  expect(container.textContent).toContain("Older unread");
  notificationService.list.mockResolvedValue({ notifications: [], unreadCount: 0 });
  await act(async () => { pending.resolve({ markedRead: 2101, deleted: 2101, hasMore: false }); });
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: true });
  expect(container.textContent).not.toContain("Older unread");
  expect(container.querySelector('[role="tab"][aria-selected="true"]').textContent).toContain("Unread");
});

test.each(["markAllRead", "clearAll"])("failed %s refreshes the current tab without restoring an earlier tab snapshot", async (action) => {
  const pending = deferred();
  notificationService[action].mockReturnValue(pending.promise);
  await startBulk(action);
  mockFilteredList();
  await click(namedButton("Unread"));
  notificationService.list.mockRejectedValue(new Error("refresh unavailable"));
  await act(async () => { pending.reject(new Error("mutation failed")); });
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: true });
  expect(container.textContent).toContain("Older unread");
  expect(container.textContent).not.toContain("Dealer update");
  expect(namedButton("Mark all read")).toBeDefined();
});

test("a failed clear cannot restore a snapshot after switching away and back to the same tab", async () => {
  const pending = deferred();
  notificationService.clearAll.mockReturnValue(pending.promise);
  await startBulk("clearAll");
  mockFilteredList();
  await click(namedButton("Unread"));
  await click(namedButton("All"));
  expect(container.textContent).toContain("Newer read");
  notificationService.list.mockRejectedValue(new Error("refresh unavailable"));
  await act(async () => { pending.reject(new Error("mutation failed")); });
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: false });
  expect(container.textContent).toContain("Newer read");
  expect(container.textContent).not.toContain("Dealer update");
});

test.each([["markRead", "Mark as read"], ["remove", "Delete notification"]])("failed %s refreshes the tab selected while the row action was pending", async (action, label) => {
  const pending = deferred();
  notificationService[action].mockReturnValue(pending.promise);
  await click(container.querySelector(`[aria-label="${label}"]`));
  mockFilteredList();
  await click(namedButton("Unread"));
  await act(async () => { pending.reject(new Error("mutation failed")); });
  expect(notificationService.list).toHaveBeenLastCalledWith({ unreadOnly: true });
  expect(container.textContent).toContain("Older unread");
  expect(container.textContent).not.toContain("Newer read");
});

test("an old filter response cannot replace the current filter's completed response", async () => {
  const pending = deferred();
  notificationService.list.mockImplementation(({ unreadOnly }) => unreadOnly ? Promise.resolve(unreadResult()) : pending.promise);
  await click(container.querySelector('[aria-label="Notifications"]'));
  await click(container.querySelector('[aria-label="Notifications"]'));
  await click(namedButton("Unread"));
  await act(async () => { pending.resolve({ notifications: [row()], unreadCount: 2101 }); });
  expect(container.textContent).toContain("Older unread");
  expect(container.textContent).not.toContain("Dealer update");
});
