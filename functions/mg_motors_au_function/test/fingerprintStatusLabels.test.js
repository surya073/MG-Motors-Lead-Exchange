'use strict';

// 28 Oct 2026: a Fusion Lost was written to MG as Lost Lead; MG's own
// notification then brought back the label "Lost", the echo guard saw a
// change, and the lead was pushed straight back to Fusion.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeFingerprint, computeProjectedInboundFingerprint } = require('../services/integrations/leadFingerprintService');

const MAPPINGS = [{ source_field: 'email_address', target_field: 'contact.email' }];
const LEAD = { lead_status: 'Not Contacted', email_address: 'jane@example.com' };

test('MG label "Lost" and stored value "Lost Lead" give the same fingerprint (the echo is recognised)', () => {
  const projected = computeProjectedInboundFingerprint(LEAD, { lead_status: 'Lost Lead' }, MAPPINGS);
  assert.equal(computeFingerprint({ ...LEAD, lead_status: 'Lost' }, MAPPINGS), projected);
});

test('MG label "Dropped" and stored value "Junk Lead" give the same fingerprint', () => {
  assert.equal(
    computeFingerprint({ ...LEAD, lead_status: 'Dropped' }, MAPPINGS),
    computeFingerprint({ ...LEAD, lead_status: 'Junk Lead' }, MAPPINGS)
  );
});

test('a real status change still changes the fingerprint', () => {
  assert.notEqual(
    computeFingerprint({ ...LEAD, lead_status: 'Lost' }, MAPPINGS),
    computeFingerprint({ ...LEAD, lead_status: 'Not Qualified' }, MAPPINGS)
  );
  assert.notEqual(
    computeFingerprint({ ...LEAD, lead_status: 'Lost Lead' }, MAPPINGS),
    computeFingerprint({ ...LEAD, lead_status: 'Junk Lead' }, MAPPINGS)
  );
});
