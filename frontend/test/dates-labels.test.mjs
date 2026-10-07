import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDay, formatStamp, setStampTimeZone } from '../src/lib/dates.mjs';
import { KIND_LABELS, kindLabel, stateLabel } from '../src/lib/labels.mjs';

test('stamps read in the household zone, fall back to Brisbane for an unknown zone and pass bad input through', () => {
  const stamp = '2026-10-03T06:54:00Z';
  setStampTimeZone('Australia/Brisbane');
  assert.equal(formatStamp(stamp), '3 Oct 2026, 04:54 pm');
  assert.equal(formatStamp(Date.parse(stamp)), '3 Oct 2026, 04:54 pm');
  setStampTimeZone('America/New_York');
  assert.equal(formatStamp(stamp), '3 Oct 2026, 02:54 am');
  setStampTimeZone('Europe/Vienna');
  assert.equal(formatStamp('2026-12-31T23:30:00Z'), '1 Jan 2027, 12:30 am', 'the zone moves the calendar day');
  setStampTimeZone('Not/AZone');
  assert.equal(formatStamp(stamp), '3 Oct 2026, 04:54 pm');
  setStampTimeZone('');
  const host = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  assert.equal(formatStamp(stamp), host.format(new Date(stamp)), 'no zone means the browser zone');
  assert.equal(formatStamp('not a date'), 'not a date');
  assert.equal(formatStamp(undefined), 'undefined');
});

test('calendar days never shift with the zone and only real days are formatted', () => {
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Brisbane']) {
    setStampTimeZone(zone);
    assert.equal(formatDay('2026-10-06'), '6 Oct 2026', zone);
  }

  assert.equal(formatDay('2024-02-29'), '29 Feb 2024');
  assert.equal(formatDay('2026-02-30'), '2026-02-30', 'no rollover to 2 March');
  assert.equal(formatDay('2026-13-01'), '2026-13-01');
  assert.equal(formatDay('2026-1-6'), '2026-1-6');
  assert.equal(formatDay('yesterday'), 'yesterday');
  assert.equal(formatDay(''), '');
});

test('stored enum values read as display names and unknown values pass through', () => {
  assert.deepEqual(Object.keys(KIND_LABELS), ['expense', 'income', 'transfer', 'refund', 'opening', 'adjustment']);
  assert.equal(kindLabel('opening'), 'Opening balance');
  assert.equal(kindLabel('adjustment'), 'Balance adjustment');
  assert.equal(kindLabel('future_kind'), 'future_kind');
  assert.equal(kindLabel(undefined), undefined);
  assert.equal(stateLabel('not_registered'), 'Not registered');
  assert.equal(stateLabel('awaiting_first_poll'), 'Awaiting first poll');
  assert.equal(stateLabel('ok'), 'Ok');
  assert.equal(stateLabel(404), '404');
  for (const empty of ['', null, undefined]) {
    assert.equal(stateLabel(empty), empty);
  }
});
