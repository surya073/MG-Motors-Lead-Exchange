import { loadSearchSuggestions, clearSearchSuggestions } from "./searchSuggestions";
import { adminDashboardService } from "../services/api/adminDashboardService";
import { dealerPortalService } from "../services/api/dealerPortalService";
import { APP_ROLES } from "../constants/auth.constants";

jest.mock("../services/api/adminDashboardService", () => ({ adminDashboardService: { searchSuggestions: jest.fn() } }));
jest.mock("../services/api/dealerPortalService", () => ({ dealerPortalService: { searchSuggestions: jest.fn() } }));

beforeEach(() => {
  clearSearchSuggestions();
  jest.clearAllMocks();
  adminDashboardService.searchSuggestions.mockResolvedValue({ leads: [{ ROWID: "1" }], dealers: [] });
  dealerPortalService.searchSuggestions.mockResolvedValue({ leads: [{ ROWID: "2" }], dealers: [] });
});

test("opening search with no useful query or identity costs no API requests", async () => {
  for (const query of ["", "a", "   "]) await loadSearchSuggestions(APP_ROLES.ADMIN, "u1", query);
  await loadSearchSuggestions(APP_ROLES.ADMIN, "", "Alice");
  expect(adminDashboardService.searchSuggestions).not.toHaveBeenCalled();
  expect(dealerPortalService.searchSuggestions).not.toHaveBeenCalled();
});

test("simultaneous identical searches coalesce, and the short cache reuses their result", async () => {
  const [first, second] = await Promise.all([
    loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice AU001"),
    loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "alice au001"),
  ]);
  expect(first).toEqual(second);
  expect(adminDashboardService.searchSuggestions).toHaveBeenCalledTimes(1);
  expect(adminDashboardService.searchSuggestions).toHaveBeenCalledWith("Alice AU001");
  await loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice AU001");
  expect(adminDashboardService.searchSuggestions).toHaveBeenCalledTimes(1);
});

test("search cache never shares another authenticated identity or role's response", async () => {
  await loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice");
  await loadSearchSuggestions(APP_ROLES.ADMIN, "u2", "Alice");
  await loadSearchSuggestions(APP_ROLES.VIEW_USER, "u1", "Alice");
  const dealer = await loadSearchSuggestions(APP_ROLES.DEALER, "u1", "Alice");
  expect(adminDashboardService.searchSuggestions).toHaveBeenCalledTimes(3);
  expect(dealerPortalService.searchSuggestions).toHaveBeenCalledTimes(1);
  expect(dealer.leads[0].ROWID).toBe("2");
});

test("failed requests are retried instead of caching an empty successful result", async () => {
  adminDashboardService.searchSuggestions.mockRejectedValueOnce(new Error("temporary"));
  await expect(loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice")).rejects.toThrow("temporary");
  await loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice");
  expect(adminDashboardService.searchSuggestions).toHaveBeenCalledTimes(2);
});

test("expired suggestions are reloaded", async () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
  try {
    await loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice");
    clock.mockReturnValue(31001);
    await loadSearchSuggestions(APP_ROLES.ADMIN, "u1", "Alice");
    expect(adminDashboardService.searchSuggestions).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});
