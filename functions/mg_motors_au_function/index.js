'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const dealerSyncRoutes = require('./routes/dealerSyncRoutes');
const dealerInviteRoutes = require('./routes/dealerInviteRoutes');
const dealerLeadRoutes = require('./routes/dealerLeadRoutes');
const adminDashboardRoutes = require('./routes/adminDashboardRoutes');
const onDemandDashboardRoutes = require('./routes/onDemandDashboardRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const cronRoutes = require('./routes/cronRoutes');
const adminUserRoutes = require('./routes/adminUserRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const aiAssistantRoutes = require('./routes/aiAssistantRoutes');
const dealerCrmIntegrationRoutes = require('./routes/dealerCrmIntegrationRoutes');
const internalCostRoutes = require('./routes/internalCostRoutes');
const usageContext = require('./services/usageContext');

const app = express();

// First, so every request (webhooks and crons included) writes one usage line.
app.use(usageContext.middleware);

app.use('/', webhookRoutes);

// Internal cost page: its own access key, not Catalyst user login.
app.use('/', internalCostRoutes);

// strict:false so a bare `null` body (an empty POST sent as JSON) is accepted instead of 400.
app.use(express.json({ limit: '20mb', strict: false }));

app.use('/', cronRoutes);


app.use(async (req, res, next) => {
    try {
      const catalystApp = usageContext.initialize(catalyst, req);
      const currentUser = await catalystApp.userManagement().getCurrentUser();

    if (!currentUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    res.locals.catalystApp = catalystApp;
    res.locals.currentUser = currentUser;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Mount CRM sync routes AFTER the auth middleware above, so
// res.locals.catalystApp is guaranteed to be set for /crm/dealers and
// /sync/dealers.
app.use('/', dealerSyncRoutes);
app.use('/', dealerInviteRoutes); 
app.use('/', dealerLeadRoutes);
app.use('/', adminDashboardRoutes);
app.use('/', onDemandDashboardRoutes);
app.use('/', adminUserRoutes);
app.use('/', notificationRoutes);
app.use('/', aiAssistantRoutes);


app.use('/admin/dealers', dealerCrmIntegrationRoutes);


module.exports = app;
