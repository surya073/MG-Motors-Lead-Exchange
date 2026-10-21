'use strict';

const express = require('express');
const {
  listForUser,
  countUnreadForUser,
  markRead,
  markAllRead,
  deleteNotification,
  clearAllForUser,
} = require('../services/notificationService');
const { normalizeRole } = require('../constants/roles.constants');
const logger = require('../utils/logger');

const router = express.Router();


function scopeFor(res) {
  const currentUser = res.locals.currentUser;
  return { userId: currentUser?.user_id, role: normalizeRole(currentUser) };
}

router.get('/notifications', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const scope = scopeFor(res);
    const unreadOnly = String(req.query.unreadOnly).toLowerCase() === 'true';
    const [notifications, unreadCount] = await Promise.all([
      listForUser(catalystApp, { ...scope, unreadOnly }),
      countUnreadForUser(catalystApp, scope),
    ]);

    res.status(200).json({ success: true, notifications, unreadCount });
  } catch (err) {
    logger.error('notificationRoutes', 'GET /notifications failed', err);
    res.status(err.statusCode || 502).json({ success: false, error: err.message });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  try {
    await markRead(res.locals.catalystApp, req.params.id, scopeFor(res));
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('notificationRoutes', 'POST /notifications/:id/read failed', err);
    res.status(err.statusCode || 502).json({ success: false, error: err.message });
  }
});

router.post('/notifications/read-all', async (req, res) => {
  try {
    const result = await markAllRead(res.locals.catalystApp, scopeFor(res));
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('notificationRoutes', 'POST /notifications/read-all failed', err);
    res.status(err.statusCode || 502).json({ success: false, error: err.message });
  }
});

// DELETE /notifications  — clear everything the caller can see
router.delete('/notifications', async (req, res) => {
  try {
    const result = await clearAllForUser(res.locals.catalystApp, scopeFor(res));
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('notificationRoutes', 'DELETE /notifications failed', err);
    res.status(err.statusCode || 502).json({ success: false, error: err.message });
  }
});

// DELETE /notifications/:id
router.delete('/notifications/:id', async (req, res) => {
  try {
    await deleteNotification(res.locals.catalystApp, req.params.id, scopeFor(res));
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('notificationRoutes', 'DELETE /notifications/:id failed', err);
    res.status(err.statusCode || 502).json({ success: false, error: err.message });
  }
});

module.exports = router;
