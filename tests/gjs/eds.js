// Run on a private session bus: no real calendar service or account is accessed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as EDS from '../../src/EDS.js';

const loop = new GLib.MainLoop(null, false);
const factoryXml = `<node><interface name="org.gnome.evolution.dataserver.CalendarFactory">
  <method name="OpenCalendar"><arg type="s" direction="in"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
</interface></node>`;
const backendXml = `<node><interface name="org.gnome.evolution.dataserver.Calendar">
  <property name="Writable" type="b" access="read"/>
  <method name="Open"><arg type="as" direction="out"/></method><method name="Close"/>
  <method name="GetObject"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="CreateObjects"><arg type="as" direction="in"/><arg type="u" direction="in"/><arg type="as" direction="out"/></method>
  <method name="ModifyObjects"><arg type="as" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/></method>
  <method name="RemoveObjects"><arg type="a(ss)" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/></method>
</interface></node>`;
const sourcesXml = `<node><interface name="org.freedesktop.DBus.ObjectManager">
  <method name="GetManagedObjects"><arg type="a{oa{sa{sv}}}" direction="out"/></method>
</interface></node>`;
let created = new Map(), serial = 0, opened = 0, closed = 0, fail = null;
const assert = (condition, message) => { if (!condition) throw Error(message); };
const unfold = text => text.replace(/\r\n[ \t]/g, '');
const uidOf = text => unfold(text).match(/^UID:(.+)\r?$/m)?.[1];
const error = (invocation, name) => invocation.return_dbus_error(`org.gnome.evolution.dataserver.Calendar.${name}`, name);

const backend = {
  get Writable() { return true; },
  Open() { opened++; return []; }, Close() { closed++; },
  GetObjectAsync([uid], invocation) {
    if (!created.has(uid)) { error(invocation, 'ObjectNotFound'); return; }
    invocation.return_value(new GLib.Variant('(s)', [created.get(uid)]));
  },
  CreateObjectsAsync([objects], invocation) {
    if (fail === 'create') { error(invocation, 'PermissionDenied'); return; }
    const uid = `backend-${++serial}`;
    created.set(uid, objects[0].replace(/^UID:[^\r\n]+/m, `UID:${uid}`));
    invocation.return_value(new GLib.Variant('(as)', [[uid]]));
  },
  ModifyObjectsAsync([objects, mod], invocation) {
    assert(mod === 'all', 'wrong modification type');
    if (fail === 'modify') { error(invocation, 'PermissionDenied'); return; }
    const uid = uidOf(objects[0]);
    if (!created.has(uid)) { error(invocation, 'ObjectNotFound'); return; }
    created.set(uid, objects[0]); invocation.return_value(new GLib.Variant('()', []));
  },
  RemoveObjectsAsync([ids, mod], invocation) {
    assert(mod === 'all', 'wrong removal type');
    if (fail === 'remove') { error(invocation, 'PermissionDenied'); return; }
    if (!created.has(ids[0][0])) { error(invocation, 'ObjectNotFound'); return; }
    created.delete(ids[0][0]); invocation.return_value(new GLib.Variant('()', []));
  }
};
const exports = [
  Gio.DBusExportedObject.wrapJSObject(factoryXml, { OpenCalendar(uid) { return [uid === 'readonly' ? '/ReadOnlyCalendar' : '/Calendar', 'org.gnome.evolution.dataserver.Calendar8']; } }),
  Gio.DBusExportedObject.wrapJSObject(backendXml, backend),
  Gio.DBusExportedObject.wrapJSObject(sourcesXml, { GetManagedObjects() {
    const result = {};
    for (const [uid, enabled, name, type] of [['local', true, 'محلی', 'local'], ['disabled', false, 'غیرفعال', 'caldav'], ['google', true, 'Google', 'caldav'], ['readonly', true, 'Read only', 'caldav'], ['birthday', true, 'Birthdays', 'contacts']]) {
      result[`/Sources/${uid}`] = { 'org.gnome.evolution.dataserver.Source': {
        UID: new GLib.Variant('s', uid), Data: new GLib.Variant('s', `[Data Source]\nDisplayName=${name}\nEnabled=${enabled}\n[Calendar]\nBackendName=${type}\n`)
      } };
    }
    return result;
  } })
];
exports.push(Gio.DBusExportedObject.wrapJSObject(backendXml, { ...backend, Writable: false }));
exports[0].export(Gio.DBus.session, '/org/gnome/evolution/dataserver/CalendarFactory');
exports[1].export(Gio.DBus.session, '/Calendar');
exports[2].export(Gio.DBus.session, '/org/gnome/evolution/dataserver/SourceManager');
exports[3].export(Gio.DBus.session, '/ReadOnlyCalendar');

async function rejected(operation, expectedNotFound = false) {
  let caught;
  try { await operation(); } catch (e) { caught = e; }
  assert(!!caught, 'expected rejection');
  assert(EDS.isNotFound(caught) === expectedNotFound, 'incorrect error classification');
}
async function run() {
  const calendars = await EDS.listCalendars();
  assert(calendars.length === 2 && calendars.some(c => c.uid === 'google'), 'source filtering failed');
  const args = { calUid: 'google', summary: 'جلسهٔ فارسی ' + 'آ'.repeat(100), gy: 2026, gm: 10, gd: 14,
    startMin: 540, endMin: 600, reminderMin: 30 };
  const { uid } = await EDS.createEvent(args);
  assert(uid === 'backend-1', 'backend UID was discarded');
  assert(await EDS.eventExists({ calUid: 'google', uid }), 'existing event not found');
  let ics = created.get(uid);
  assert(unfold(ics).includes('DTSTART:20261014T053000Z'), 'local time was not serialized in UTC');
  assert(ics.includes('TRIGGER:-PT30M'), 'reminder missing');
  for (const line of ics.split('\r\n')) assert(new TextEncoder().encode(line).length <= 75, 'UTF-8 folding failed');
  created.set(uid, ics.replace('END:VEVENT', 'DESCRIPTION:keep me\r\nLOCATION:keep location\r\nEND:VEVENT'));
  await EDS.modifyEvent({ ...args, uid, summary: 'edited', reminderMin: null });
  assert(created.size === 1 && unfold(created.get(uid)).includes('SUMMARY:edited'), 'modification replaced the UID');
  assert(created.get(uid).includes('DESCRIPTION:keep me') && created.get(uid).includes('LOCATION:keep location'), 'unrelated event data lost');
  assert(!created.get(uid).includes('VALARM'), 'reminder was not removed');
  fail = 'modify'; await rejected(() => EDS.modifyEvent({ ...args, uid })); assert(created.has(uid), 'failed modify lost event');
  fail = 'remove'; await rejected(() => EDS.removeEvent({ calUid: 'google', uid })); assert(created.has(uid), 'failed remove lost event');
  fail = null; await EDS.removeEvent({ calUid: 'google', uid }); assert(created.size === 0, 'event not removed');
  await rejected(() => EDS.removeEvent({ calUid: 'google', uid }), true);
  assert(!await EDS.eventExists({ calUid: 'google', uid }), 'deleted event still exists');
  fail = 'create'; await rejected(() => EDS.createEvent(args)); fail = null;
  const allDay = await EDS.createEvent({ ...args, startMin: null, endMin: null });
  assert(created.get(allDay.uid).includes('DTEND;VALUE=DATE:20261015'), 'all-day end must be exclusive');
  await EDS.removeEvent({ calUid: 'google', uid: allDay.uid });
  assert(opened === closed, `calendar handles leaked: ${opened}/${closed}`);
  const cancelled = new Gio.Cancellable(); cancelled.cancel();
  await rejected(() => EDS.createEvent(args, cancelled));
  print('PASS: GJS/D-Bus signatures, backend UID, UTC time, UTF-8 ICS, reminders, preservation, failures, cancellation and cleanup');
}
let ready = 0, failed = false;
const owners = ['org.gnome.evolution.dataserver.Calendar8', 'org.gnome.evolution.dataserver.Sources5'].map(name =>
  Gio.bus_own_name(Gio.BusType.SESSION, name, Gio.BusNameOwnerFlags.NONE, null, () => {
    if (++ready === 2) run().catch(e => { failed = true; printerr(e.stack); }).finally(() => loop.quit());
  }, null));
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => { failed = true; printerr('EDS test timed out'); loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
for (const owner of owners) Gio.bus_unown_name(owner);
for (const object of exports) object.unexport();
if (failed) throw Error('GJS EDS contract test failed');
