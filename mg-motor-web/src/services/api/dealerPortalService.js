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

  async myLeadsSummary() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/dealer/leads/summary");
    return data.summary;
  },

  async updateLead(rowId, payload) {
    const { data } = await axiosInstance.patch(`/mg_motors_au_function/dealer/leads/${rowId}`, payload);
    return { ...data.lead, _crmSync: data.crmSync };
  },
};
