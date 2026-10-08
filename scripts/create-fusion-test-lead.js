'use strict';

// Creates one clearly-marked test lead on Fusion AMS-Pro (QA).
// Credentials come only from the git-ignored root .env:
//   FUSION_BASE_URL (through /api/leadapi), FUSION_ACCESS_KEY, FUSION_SECRET_KEY
// Usage: node scripts/create-fusion-test-lead.js [sequence-number]

const fs = require('fs');
const path = require('path');
const axios = require('../functions/mg_motors_au_function/node_modules/axios');

function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
}

async function main() {
  loadEnv();
  const missing = ['FUSION_BASE_URL', 'FUSION_ACCESS_KEY', 'FUSION_SECRET_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);

  const base = process.env.FUSION_BASE_URL.replace(/\/+$/, '');
  const seq = String(process.argv[2] || Date.now().toString().slice(-4)).padStart(4, '0');

  const tokenRes = await axios.post(`${base}/oauth2/token`, 'grant_type=client_credentials', {
    auth: { username: process.env.FUSION_ACCESS_KEY, password: process.env.FUSION_SECRET_KEY },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  console.log(`Token OK (scope: ${tokenRes.data.scope}, expires_in: ${tokenRes.data.expires_in}s)`);

  // Minimal body mirroring the OpenAPI example (the dealer's field mapping
  // reads this shape; extra keys are not needed for a valid lead).
  const lead = {
    campaign: 'FI Digital Testing',
    notes: 'FI Digital testing - API integration test lead. Not a real customer. Please do not contact; safe to delete.',
    origin: 'Website',
    leadSource: 'FI Digital Testing',
    enquiryType: 'Internet',
    contact: {
      firstName: 'FI Digital',
      lastName: `Testing ${seq}`,
      phone: '0491570007',
      email: `fi.digital.testing${seq}@example.com`,
    },
    requirement: { make: 'MG', model: 'HS', year: '2026', saleType: 'new' },
    enquiryStatus: 'Open',
  };

  try {
    const res = await axios.post(`${base}/v1/leads`, lead, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    console.log(`Create lead -> HTTP ${res.status}`);
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(`Create lead failed -> HTTP ${err.response?.status || 'network error'}`);
    console.error(JSON.stringify(err.response?.data || err.message, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.response?.status || ''} ${err.message}`);
  process.exit(1);
});
