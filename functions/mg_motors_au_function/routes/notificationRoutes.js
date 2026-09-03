'use strict';

const express = require('express');
const { listForUser, markRead, markAllRead, deleteNotification } = require('../services/notificationService');
const { normalizeRole } = require('../constants/roles.constants');
const logger = require('../utils/logger');

const router = express.Router();


// Need to check the updated Dealer CRM fields and update the application accordingly.
// Verify the field mappings and data flow with Zoho CRM.
// Test the completed Dealer CRM integration and validate the overall application flow.
// Fix any issues found during testing and ensure the completed functionalities are working as expected.

router.get('/notifications', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const currentUser = res.locals.currentUser;
    const role = normalizeRole(currentUser);

    const notifications = await listForUser(catalystApp, { userId: currentUser.user_id, role });
    const unreadCount = notifications.filter((n) => n.is_read !== true).length;

    res.status(200).json({ success: true, notifications, unreadCount });
  } catch (err) {
    logger.error('notificationRoutes', 'GET /notifications failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  try {
    await markRead(res.locals.catalystApp, req.params.id);
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('notificationRoutes', 'POST /notifications/:id/read failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/notifications/read-all', async (req, res) => {
  try {
    const currentUser = res.locals.currentUser;
    const role = normalizeRole(currentUser);
    await markAllRead(res.locals.catalystApp, { userId: currentUser.user_id, role });
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('notificationRoutes', 'POST /notifications/read-all failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// DELETE /notifications/:id
router.delete('/notifications/:id', async (req, res) => {
  try {
    await deleteNotification(res.locals.catalystApp, req.params.id);
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('notificationRoutes', 'DELETE /notifications/:id failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;