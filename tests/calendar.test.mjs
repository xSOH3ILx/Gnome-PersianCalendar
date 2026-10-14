import test from 'node:test';
import assert from 'node:assert/strict';
import * as Tarikh from '../src/Tarikh.js';
import { Str } from '../src/otherFunctions.js';
import { environment, Settings, Actor, St, Clutter, descendants, settle } from './helpers/shell.mjs';

const record = { uid: 'original', calUid: 'system-calendar', title: 'جلسه', gy: 2026, gm: 10, gd: 14,
  startMin: 540, endMin: 600, reminderMin: 10 };

test('failed modification preserves original event; successful edit preserves UID', async () => {
  let deletes = 0;
  const { calendar: c, EDS, status } = environment({
    removeEvent: async () => { deletes++; }, modifyEvent: async () => { throw Error('offline'); }
  });
  c._setPersonalEvents([record]); c._beginEventForm(record);
  await c._savePersonalEvent('edited', '۹:۰۰', '۱۰:۰۰');
  assert.equal(deletes, 0); assert.equal(c._getPersonalEvents()[0].title, record.title);
  assert(status.at(-1).includes('ذخیره انجام نشد'));
  EDS.modifyEvent = async args => ({ uid: args.uid });
  await c._savePersonalEvent('edited', '۹:۰۰', '۱۰:۰۰');
  assert.equal(c._getPersonalEvents()[0].uid, record.uid);
  assert.equal(c._getPersonalEvents()[0].title, 'edited');
  c.destroy();
});

test('failed delete keeps local controls; only ObjectNotFound removes stale record', async () => {
  const { calendar: c, EDS, status } = environment({ removeEvent: async () => { throw Error('permission denied'); } });
  c._setPersonalEvents([record]); await c._deletePersonalEvent(record);
  assert.equal(c._getPersonalEvents().length, 1); assert(status.at(-1).includes('حذف انجام نشد'));
  EDS.removeEvent = async () => { throw { code: 'not-found' }; };
  await c._deletePersonalEvent(record); assert.equal(c._getPersonalEvents().length, 0); c.destroy();
});

test('move failure rolls back destination, preserves source; failed rollback keeps both manageable', async () => {
  let calls = [];
  const { calendar: c, EDS } = environment({
    createEvent: async () => { calls.push('create'); return { uid: 'destination' }; },
    removeEvent: async args => { calls.push(args.uid); if (args.uid === record.uid) throw Error('offline'); }
  });
  c._setPersonalEvents([record]); c._beginEventForm(record); c._draft.calUid = 'google';
  await c._savePersonalEvent('moved', '9', '10');
  assert.deepEqual(calls, ['create', 'original', 'destination']); assert.equal(c._getPersonalEvents().length, 1);
  EDS.removeEvent = async () => { throw Error('offline'); };
  await c._savePersonalEvent('moved', '9', '10'); assert.equal(c._getPersonalEvents().length, 2); c.destroy();
});

test('ambiguous source removal never deletes the last known destination copy', async () => {
  const calls = [];
  const { calendar: c } = environment({
    createEvent: async () => ({ uid: 'destination' }),
    removeEvent: async args => { calls.push(args.uid); throw Error('timeout'); },
    eventExists: async () => { throw Error('offline'); }
  });
  c._setPersonalEvents([record]); c._beginEventForm(record); c._draft.calUid = 'google';
  await c._savePersonalEvent('moved', '9', '10');
  assert.deepEqual(calls, ['original']); assert.equal(c._getPersonalEvents().length, 2); c.destroy();
});

test('double save makes one request; completion after destroy does not access UI', async () => {
  let finish, calls = 0;
  const { calendar: c, status } = environment({ createEvent: () => { calls++; return new Promise(r => { finish = r; }); } });
  const first = c._savePersonalEvent('one', '', '');
  await c._savePersonalEvent('one', '', ''); assert.equal(calls, 1);
  c.destroy(); const length = status.length; finish({ uid: 'saved' }); await first;
  assert.equal(status.length, length); assert.equal(c._getPersonalEvents()[0].uid, 'saved');
});

test('draft text, reminder and target date survive navigation; asynchronous list preserves source calendar', async () => {
  let finish;
  const { calendar: c } = environment({ listCalendars: () => new Promise(r => { finish = r; }) });
  const google = { ...record, calUid: 'google' }; c._beginEventForm(google);
  descendants(c.actor).find(a => a.hint_text === 'عنوان رویداد').set_text('پیش‌نویس');
  c._reminderIndex = 4; c._onNextMonthButtonClicked();
  assert.equal(descendants(c.actor).find(a => a.hint_text === 'عنوان رویداد').get_text(), 'پیش‌نویس');
  assert.equal(c._reminderIndex, 4); assert.equal(c._draft.gd, record.gd);
  finish([{ uid: 'system-calendar', name: 'Local' }, { uid: 'google', name: 'Google' }]); await settle();
  assert.equal(c._edsCalendars[c._edsCalIndex].uid, 'google'); c.destroy();
});

test('background refresh does not replace a focused draft while typing', async () => {
  const { calendar: c } = environment(); c._visible = true; c._beginEventForm();
  const entry = descendants(c.actorLeft).find(a => a.hint_text === 'عنوان رویداد');
  entry.set_text('پیش‌نویس'); c.queueRefresh(); await settle();
  assert.equal(descendants(c.actorLeft).find(a => a.hint_text === 'عنوان رویداد'), entry); c.destroy();
});

test('same month retains grid actors and selection; every Persian detail is RTL', () => {
  const { calendar: c } = environment(); c._selectedDateObj.persian = [1405, 7, 10]; c._update();
  const buttons = [...c._gridDays.values()].map(x => x.button); Actor.created = 0;
  c._selectedDateObj.julianDay++; c._update();
  assert.deepEqual([...c._gridDays.values()].map(x => x.button), buttons); assert(Actor.created < 80);
  assert.equal(c._gridDays.get(c._selectedDateObj.julianDay).button.classes.has('selected'), true);
  for (const label of descendants(c.actorLeft).filter(a => a instanceof St.Label)) {
    assert.equal(label.direction, Clutter.TextDirection.RTL); assert.equal(label.alignment, 2);
  }
  assert(buttons.every(b => b.can_focus)); c.destroy();
});

test('Persian week begins at the right regardless of system locale', () => {
  const { calendar: c, settings } = environment();
  assert.equal(c._colPosition(settings), 6);
  settings.set_boolean('reverse-direction', true); assert.equal(c._colPosition(settings), 0);
  c.destroy();
});

test('converter rejects invalid dates and malformed strings, accepts Arabic/Persian digits and retains input', () => {
  const { calendar: c } = environment(); c._selectedTab = 'dateConvert'; c._update();
  const fill = (year, month, day) => {
    let entries = descendants(c.actorLeft).filter(a => a instanceof St.Entry);
    for (let [i, value] of [year, month, day].entries()) entries[i].set_text(value);
  };
  fill('۱۴۰۴', '۱۲', '۳۰'); assert(descendants(c.actorLeft).some(a => a.text?.includes('تاریخ معتبر نیست')));
  fill('1404abc', '1', '1'); assert(descendants(c.actorLeft).some(a => a.text?.includes('تاریخ معتبر نیست')));
  fill('١٤٠٥', '٧', '٢٢'); assert(descendants(c.actorLeft).some(a => a.style_class === 'shcalendar-convert-label'));
  c._onNextMonthButtonClicked();
  assert.deepEqual(descendants(c.actorLeft).filter(a => a instanceof St.Entry).map(a => a.get_text()), ['١٤٠٥', '٧', '٢٢']);
  assert.equal(descendants(c.actorLeft).filter(a => a.style_class === 'shcalendar-convert-label').length, 3);
  c.destroy();
});

test('mobile Persian events agree with per-day lookup across the year boundary', () => {
  const { calendar: c, Events, settings } = environment({}, new Settings({ 'show-old-events': true }));
  for (let year = 1400; year <= 1410; year++) {
    c._selectedDateObj.persian = [year, 1, 1]; c._update();
    for (const [jd, cell] of c._gridDays) {
      const day = new Tarikh.TarikhObject(); day.julianDay = jd;
      assert.equal(JSON.stringify(cell.events), JSON.stringify(new Events.Events(day, settings).getEvents()));
    }
  }
  c.destroy();
});

test('external deletion/revision reconciles by source and UID, never hides an unrelated same-title event', () => {
  const { calendar: c } = environment(); c._setPersonalEvents([record, { ...record, calUid: 'other' }]);
  c._reconcilePersonalEvents({ removed: [`system-calendar\n${record.uid}\n`] });
  assert.equal(c._getPersonalEvents().length, 1); assert.equal(c._getPersonalEvents()[0].calUid, 'other');
  let start = new Date(2026, 9, 16, 12).getTime() / 1000;
  c._reconcilePersonalEvents({ updated: [{ id: `other\n${record.uid}\n`, summary: 'جدید', startTime: start, endTime: start + 3600 }] });
  assert.equal(c._getPersonalEvents()[0].title, 'جدید'); assert.equal(c._getPersonalEvents()[0].gd, 16); c.destroy();
});

test('digits and bidi isolation preserve mixed Persian and Latin text', () => {
  assert.equal(Str.parseInteger('١٤۰۵'), 1405); assert(Number.isNaN(Str.parseInteger('1405x')));
  assert.equal(Str.bidiIsolate("رضا's meeting"), "\u2068رضا's meeting\u2069");
  assert.equal(Str.bidiIsolate('09:30', 'ltr'), '\u206609:30\u2069');
});

test('opening a day removes only remotely confirmed missing records, preserves records on lookup failure', async () => {
  const { calendar: c, EDS } = environment({ eventExists: async () => { throw Error('offline'); } });
  c._setPersonalEvents([record]); c._visible = true; c._verifyPersonalEvents([record]); await settle();
  assert.equal(c._getPersonalEvents().length, 1);
  EDS.eventExists = async () => false; c._verifyPersonalEvents([record]); await settle();
  assert.equal(c._getPersonalEvents().length, 0); c.destroy();
});
