import axiosInstance from "./axiosInstance";

async function fetchAdminUsers() {
  const { data } = await axiosInstance.get("/mg_motors_au_function/admin-users");
  return { users: data.users, roleOptions: data.roleOptions || {} };
}

async function inviteAdminUser({ email, name, permissions }) {
  const { data } = await axiosInstance.post("/mg_motors_au_function/admin-users/invite", {
    email,
    name,
    permissions,
  });
  return data;
}

async function updateAdminUser(rowId, { admin_name, role_id }) {
  const { data } = await axiosInstance.put(
    `/mg_motors_au_function/admin-users/${encodeURIComponent(rowId)}`,
    { admin_name, role_id }
  );
  return data;
}

async function resendAdminUserInvite(rowId) {
  const { data } = await axiosInstance.post(
    `/mg_motors_au_function/admin-users/${encodeURIComponent(rowId)}/resend-invite`
  );
  return data;
}

async function removeAdminUser(rowId) {
  const { data } = await axiosInstance.delete(
    `/mg_motors_au_function/admin-users/${encodeURIComponent(rowId)}`
  );
  return data;
}

export const ADMIN_ROLE_OPTIONS = [
  { value: "37148000000359008", label: "Super Admin" },
  { value: "37148000000430003", label: "Admin" },
];

export const adminUserService = {
  fetchAdminUsers,
  inviteAdminUser,
  updateAdminUser,
  resendAdminUserInvite,
  removeAdminUser,
};