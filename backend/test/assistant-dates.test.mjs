import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantCalendar, resolveAssistantDates } from '../src/lib/assistant-context.mjs';
import { invokeFinanceTool } from '../src/lib/assistant-tools.mjs';
const range = (period, count = null, dates = {}) => ({ period, count, from: null, to: null, ...dates });
const clock = '2026-10-01T00:30:00Z';
const zone = 'America/Los_Angeles';

test('relative ranges establish configured local today before yesterday, Monday–Sunday last week, last month and rolling weeks', () => {
  assert.equal(assistantCalendar(clock, zone).today, '2026-09-30');
  for (const [input, from, to] of [
    [range('yesterday'), '2026-09-29', '2026-09-29'],
    [range('last_week'), '2026-09-21', '2026-09-27'],
    [range('last_month'), '2026-08-01', '2026-08-31'],
    [range('last_n_weeks', 3), '2026-09-10', '2026-09-30'],
    [range('previous_n_months', 3), '2026-06-01', '2026-08-31'],
    [range('last_n_days', 17), '2026-09-14', '2026-09-30']
  ]) {
    const actual = resolveAssistantDates(input, clock, zone);
    assert.equal(actual.from, from);
    assert.equal(actual.to, to);
    assert.equal(actual.today, '2026-09-30');
    assert.equal(actual.timeZone, zone);
  }

  assert.match(resolveAssistantDates(range('last_n_weeks', 3), clock, zone).semantics, /Rolling.*including today/);
  const positive = resolveAssistantDates(range('yesterday'), '2026-12-31T12:30:00Z', 'Pacific/Kiritimati');
  assert.equal(positive.today, '2027-01-01');
  assert.equal(positive.from, '2026-12-31');
  assert.equal(positive.utcFrom, '2026-12-30T10:00:00.000Z');
  assert.equal(positive.utcToExclusive, '2026-12-31T10:00:00.000Z');
});

test('date-only ledger filters stay local while UTC boundaries respect DST, leap days, month and year ends', () => {
  for (const [date, start, end, hours] of [
    ['2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z', 23],
    ['2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 25],
    ['2024-02-29', '2024-02-29T08:00:00.000Z', '2024-03-01T08:00:00.000Z', 24],
    ['2026-12-31', '2026-12-31T08:00:00.000Z', '2027-01-01T08:00:00.000Z', 24]
  ]) {
    const actual = resolveAssistantDates(range('custom', null, { from: date, to: date }), clock, zone);
    assert.equal(actual.from, date);
    assert.equal(actual.to, date);
    assert.equal(actual.utcFrom, start);
    assert.equal(actual.utcToExclusive, end);
    assert.equal((Date.parse(end) - Date.parse(start)) / 3600000, hours);
  }

  const lastWeek = resolveAssistantDates(range('last_week'), '2027-01-04T12:00:00Z', 'Europe/Amsterdam');
  assert.equal(lastWeek.from, '2026-12-28');
  assert.equal(lastWeek.to, '2027-01-03');
  assert.throws(
    () => resolveAssistantDates(range('custom', null, { from: '2026-02-30', to: '2026-03-01' }), clock, zone),
    /valid inclusive/
  );
  assert.throws(() => resolveAssistantDates(range('last_n_weeks', 100), clock, zone), /366/);
  assert.throws(() => resolveAssistantDates(range('yesterday', 2), clock, zone), /positive count only/);
});

test('date tool requires the authorized facade, returns reproducible absolute source ranges and accepts no identity/location overrides', async () => {
  let authorizations = 0;
  const options = {
    getFinance: async () => {
      authorizations++;
      return {};
    },
    now: () => clock,
    timeZone: zone
  };
  const result = await invokeFinanceTool('finance_dates', range('last_n_weeks', 3), options);
  assert.equal(authorizations, 1);
  assert.equal(result.data.today, '2026-09-30');
  assert.equal(result.data.days, 21);
  assert.equal(result.reportQuery.args.period, 'custom');
  assert.equal(result.reportQuery.args.from, '2026-09-10');
  await assert.rejects(
    invokeFinanceTool('finance_dates', { ...range('yesterday'), timeZone: 'UTC', userId: 'admin' }, options),
    /Invalid finance tool fields/
  );
});
