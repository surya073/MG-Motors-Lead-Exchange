import axiosInstance from "./axiosInstance";

/**
 * adminDashboardService.js
 * -----------------------------------------------------------------------
 * Calls the /admin/* routes (Admin/Super Admin only, enforced server-side
 * by requireAdminRole). Read-only — no create/update/delete here.
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

  // One page of leads, filtered and sorted on the server (Lead Exchange page).
  // Returns { leads, pagination: { page, pageSize, total, totalPages, hasMore },
  // facets? } — facets (statuses, dealers, Happy/Unhappy counts, scenarios) come
  // back only when includeFacets is true.
  async listLeadsPage(params = {}) {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/leads", { params });
    return { leads: data.leads, pagination: data.pagination, facets: data.facets };
  },

  // A single lead by ROWID or crm_record_id, for the detail view when the lead
  // is not on the page currently loaded. Resolves null if it does not exist.
  async getLead(id) {
    try {
      const { data } = await axiosInstance.get(
        `/mg_motors_au_function/admin/leads/detail/${encodeURIComponent(id)}`
      );
      return data.lead;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
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

  // Chronological Happy/Unhappy activity history for one lead, pulled
  // from integration_logs, keyed by the lead's crm_record_id.
  async getLeadTimeline(crmRecordId) {
    const { data } = await axiosInstance.get(
      `/mg_motors_au_function/admin/leads/${crmRecordId}/timeline`
    );
    return data.timeline;
  },

  // NEW — paginated / filterable Integration Error report. Powers the
  // "Integration Errors" table on the Lead Exchange Health dashboard.
  async getIntegrationLogs({ fromDate, toDate, dealerCode, scenarioCode, status, page = 1, pageSize = 25 } = {}) {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/integration-logs", {
      params: { fromDate, toDate, dealerCode, scenarioCode, status, page, pageSize },
    });
    return data;
  },

  // NEW — Happy/Unhappy path breakdown, duplicate leads, SLA monitoring,
  // dealer health and exchange health, all scoped to an optional date
  // range + dealer filter. Powers the rest of the health dashboard.
  async getLeadExchangeHealth({ fromDate, toDate, dealerCode } = {}) {
    const { data } = await axiosInstance.get("/mg_motors_au_function/admin/lead-exchange-health", {
      params: { fromDate, toDate, dealerCode },
    });
    return data;
  },
};