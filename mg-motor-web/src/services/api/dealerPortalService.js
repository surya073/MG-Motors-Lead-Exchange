import axiosInstance from "./axiosInstance";

/**
 * dealerPortalService.js
 * -----------------------------------------------------------------------
 * Calls the /dealer/leads/* routes â€” always scoped server-side to the
 * logged-in Dealer's own dealer_code, never client-supplied.
 */

export const dealerPortalService = {
  async myLeads() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/dealer/leads");
    return data;
  },

  // One page of the dealer's leads, searched / filtered / sorted on the server.
  // Params: page (1-based), pageSize, search, status, sortKey, sortDir,
  // includeSummary. Resolves { leads, pagination, summary?, dealerCode }.
  async myLeadsPage(params = {}) {
    const { data } = await axiosInstance.get("/mg_motors_au_function/dealer/leads", { params });
    return data;
  },

  async myLeadsSummary() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/dealer/leads/summary");
    return data.summary;
  },

  async updateLead(rowId, payload) {
    const { data } = await axiosInstance.patch(`/mg_motors_au_function/dealer/leads/${rowId}`, payload);
    return { ...data.lead, _crmSync: data.crmSync };
  },
};
