'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const aiTools = require('../services/aiAssistantToolService');

test('todayRange/yesterdayRange return a single-day range with correct offset', () => {
  const today = aiTools.todayRange();
  const yesterday = aiTools.yesterdayRange();

  assert.equal(today.fromDate, today.toDate);
  assert.equal(yesterday.fromDate, yesterday.toDate);
  assert.match(today.fromDate, /^\d{4}-\d{2}-\d{2}$/);

  const todayMs = new Date(`${today.fromDate}T00:00:00Z`).getTime();
  const yesterdayMs = new Date(`${yesterday.fromDate}T00:00:00Z`).getTime();
  assert.equal(todayMs - yesterdayMs, 24 * 60 * 60 * 1000);
});

test('thisWeekRange spans from the start of the week through today', () => {
  const range = aiTools.thisWeekRange();
  assert.ok(range.fromDate <= range.toDate);
  assert.match(range.fromDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('monthRange resolves a month name to its full calendar span', () => {
  const range = aiTools.monthRange('september', 2026);
  assert.deepEqual(range, { fromDate: '2026-09-01', toDate: '2026-09-30' });

  const feb = aiTools.monthRange('february', 2024); // leap year
  assert.deepEqual(feb, { fromDate: '2024-02-01', toDate: '2024-02-29' });
});

test('monthRange returns null for an unrecognized month name', () => {
  assert.equal(aiTools.monthRange('notamonth', 2026), null);
});

test('resolveWhen maps recognized phrases to date ranges', () => {
  assert.deepEqual(aiTools.resolveWhen('today'), aiTools.todayRange());
  assert.deepEqual(aiTools.resolveWhen('Yesterday'), aiTools.yesterdayRange());
  assert.deepEqual(aiTools.resolveWhen('this week'), aiTools.thisWeekRange());
  assert.deepEqual(aiTools.resolveWhen('give me September numbers'), aiTools.monthRange('september'));
});

test('resolveWhen returns null for unrecognized or empty phrases', () => {
  assert.equal(aiTools.resolveWhen(''), null);
  assert.equal(aiTools.resolveWhen('last quarter'), null);
});

test('resolveScenarioCode normalizes casing/spacing and validates against the real scenario register', () => {
  assert.deepEqual(aiTools.resolveScenarioCode('Unhappy 7'), { code: 'Unhappy 7', type: 'unhappy', message: 'Out-of-order events', priority: 'P3' });
  assert.deepEqual(aiTools.resolveScenarioCode('unhappy7'), aiTools.resolveScenarioCode('Unhappy 7'));
  assert.deepEqual(aiTools.resolveScenarioCode('UNHAPPY-7'), aiTools.resolveScenarioCode('Unhappy 7'));
  assert.deepEqual(aiTools.resolveScenarioCode('happy 3'), { code: 'Happy 3', type: 'happy', message: 'Duplicate detected', priority: '' });
});

test('resolveScenarioCode rejects codes outside the real 5 Happy / 12 Unhappy register', () => {
  assert.equal(aiTools.resolveScenarioCode('Happy 6'), null);
  assert.equal(aiTools.resolveScenarioCode('Unhappy 13'), null);
  assert.equal(aiTools.resolveScenarioCode('not a scenario'), null);
  assert.equal(aiTools.resolveScenarioCode(''), null);
});
