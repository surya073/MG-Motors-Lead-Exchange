'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const validatedAddresses = new WeakMap();
// Reuse TLS connections to a validated origin. Each new connection uses the
// request's pinned lookup; reused sockets already connect to a public IP.
const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 16 });

function configurationError(message) {
  const err = new Error(message);
  err.code = 'INVALID_CRM_CONFIGURATION';
  return err;
}

function isPrivateIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (family === 6) {
    const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const parts = canonical.split(':');
    const first = parseInt(parts[0] || '0', 16);
    const second = parseInt(parts[1] || '0', 16);
    // Only native global unicast. Also refuse documentation/special-use
    // and transition ranges that can tunnel to an embedded private IPv4.
    return first < 0x2000 || first > 0x3fff || first === 0x2002 ||
      (first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
  }
  return true;
}

function hostnameOf(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/** Validate before reading credentials, and bind the resulting public DNS
 * answers to the HTTP connection so a second lookup cannot rebind the host. */
async function assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw configurationError('Invalid URL'); }
  if (parsed.protocol !== 'https:') throw configurationError('Only HTTPS endpoints are allowed');
  if (parsed.username || parsed.password) throw configurationError('URL credentials are not allowed');

  const hostname = hostnameOf(parsed);
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
    throw configurationError('URL resolves to a disallowed host');
  }
  let addresses;
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try { addresses = await dns.lookup(hostname, { all: true }); } catch {
      const err = new Error(`Could not resolve dealer CRM host ${hostname}`);
      err.code = 'DEALER_HOST_UNREACHABLE';
      throw err;
    }
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw configurationError('URL resolves to a private/internal address');
  }
  validatedAddresses.set(parsed, {
    origin: parsed.origin,
    hostname,
    addresses: addresses.map(({ address }) => ({ address, family: net.isIP(address) })),
  });
  return parsed;
}

function safeRequestOptions(url) {
  const validated = validatedAddresses.get(url);
  if (!validated || url.origin !== validated.origin || url.username || url.password) {
    throw configurationError('URL must be validated before sending a request');
  }
  const lookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (String(hostname).toLowerCase().replace(/^\[|\]$/g, '') !== validated.hostname) {
      callback(configurationError('HTTP request host differs from validated host'));
      return;
    }
    const family = typeof options === 'number' ? options : options?.family;
    const matches = validated.addresses.filter((entry) => !family || entry.family === family);
    if (!matches.length) {
      const err = new Error('No validated address for the requested IP family');
      err.code = 'ENOTFOUND';
      callback(err);
    } else if (options?.all) {
      callback(null, matches.map((entry) => ({ ...entry })));
    } else {
      callback(null, matches[0].address, matches[0].family);
    }
  };
  return {
    url: url.toString(),
    allowAbsoluteUrls: true,
    // Fetch ignores Node agents/lookup. Force the adapter that honors them,
    // even if Axios defaults are changed elsewhere in the application.
    adapter: 'http',
    httpsAgent,
    lookup,
    transport: https,
    maxRedirects: 0,
    proxy: false,
  };
}

module.exports = { assertSafeUrl, safeRequestOptions, _test: { isPrivateIp } };
