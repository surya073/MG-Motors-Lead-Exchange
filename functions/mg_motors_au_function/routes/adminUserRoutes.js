'use strict';

const express = require('express');
const {
  listUsers,
  inviteUser,
  resendUserInvite,
  removeUser,
  updateUser,
  ROLE_LABELS,
} = require('../services/adminUserService');
const { requireSuperAdminRole } = require('../middleware/requireSuperAdminRole');
const logger = require('../utils/logger');

const router = express.Router();

// GET /admin-users  — list Invited / Active / Removed users
router.get('/admin-users', requireSuperAdminRole, async (req, res) => {
  try {
    const users = await listUsers(res.locals.catalystApp);
    res.status(200).json({ success: true, users, roleOptions: ROLE_LABELS });
  } catch (err) {
    logger.error('adminUserRoutes', 'GET /admin-users failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// POST /admin-users/invite  { email, name, permissions }
router.post('/admin-users/invite', requireSuperAdminRole, async (req, res) => {
  try {
    const { email, name, permissions } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    const result = await inviteUser(res.locals.catalystApp, { email, name, permissions });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminUserRoutes', 'POST /admin-users/invite failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// PUT /admin-users/:rowId  { admin_name, role_id }
router.put('/admin-users/:rowId', requireSuperAdminRole, async (req, res) => {
  try {
    const { admin_name, role_id } = req.body;
    const result = await updateUser(res.locals.catalystApp, req.params.rowId, { admin_name, role_id });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminUserRoutes', 'PUT /admin-users/:rowId failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// POST /admin-users/:rowId/resend-invite
router.post('/admin-users/:rowId/resend-invite', requireSuperAdminRole, async (req, res) => {
  try {
    const result = await resendUserInvite(res.locals.catalystApp, req.params.rowId);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminUserRoutes', 'POST /admin-users/:rowId/resend-invite failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// DELETE /admin-users/:rowId  — revoke access
router.delete('/admin-users/:rowId', requireSuperAdminRole, async (req, res) => {
  try {
    const result = await removeUser(res.locals.catalystApp, req.params.rowId);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminUserRoutes', 'DELETE /admin-users/:rowId failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;