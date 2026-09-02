// EDS.js - Minimal Evolution Data Server (EDS) writer over D-Bus.
//
// Events created here are stored in EDS, the same storage GNOME Calendar
// uses. Calendars backed by GNOME Online Accounts (e.g. Google) are synced
// upstream automatically by EDS itself, so no extra Google API work is needed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SOURCES_BUS = 'org.gnome.evolution.dataserver.Sources5';
const SOURCES_PATH = '/org/gnome/evolution/dataserver/SourceManager';
const CAL_BUS = 'org.gnome.evolution.dataserver.Calendar8';
const CAL_FACTORY_PATH = '/org/gnome/evolution/dataserver/CalendarFactory';
const CAL_IFACE = 'org.gnome.evolution.dataserver.Calendar';

// Backends that cannot store user events
const READONLY_BACKENDS = ['contacts', 'weather', 'webcal', 'holiday'];

function dbusCall(busName, objectPath, ifaceName, method, params, replyType) {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(
      busName, objectPath, ifaceName, method,
      params, replyType ? new GLib.VariantType(replyType) : null,
      Gio.DBusCallFlags.NONE, 30000, null,
      (conn, res) => {
        try {
          resolve(conn.call_finish(res));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/**
 * List writable calendar sources known to EDS.
 * @returns {Promise<Array<{uid: string, name: string, backend: string}>>}
 */
export async function listCalendars() {
  let reply = await dbusCall(
    SOURCES_BUS, SOURCES_PATH,
    'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
    null, '(a{oa{sa{sv}}})'
  );
  let objects = reply.recursiveUnpack()[0];
  let calendars = [];

  for (let path in objects) {
    let source = objects[path]['org.gnome.evolution.dataserver.Source'];
    if (!source || !source.Data || !source.UID) continue;
    try {
      let kf = new GLib.KeyFile();
      kf.load_from_bytes(new GLib.Bytes(new TextEncoder().encode(source.Data)), GLib.KeyFileFlags.NONE);
      if (!kf.has_group('Calendar')) continue;

      let enabled = true;
      try { enabled = kf.get_boolean('Calendar', 'Enabled'); } catch (e) { }
      if (!enabled) continue;

      let backend = '';
      try { backend = kf.get_string('Calendar', 'BackendName'); } catch (e) { }
      if (READONLY_BACKENDS.includes(backend)) continue;

      let name = source.UID;
      try { name = kf.get_string('Data Source', 'DisplayName'); } catch (e) { }

      calendars.push({ uid: source.UID, name, backend });
    } catch (e) {
      // ignore malformed sources
    }
  }

  // Local "Personal" calendar first, then alphabetical
  calendars.sort((a, b) => {
    if (a.uid === 'system-calendar') return -1;
    if (b.uid === 'system-calendar') return 1;
    return a.name.localeCompare(b.name);
  });
  return calendars;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function escapeIcsText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function buildVevent({ uid, summary, gy, gm, gd, startMin, endMin, reminderMin }) {
  let now = new Date();
  let dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  let date = `${gy}${pad(gm)}${pad(gd)}`;

  let dtLines;
  if (startMin === null) {
    // All-day event: DTEND is exclusive, so it points to the next day
    let next = new Date(Date.UTC(gy, gm - 1, gd));
    next.setUTCDate(next.getUTCDate() + 1);
    let nextStr = `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
    dtLines = [
      `DTSTART;VALUE=DATE:${date}`,
      `DTEND;VALUE=DATE:${nextStr}`
    ];
  } else {
    // Floating local time: EDS interprets it in the user's timezone
    let st = `${date}T${pad(Math.floor(startMin / 60))}${pad(startMin % 60)}00`;
    let en = `${date}T${pad(Math.floor(endMin / 60))}${pad(endMin % 60)}00`;
    dtLines = [`DTSTART:${st}`, `DTEND:${en}`];
  }

  let lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    ...dtLines,
    `SUMMARY:${escapeIcsText(summary)}`
  ];

  if (reminderMin !== null && reminderMin !== undefined) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(summary)}`,
      `TRIGGER:-PT${reminderMin}M`,
      'END:VALARM'
    );
  }

  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

async function openCalendar(calUid) {
  let opened = await dbusCall(
    CAL_BUS, CAL_FACTORY_PATH,
    'org.gnome.evolution.dataserver.CalendarFactory', 'OpenCalendar',
    new GLib.Variant('(s)', [calUid]), '(os)'
  );
  let [objPath, busName] = opened.deep_unpack();
  if (!busName) busName = CAL_BUS;

  // Some EDS versions require an explicit Open; ignore if unsupported
  try {
    await dbusCall(busName, objPath, CAL_IFACE, 'Open', null, null);
  } catch (e) {
    // auto-opened on newer EDS; continue
  }
  return [busName, objPath];
}

/**
 * Create a calendar event in EDS.
 * @param {object} args
 * @param {string} args.calUid  - EDS source UID (e.g. 'system-calendar')
 * @param {string} args.summary - Event title
 * @param {number} args.gy      - Gregorian year
 * @param {number} args.gm      - Gregorian month (1-12)
 * @param {number} args.gd      - Gregorian day
 * @param {number|null} args.startMin - Start in minutes from midnight, or null for all-day
 * @param {number|null} args.endMin   - End in minutes from midnight, or null for all-day
 * @param {number|null} args.reminderMin - Display reminder N minutes before the event, or null
 * @returns {Promise<{uid: string}>} The created event's iCalendar UID
 */
export async function createEvent({ calUid, summary, gy, gm, gd, startMin = null, endMin = null, reminderMin = null }) {
  let [busName, objPath] = await openCalendar(calUid);

  let uid = `shamsi-${Date.now()}-${Math.floor(Math.random() * 1e6)}@gnome.scr.ir`;
  let ics = buildVevent({ uid, summary, gy, gm, gd, startMin, endMin, reminderMin });
  await dbusCall(
    busName, objPath, CAL_IFACE, 'CreateObjects',
    new GLib.Variant('(asu)', [[ics], 0]), null
  );
  return { uid };
}

/**
 * Remove a calendar event from EDS by UID.
 * @param {object} args
 * @param {string} args.calUid - EDS source UID the event lives in
 * @param {string} args.uid    - iCalendar UID of the event
 */
export async function removeEvent({ calUid, uid }) {
  let [busName, objPath] = await openCalendar(calUid);
  // mod type 7 = E_CAL_OBJ_MOD_ALL, empty rid = the whole (non-recurring) event
  await dbusCall(
    busName, objPath, CAL_IFACE, 'RemoveObjects',
    new GLib.Variant('(a(ss)uu)', [[[uid, '']], 7, 0]), null
  );
  return true;
}
