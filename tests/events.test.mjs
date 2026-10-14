import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, settle } from './helpers/shell.mjs';

test('calendar proxy initializes asynchronously, requests distant ranges once, disposes on destroy', async () => {
  const { calendar, Events } = environment(); const sync = new Events.GoogleCalendarSync();
  const since = new Date(2030, 0, 1).getTime() / 1000, until = new Date(2030, 1, 1).getTime() / 1000;
  sync.requestRange(since, until); assert.equal(sync._initialized, false); await settle();
  assert.equal(sync.state, 'ready'); assert.equal(sync._proxy.ranges[0][0], since);
  sync.requestRange(since, until); assert.equal(sync._proxy.ranges.length, 1);
  const proxy = sync._proxy; sync.destroy(); assert(proxy.disposed); assert(sync._cancellable.cancelled); calendar.destroy();
});

test('recurring updates replace old occurrences; prefix removal and source disappearance clear cache', async () => {
  const { calendar, Events } = environment(); const sync = new Events.GoogleCalendarSync(); await settle();
  let prefix = 'source\nuid\n';
  sync._proxy.signal('EventsAddedOrUpdated', [[[prefix + 'old', 'old', 1, 2, {}]]]);
  sync._proxy.signal('EventsAddedOrUpdated', [[[prefix + 'new', 'new', 3, 4, {}]]]);
  assert.equal(sync._events.size, 1); assert(sync._events.has(prefix + 'new'));
  sync._proxy.signal('EventsRemoved', [[prefix]]); assert.equal(sync._events.size, 0);
  sync._proxy.signal('EventsAddedOrUpdated', [[[prefix, 'one', 1, 2, {}]]]);
  sync._proxy.signal('ClientDisappeared', ['source']); assert.equal(sync._events.size, 0);
  sync.destroy(); calendar.destroy();
});

test('day index includes zero-duration midnight and multi-day events, excludes exclusive midnight end', async () => {
  const { calendar, Events } = environment(); const sync = new Events.GoogleCalendarSync(); await settle();
  let start = new Date(2026, 9, 14).getTime() / 1000, next = new Date(2026, 9, 15).getTime() / 1000;
  sync.requestRange(start, new Date(2026, 9, 17).getTime() / 1000); await settle();
  sync._proxy.signal('EventsAddedOrUpdated', [[
    ['s\nzero\n', 'zero', start, start, {}], ['s\none\n', 'one', start, next, {}],
    ['s\nlong\n', 'long', start - 86400, next + 86400, {}]
  ]]);
  assert.equal(sync.getEventsForDate(2026, 10, 14).length, 3);
  assert.equal(sync.getEventsForDate(2026, 10, 15).length, 1);
  let index = sync._eventsByDay; sync.getEventsForDate(2026, 10, 14); assert.equal(sync._eventsByDay, index);
  sync.destroy(); calendar.destroy();
});

test('all-day event spanning a DST transition stays all-day and occupies the correct civil days', async () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const { calendar, Events, settings } = environment(); const sync = new Events.GoogleCalendarSync();
  try {
    await settle();
    const start = new Date(2026, 2, 8).getTime() / 1000, end = new Date(2026, 2, 9).getTime() / 1000;
    assert.equal(end - start, 23 * 3600);
    sync.requestRange(start, end); await settle();
    sync._proxy.signal('EventsAddedOrUpdated', [[['s\ndst\n', 'DST', start, end, {}]]]);
    calendar._selectedDateObj.gregorian = [2026, 3, 8];
    let events = new Events.Events(calendar._selectedDateObj, settings, sync).getEvents()[0];
    assert(events.find(e => e.type === 'google').event.includes('DST'));
    assert(!events.find(e => e.type === 'google').event.includes('00:00'));
    assert.equal(sync.getEventsForDate(2026, 3, 9).length, 0);
  } finally {
    sync.destroy(); calendar.destroy();
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
