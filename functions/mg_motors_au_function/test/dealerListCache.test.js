'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../services/dealerListCache');

test.beforeEach(() => {
  delete process.env.DEALER_LIST_CACHE_SECONDS;
  cache.clear();
});

test('a second call within 60 seconds reuses the first answer', async () => {
  let loads = 0;
  const load = async () => { loads += 1; return [{ dealer_code: 'A' }]; };
  const a = await cache.getOrLoad(load);
  const b = await cache.getOrLoad(load);
  assert.equal(loads, 1);
  assert.deepEqual(a, b);
});

test('the answer is reloaded once it is older than the cache time', async () => {
  let loads = 0;
  const load = async () => { loads += 1; return loads; };
  await cache.getOrLoad(load, Date.now());
  assert.equal(await cache.getOrLoad(load, Date.now() + 61000), 2);
});

test('clear() forces the next call to reload', async () => {
  let loads = 0;
  const load = async () => { loads += 1; return loads; };
  await cache.getOrLoad(load);
  cache.clear();
  assert.equal(await cache.getOrLoad(load), 2);
});

test('DEALER_LIST_CACHE_SECONDS=0 turns the cache off', async () => {
  process.env.DEALER_LIST_CACHE_SECONDS = '0';
  let loads = 0;
  const load = async () => { loads += 1; return loads; };
  await cache.getOrLoad(load);
  await cache.getOrLoad(load);
  assert.equal(loads, 2);
});

test('calls that arrive while a load runs share it', async () => {
  let loads = 0;
  const load = async () => { loads += 1; await new Promise((r) => setTimeout(r, 20)); return 'x'; };
  const [a, b] = await Promise.all([cache.getOrLoad(load), cache.getOrLoad(load)]);
  assert.equal(loads, 1);
  assert.equal(a, b);
});

test('a failed load is not cached', async () => {
  let loads = 0;
  const load = async () => { loads += 1; if (loads === 1) throw new Error('boom'); return 'ok'; };
  await assert.rejects(cache.getOrLoad(load));
  assert.equal(await cache.getOrLoad(load), 'ok');
});
