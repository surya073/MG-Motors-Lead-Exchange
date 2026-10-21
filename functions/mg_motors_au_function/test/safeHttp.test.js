'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const https = require('https');
const axios = require('axios');
const { assertSafeUrl, safeRequestOptions } = require('../services/integrations/adapters/safeHttp');

test('HTTP safety rejects local IPv4 and alternate private IPv6 address forms', async () => {
  for (const host of [
    '0.0.0.0', '127.0.0.1', '10.1.2.3', '172.31.2.3', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]',
    '[fc12::1]', '[fd00::1]', '[fe90::1]', '[febf::1]', '[ff02::1]',
    '[2001:db8::1]', '[2001::1]', '[2002:7f00:1::1]',
  ]) {
    await assert.rejects(() => assertSafeUrl(`https://${host}/token`), {
      code: 'INVALID_CRM_CONFIGURATION',
    }, host);
  }
  for (const address of ['8.8.8.8', '[2606:4700:4700::1111]']) {
    assert.ok(await assertSafeUrl(`https://${address}/token`));
  }
});

test('HTTP safety rejects HTTP and credentials embedded in URLs before DNS', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => { throw new Error('must not resolve'); });
  for (const url of ['http://dealer.example/api', 'https://user:pass@dealer.example/api']) {
    await assert.rejects(() => assertSafeUrl(url), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('HTTP safety rejects a hostname with any private DNS answer', async (t) => {
  t.mock.method(dns, 'lookup', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '::ffff:192.168.1.1', family: 6 },
  ]);
  await assert.rejects(() => assertSafeUrl('https://dealer.example/api'), {
    code: 'INVALID_CRM_CONFIGURATION',
  });
});

test('the HTTPS connection pins the exact validated DNS answers across DNS rebinding', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  const url = await assertSafeUrl('https://dealer.example/api');
  // Any second DNS resolution would now resolve inside the network.
  lookup.mock.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }]);
  const config = safeRequestOptions(url);
  const connectLookup = config.lookup;
  const all = await new Promise((resolve, reject) => {
    connectLookup('dealer.example', { all: true }, (err, addresses) => err ? reject(err) : resolve(addresses));
  });
  assert.deepEqual(all, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  const ipv6 = await new Promise((resolve, reject) => {
    connectLookup('dealer.example', { family: 6 }, (err, address, family) => err ? reject(err) : resolve({ address, family }));
  });
  assert.deepEqual(ipv6, { address: '2606:4700:4700::1111', family: 6 });
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(config.maxRedirects, 0, 'a redirect must not bypass host checks');
  assert.equal(config.proxy, false, 'an environment proxy must not bypass pinned DNS');
});

test('pinned connection refuses a host change and requires a validated URL', async () => {
  assert.throws(() => safeRequestOptions(new URL('https://8.8.8.8/')), {
    code: 'INVALID_CRM_CONFIGURATION',
  });
  const options = safeRequestOptions(await assertSafeUrl('https://8.8.8.8/'));
  await assert.rejects(() => new Promise((resolve, reject) => {
    options.lookup('169.254.169.254', {}, (err, address) => err ? reject(err) : resolve(address));
  }), { code: 'INVALID_CRM_CONFIGURATION' });
});

test('unresolvable dealer hosts remain retryable outages', async (t) => {
  t.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); });
  await assert.rejects(() => assertSafeUrl('https://dealer.example/api'), { code: 'DEALER_HOST_UNREACHABLE' });
});

test('validated URL objects cannot change origin, including an IP literal that bypasses DNS', async () => {
  for (const mutation of [
    (url) => { url.hostname = '127.0.0.1'; },
    (url) => { url.port = '8443'; },
    (url) => { url.protocol = 'http:'; },
    (url) => { url.username = 'user'; },
  ]) {
    const url = await assertSafeUrl('https://8.8.8.8/');
    mutation(url);
    assert.throws(() => safeRequestOptions(url), { code: 'INVALID_CRM_CONFIGURATION' });
  }
});

test('actual Axios HTTP adapter passes the pinned lookup and agent to HTTPS despite fetch defaults', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const previousAdapter = axios.defaults.adapter;
  const previousBaseUrl = axios.defaults.baseURL;
  const previousAllowAbsolute = axios.defaults.allowAbsoluteUrls;
  axios.defaults.adapter = 'fetch';
  axios.defaults.baseURL = 'https://127.0.0.1/';
  axios.defaults.allowAbsoluteUrls = false;
  t.after(() => {
    axios.defaults.adapter = previousAdapter;
    axios.defaults.baseURL = previousBaseUrl;
    axios.defaults.allowAbsoluteUrls = previousAllowAbsolute;
  });
  let connected;
  t.mock.method(https, 'request', (options) => {
    connected = options;
    throw new Error('synthetic transport stop');
  });
  const url = await assertSafeUrl('https://dealer.example/api');
  const config = safeRequestOptions(url);
  await assert.rejects(() => axios.request({ url: url.toString(), ...config }), /synthetic transport stop/);
  assert.equal(connected.hostname, 'dealer.example');
  // Axios wraps the lookup callback; verify its result rather than function
  // identity, and make any accidental second DNS lookup return a private IP.
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  const addresses = await new Promise((resolve, reject) => {
    connected.lookup('dealer.example', { all: true }, (err, result) => err ? reject(err) : resolve(result));
  });
  assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(connected.agent, config.httpsAgent);
  assert.equal(config.httpsAgent.options.keepAlive, true);
  const next = safeRequestOptions(await assertSafeUrl('https://8.8.8.8/other'));
  assert.equal(next.httpsAgent, config.httpsAgent, 'reuse connections without a new agent per request');
});
