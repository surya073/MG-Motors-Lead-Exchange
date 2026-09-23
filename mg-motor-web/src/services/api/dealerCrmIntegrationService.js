import axiosInstance from "./axiosInstance";

/**
 * dealerCrmIntegrationService.js
 * -----------------------------------------------------------------------
 * Admin-only external CRM integration config for a dealer that already
 * exists in Zoho/Catalyst. Never creates a dealer — every call takes an
 * existing dealer_code and the backend resolves DEALER_NOT_FOUND (404)
 * if it doesn't match a synced dealer.
 *
 * Mirrors dealerInviteService.js's base path convention:
 * /mg_motors_au_function/admin/dealers/:dealerCode/...
 */

const BASE = "/mg_motors_au_function/admin/dealers";

export const dealerCrmIntegrationService = {
  async getIntegration(dealerCode) {
    const { data } = await axiosInstance.get(`${BASE}/${encodeURIComponent(dealerCode)}/integration`);
    return data;
  },

  async saveIntegration(dealerCode, payload) {
    const { data } = await axiosInstance.put(`${BASE}/${encodeURIComponent(dealerCode)}/integration`, payload);
    return data;
  },

  async testConnection(dealerCode) {
    const { data } = await axiosInstance.post(`${BASE}/${encodeURIComponent(dealerCode)}/integration/test`);
    return data;
  },

  async registerWebhook(dealerCode) {
    const { data } = await axiosInstance.post(
      `${BASE}/${encodeURIComponent(dealerCode)}/register-webhook`
    );
    return data;
  },

  async getMappings(dealerCode) {
    const { data } = await axiosInstance.get(`${BASE}/${encodeURIComponent(dealerCode)}/integration/mappings`);
    return data;
  },

  async saveMappings(dealerCode, payload) {
    const { data } = await axiosInstance.put(`${BASE}/${encodeURIComponent(dealerCode)}/integration/mappings`, payload);
    return data;
  },

  async getLogs(dealerCode) {
    const { data } = await axiosInstance.get(`${BASE}/${encodeURIComponent(dealerCode)}/integration/logs`);
    return data;
  },

  async retrySync(dealerCode, crmRecordId) {
    const { data } = await axiosInstance.post(`${BASE}/${encodeURIComponent(dealerCode)}/integration/sync`, { crmRecordId });
    return data;
  },

  async generateWebhookSecret(dealerCode) {
  const { data } = await axiosInstance.post(`${BASE}/${encodeURIComponent(dealerCode)}/integration/webhook-secret`);
  return data;
},

async getStatusPicklist() {
  const { data } = await axiosInstance.get(`${BASE}/oem-crm/status-picklist`);
  return data;
},

async refreshStatusPicklist() {
  const { data } = await axiosInstance.post(`${BASE}/oem-crm/status-picklist/refresh`);
  return data;
},

};
