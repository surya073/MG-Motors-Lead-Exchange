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






const app = express();


app.use('/', webhookRoutes);

app.use(express.json({ limit: '20mb' }));

app.use('/', cronRoutes);


// TODO: replace with your actual Dealers table ID from the Catalyst console
const DEALERS_TABLE_ID = '37148000000425015';

const ALLOWED_STATUSES = ['active', 'inactive', 'pending'];


app.use(async (req, res, next) => {
    try {
      const catalystApp = catalyst.initialize(req);
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

function generateApiKey() {
  return [...Array(4)]
    .map(() => Math.random().toString(36).slice(2, 10))
    .join('-');
}

// GET /dealers?search=&nextToken=&maxRows=
app.get('/dealers', async (req, res) => {
  try {
    const table = res.locals.catalystApp.datastore().table(DEALERS_TABLE_ID);
    const { search = '', nextToken, maxRows = '20' } = req.query;

    const page = await table.getPagedRows({
      nextToken: nextToken || undefined,
      maxRows: Number(maxRows),
    });

    const normalizedSearch = search.trim().toLowerCase();
    const rows = normalizedSearch
      ? page.data.filter((row) =>
          [row.Name, row.ContactPerson, row.Email, row.Region]
            .filter(Boolean)
            .some((field) => field.toLowerCase().includes(normalizedSearch))
        )
      : page.data;

    res.status(200).json({
      dealers: rows,
      nextToken: page.next_token,
      moreRecords: page.more_records,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /dealers/:rowId
app.get('/dealers/:rowId', async (req, res) => {
  try {
    const table = res.locals.catalystApp.datastore().table(DEALERS_TABLE_ID);
    const row = await table.getRow(req.params.rowId);
    res.status(200).json({ dealer: row });
  } catch (error) {
    res.status(404).json({ error: 'Dealer not found' });
  }
});

// POST /dealers
app.post('/dealers', async (req, res) => {
  try {
    const { Name, ContactPerson, Email, Phone, Region, APIEndpoint, Status } = req.body;

    if (!Name || !Email) {
      return res.status(400).json({ error: 'Name and Email are required' });
    }
    if (Status && !ALLOWED_STATUSES.includes(Status)) {
      return res.status(400).json({ error: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    }

    const table = res.locals.catalystApp.datastore().table(DEALERS_TABLE_ID);
    const row = await table.insertRow({
      Name,
      ContactPerson: ContactPerson || '',
      Email,
      Phone: Phone || '',
      Region: Region || '',
      APIEndpoint: APIEndpoint || '',
      APIKey: generateApiKey(),
      Status: Status || 'pending',
    });

    res.status(201).json({ dealer: row });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /dealers/:rowId
app.put('/dealers/:rowId', async (req, res) => {
  try {
    const { Status } = req.body;
    if (Status && !ALLOWED_STATUSES.includes(Status)) {
      return res.status(400).json({ error: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
    }

    const table = res.locals.catalystApp.datastore().table(DEALERS_TABLE_ID);
    const row = await table.updateRow({
      ROWID: req.params.rowId,
      ...req.body,
    });

    res.status(200).json({ dealer: row });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /dealers/:rowId/regenerate-key
app.post('/dealers/:rowId/regenerate-key', async (req, res) => {
  try {
    const table = res.locals.catalystApp.datastore().table(DEALERS_TABLE_ID);
    const row = await table.updateRow({
      ROWID: req.params.rowId,
      APIKey: generateApiKey(),
    });
    res.status(200).json({ dealer: row });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /dealers/:rowId
app.delete('/dealers/:rowId', async (req, res) => {
  try {
    const table = res.locals.catalystApp.datastore().table(DEALERS_TABLE_ID);
    await table.deleteRow(req.params.rowId);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TODO: replace with your actual table IDs from the Catalyst console
const LEADS_TABLE_ID = '37148000000442417';
const LEAD_DELIVERY_LOGS_TABLE_ID = '37148000000425411';

const MAX_DELIVERY_ATTEMPTS = 3;

async function loadDealerMap(catalystApp) {
  const table = catalystApp.datastore().table(DEALERS_TABLE_ID);
  const map = new Map();
  let nextToken;
  do {
    const page = await table.getPagedRows({ nextToken, maxRows: 100 });
    page.data.forEach((row) => map.set(row.ROWID, row));
    nextToken = page.more_records ? page.next_token : undefined;
  } while (nextToken);
  return map;
}

// GET /leads?status=&search=&nextToken=&maxRows=  (admin only)
app.get('/leads', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const table = catalystApp.datastore().table(LEADS_TABLE_ID);
    const { status = '', search = '', nextToken, maxRows = '20' } = req.query;

    const page = await table.getPagedRows({
      nextToken: nextToken || undefined,
      maxRows: Number(maxRows),
    });

    const dealerMap = await loadDealerMap(catalystApp);
    const normalizedSearch = search.trim().toLowerCase();

    let rows = page.data.map((row) => ({
      ...row,
      DealerName: dealerMap.get(row.DealerID)?.Name || 'Unassigned',
    }));

    if (status) {
      rows = rows.filter((row) => row.DeliveryStatus === status);
    }
    if (normalizedSearch) {
      rows = rows.filter((row) =>
        [row.CustomerName, row.CustomerEmail, row.DealerName]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(normalizedSearch))
      );
    }

    res.status(200).json({
      leads: rows,
      nextToken: page.next_token,
      moreRecords: page.more_records,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /leads/:rowId
app.get('/leads/:rowId', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const leadsTable = catalystApp.datastore().table(LEADS_TABLE_ID);
    const logsTable = catalystApp.datastore().table(LEAD_DELIVERY_LOGS_TABLE_ID);

    const lead = await leadsTable.getRow(req.params.rowId);

    const dealerMap = await loadDealerMap(catalystApp);
    const dealer = dealerMap.get(lead.DealerID) || null;

    const timeline = [];
    let nextToken;
    do {
      const page = await logsTable.getPagedRows({ nextToken, maxRows: 100 });
      timeline.push(...page.data.filter((log) => log.LeadID === req.params.rowId));
      nextToken = page.more_records ? page.next_token : undefined;
    } while (nextToken);

    timeline.sort((a, b) => Number(a.AttemptNumber) - Number(b.AttemptNumber));

    res.status(200).json({
      lead: { ...lead, DealerName: dealer?.Name || 'Unassigned' },
      dealer,
      timeline,
    });
  } catch (error) {
    res.status(404).json({ error: 'Lead not found' });
  }
});

// POST /leads  (admin only — manual/test lead entry)
app.post('/leads', async (req, res) => {
  try {
    const { CustomerName, CustomerPhone, CustomerEmail, DealerID, Source } = req.body;

    if (!CustomerName || !DealerID) {
      return res.status(400).json({ error: 'Customer name and dealer are required' });
    }

    const table = res.locals.catalystApp.datastore().table(LEADS_TABLE_ID);
    const row = await table.insertRow({
      CustomerName,
      CustomerPhone: CustomerPhone || '',
      CustomerEmail: CustomerEmail || '',
      DealerID,
      Source: Source || 'Manual',
      Status: 'new',
      DeliveryStatus: 'queued',
      AttemptCount: 0,
    });

    res.status(201).json({ lead: row });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /leads/:rowId/deliver  (admin only)
app.post('/leads/:rowId/deliver', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const leadsTable = catalystApp.datastore().table(LEADS_TABLE_ID);
    const logsTable = catalystApp.datastore().table(LEAD_DELIVERY_LOGS_TABLE_ID);

    const lead = await leadsTable.getRow(req.params.rowId);
    const currentAttempt = Number(lead.AttemptCount || 0) + 1;

    if (currentAttempt > MAX_DELIVERY_ATTEMPTS) {
      return res.status(400).json({ error: 'Maximum delivery attempts already reached' });
    }

    const dealerMap = await loadDealerMap(catalystApp);
    const dealer = dealerMap.get(lead.DealerID);

    if (!dealer?.APIEndpoint) {
      return res.status(400).json({ error: 'This dealer has no API endpoint configured' });
    }

    let result;
    let httpStatus = '';
    let message = '';

    try {
      const response = await fetch(dealer.APIEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dealer.APIKey}`,
        },
        body: JSON.stringify({
          leadId: lead.ROWID,
          customerName: lead.CustomerName,
          customerPhone: lead.CustomerPhone,
          customerEmail: lead.CustomerEmail,
          source: lead.Source,
        }),
      });

      httpStatus = String(response.status);
      result = response.ok ? 'success' : 'failed';
      message = response.ok ? 'Delivered successfully' : `Dealer endpoint responded with ${response.status}`;
    } catch (fetchError) {
      result = 'failed';
      message = `Could not reach dealer endpoint: ${fetchError.message}`;
    }

    await logsTable.insertRow({
      LeadID: lead.ROWID,
      AttemptNumber: currentAttempt,
      Results: result,
      HttpStatus: httpStatus,
      Message: message,
    });

    const exhausted = currentAttempt >= MAX_DELIVERY_ATTEMPTS;
    const updatedLead = await leadsTable.updateRow({
      ROWID: lead.ROWID,
      AttemptCount: currentAttempt,
      DeliveryStatus: result === 'success' ? 'delivered' : exhausted ? 'failed' : 'retrying',
      Status: result === 'success' ? 'delivered' : exhausted ? 'failed' : lead.Status,
    });

    res.status(200).json({ lead: updatedLead, attemptResult: { result, httpStatus, message } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /leads/:rowId  (admin only)
app.delete('/leads/:rowId', async (req, res) => {
  try {
    const table = res.locals.catalystApp.datastore().table(LEADS_TABLE_ID);
    await table.deleteRow(req.params.rowId);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
