import axiosInstance from "./axiosInstance";

/**
 * adminDashboardService.js
 * -----------------------------------------------------------------------
 * Calls the /admin/* routes (Admin/Super Admin only, enforced server-side
 * by requireAdminRole). Read-only â€” no create/update/delete here.
 */

export const adminDashboardService = {
  async dashboardSummary() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/dashboard-summary");
    return data;
  },

  async listDealers() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/dealers");
    return data.dealers;
  },

  async listLeads({ dealerCode, leadStatus } = {}) {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/leads", {
      params: { dealerCode, leadStatus },
    });
    return data.leads;
  },

  // Unhappy 7: dealer records whose update arrived before an MG enquiry
  // was linked. They have no MG lead, so they are listed separately.
  async listOutOfOrderEvents() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/out-of-order-events");
    return data.events || [];
  },

  async leadsSummary() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/leads/summary");
    return data.summary;
  },

  async dealerPerformance() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/dealers/performance");
    return data.performance;
  },

  async syncLogs({ limit = 50 } = {}) {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/sync-logs", {
      params: { limit },
    });
    return data.logs;
  },

  async dealerInvitations() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/dealer-invitations");
    return data.dealers;
  },

  // NEW — chronological Happy/Unhappy activity history for one lead,
  // pulled from integration_logs, keyed by the lead's crm_record_id.
    async getLeadTimeline(crmRecordId) {
    const { data } = await axiosInstance.get(
      `/mg_motors_au_function/admin/leads/${crmRecordId}/timeline`
    );
    return data.timeline;
  },
};
