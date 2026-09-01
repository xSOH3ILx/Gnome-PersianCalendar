import test from 'node:test';
import assert from 'node:assert/strict';
import * as Tarikh from '../src/Tarikh.js';

function toArray(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object' && 'year' in res) return [res.year, res.month, res.day];
  throw new Error('Unexpected date shape: ' + JSON.stringify(res));
}

// Fliegel-Van Flandern: Gregorian calendar date -> Julian Day Number
function g2jd(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

test('persian round-trip over JD 2440000..2470000', () => {
  for (let jd = 2440000; jd <= 2470000; jd += 1) {
    const jdf = Tarikh.julianDay_to_julianDayFloat(jd);
    const [y, m, d] = toArray(Tarikh.julianDayFloat_to_persian(jdf));
    const jd2 = Tarikh.julianDayFloat_to_julianDay(Tarikh.persian_to_julianDayFloat(y, m, d));
    assert.equal(jd2, jd, `persian mismatch at JD ${jd}: ${y}-${m}-${d}`);
  }
});

test('islamic (hilal range) round-trip over JD 2453767..2467232', () => {
  for (let jd = 2453767; jd <= 2467232; jd += 1) {
    const jdf = Tarikh.julianDay_to_julianDayFloat(jd);
    const [y, m, d] = toArray(Tarikh.julianDayFloat_to_islamic(jdf));
    const jd2 = Tarikh.julianDayFloat_to_julianDay(Tarikh.islamic_to_julianDayFloat(y, m, d));
    assert.equal(jd2, jd, `islamic mismatch at JD ${jd}: ${y}-${m}-${d}`);
  }
});

test('known date: 2026-09-01 == 1405-06-10 (Shahrivar 10)', () => {
  const jd = g2jd(2026, 9, 1);
  const jdf = Tarikh.julianDay_to_julianDayFloat(jd);
  assert.deepEqual(toArray(Tarikh.julianDayFloat_to_persian(jdf)), [1405, 6, 10]);
  assert.deepEqual(toArray(Tarikh.julianDayFloat_to_islamic(jdf)), [1448, 3, 19]);
});

test('check_persian validates real and invalid dates', () => {
  assert.equal(Tarikh.check_persian(1405, 6, 10), true);
  assert.equal(Tarikh.check_persian(1403, 12, 30), true);
  assert.equal(Tarikh.check_persian(1404, 12, 30), false);
  assert.equal(Tarikh.check_persian(1405, 13, 1), false);
});

test('daysOfMonth_persian: Esfand length depends on leap year', () => {
  assert.equal(Tarikh.daysOfMonth_persian(1403, 12), 30);
  assert.equal(Tarikh.daysOfMonth_persian(1404, 12), 29);
  assert.equal(Tarikh.daysOfMonth_persian(1405, 1), 31);
});
