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

test('strict validators reject overflow, fractional values and numeric strings', () => {
  assert.equal(Tarikh.check_gregorian(2025, 2, 29, true), false);
  assert.equal(Tarikh.check_islamic(1448, 2, 30, true), false);
  for (let check of [Tarikh.check_persian, Tarikh.check_gregorian, Tarikh.check_islamic]) {
    assert.equal(check(1405, 1, 1.5, true), false);
    assert.equal(check('1405', 1, 1, true), false);
  }
});

test('local timestamps, midnight and date setters agree in Tehran, UTC and New York', () => {
  const previousTimezone = process.env.TZ;
  const T = Tarikh;
  const verify = () => {
    let stamp = new Date(2026,9,14,0,30,0,123).getTime();
    assert.deepEqual(T.timeStamp_to_gregorian(stamp), [2026,10,14]);
    assert.deepEqual(T.timeStamp_to_persian(stamp), T.timeStamp_to_all(stamp).persian);
    assert.deepEqual(T.timeStamp_to_islamic(stamp), T.timeStamp_to_all(stamp).islamic);
    let o = new T.TarikhObject(stamp); o.julianDay = T.gregorian_to_julianDay(2026,10,14);
    assert.deepEqual(T.timeStamp_to_gregorian(o.timeStamp), o.gregorian);
    o.time=[0,0,0,0]; assert.equal(new Date(o.timeStamp).getHours(),0);
    o.gregorian=[2026,10,15]; assert.deepEqual(o.time,[0,0,0,0]);
    assert.deepEqual(T.timeStamp_to_gregorian(o.timeStamp),o.gregorian);
    assert.equal(new Date(T.julianDay_to_timeStamp(o.julianDay,[0,0,0,0])).getHours(),0);
  };
  try {
    for (const timezone of ['Asia/Tehran', 'UTC', 'America/New_York']) {
      process.env.TZ = timezone;
      verify();
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
