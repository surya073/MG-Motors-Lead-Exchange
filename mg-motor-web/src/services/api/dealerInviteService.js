import axiosInstance from "./axiosInstance";

export async function inviteDealer(crmRecordId) {
  const { data } = await axiosInstance.post("/mg_motors_au_function/dealers/invite", { crmRecordId });
  return data;
}

export async function resendDealerInvite(dealerCode) {
  const { data } = await axiosInstance.post(
    `/mg_motors_au_function/dealers/${encodeURIComponent(dealerCode)}/resend-invite`
  );
  return data;
}

export async function removeDealer(dealerCode) {
  const { data } = await axiosInstance.delete(`/mg_motors_au_function/admin/dealers/${encodeURIComponent(dealerCode)}`);
  return data;
}