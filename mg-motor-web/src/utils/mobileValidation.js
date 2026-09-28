// Mirrors pathPolicyService.js's normalizePhone / isValidAustralianMobile on
// the backend. Duplicated rather than shared because the function and the
// client are two separate deployables with no shared code (same pattern as
// the role-ID mapping duplicated in constants/auth.constants.js) — kept in
// sync by hand if the Australian mobile rule ever changes.
//
// UI-only: this never blocks a lead or its dealer CRM push (see
// pathPolicyService.validateLeadForDelivery), it only flags the number for
// the operator to review.

export function normalizeAustralianMobile(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("61") && digits.length === 11) digits = `0${digits.slice(2)}`;
  else if (digits.startsWith("610") && digits.length === 12) digits = `0${digits.slice(3)}`;
  return digits;
}

export function isValidAustralianMobile(value) {
  const mobile = normalizeAustralianMobile(value);
  return /^04\d{8}$/.test(mobile) && !/^0+$/.test(mobile);
}
