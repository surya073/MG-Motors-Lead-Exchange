import axiosInstance from "./axiosInstance";

export async function syncDealersService() {
  const { data } = await axiosInstance.post("/mg_motors_au_function/sync/dealers");
  return data;
}

export async function syncLeadsService() {
  const { data } = await axiosInstance.post("/mg_motors_au_function/sync/leads");
  return data;
}


