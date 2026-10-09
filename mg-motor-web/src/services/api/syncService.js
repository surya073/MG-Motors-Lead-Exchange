import axiosInstance from "./axiosInstance";

// A full sync processes every lead/dealer sequentially and can run for
// minutes; the shared client's 15s default made the UI report "Sync failed"
// while the sync was still running server-side (and a retry then started an
// overlapping run).
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

export async function syncDealersService() {
  const { data } = await axiosInstance.post("/mg_motors_au_function/sync/dealers", {}, { timeout: SYNC_TIMEOUT_MS });
  return data;
}

export async function syncLeadsService() {
  const { data } = await axiosInstance.post("/mg_motors_au_function/sync/leads", {}, { timeout: SYNC_TIMEOUT_MS });
  return data;
}


