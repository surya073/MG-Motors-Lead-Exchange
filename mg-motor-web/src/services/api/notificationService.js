import axiosInstance from "./axiosInstance";

export const notificationService = {
  async list() {
    const { data } = await axiosInstance.get("/mg_motors_au_function/notifications");
    return data;
  },

  async markRead(notificationId) {
    const { data } = await axiosInstance.post(
      `/mg_motors_au_function/notifications/${notificationId}/read`
    );
    return data;
  },

  async markAllRead() {
    const { data } = await axiosInstance.post("/mg_motors_au_function/notifications/read-all");
    return data;
  },

  async remove(notificationId) {
    const { data } = await axiosInstance.delete(
      `/mg_motors_au_function/notifications/${notificationId}`
    );
    return data;
  },
};