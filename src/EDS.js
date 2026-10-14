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

function dbusCall(busName, objectPath, ifaceName, method, params, replyType, cancellable = null) {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(
      busName, objectPath, ifaceName, method,
      params, replyType ? new GLib.VariantType(replyType) : null,
      Gio.DBusCallFlags.NONE, 30000, cancellable,
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
export async function listCalendars(cancellable = null) {
  let reply = await dbusCall(
    SOURCES_BUS, SOURCES_PATH,
    'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
    null, '(a{oa{sa{sv}}})', cancellable
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
      try { enabled = kf.get_boolean('Data Source', 'Enabled'); } catch { }
      if (!enabled) continue;

      let backend = '';
      try { backend = kf.get_string('Calendar', 'BackendName'); } catch { }
      if (READONLY_BACKENDS.includes(backend)) continue;

      let name = source.UID;
      try { name = kf.get_string('Data Source', 'DisplayName'); } catch { }

      calendars.push({ uid: source.UID, name, backend });
    } catch {
      // ignore malformed sources
    }
  }

  // Local "Personal" calendar first, then alphabetical
  calendars.sort((a, b) => {
    if (a.uid === 'system-calendar') return -1;
    if (b.uid === 'system-calendar') return 1;
    return a.name.localeCompare(b.name);
  });
  const writable = await Promise.all(calendars.map(async calendar => {
    try {
      return await withCalendar(calendar.uid, cancellable, async (bus, path) => {
        const reply = await dbusCall(bus, path, 'org.freedesktop.DBus.Properties', 'Get',
          new GLib.Variant('(ss)', [CAL_IFACE, 'Writable']), '(v)', cancellable);
        return reply.recursiveUnpack()[0];
      });
    } catch (error) {
      if (cancellable?.is_cancelled()) throw error;
      return false;
    }
  }));
  return calendars.filter((calendar, index) => writable[index]);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function escapeIcsText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function utcDateTime(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function foldIcsLine(line) {
  let folded = '';
  let length = 0;
  const encoder = new TextEncoder();
  for (let char of line) {
    let bytes = encoder.encode(char).length;
    if (length + bytes > 75) {
      folded += '\r\n ';
      length = 1;
    }
    folded += char;
    length += bytes;
  }
  return folded;
}

function buildVevent({ uid, summary, gy, gm, gd, startMin, endMin, reminderMin }) {
  let dtstamp = utcDateTime(new Date());
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
    // UTC preserves the selected local time across online calendar backends.
    let st = utcDateTime(new Date(gy, gm - 1, gd, Math.floor(startMin / 60), startMin % 60));
    let en = utcDateTime(new Date(gy, gm - 1, gd, Math.floor(endMin / 60), endMin % 60));
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
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function mergeVevent(existing, updated) {
  const unfold = text => text.replace(/\r?\n[ \t]/g, '').trim().split(/\r?\n/);
  const replacement = unfold(updated).slice(1, -1);
  const replacedNames = new Set(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY']);
  let result = [], inEvent = false, inAlarm = false;
  for (let line of unfold(existing)) {
    if (line === 'BEGIN:VEVENT') inEvent = true;
    if (inEvent && line === 'BEGIN:VALARM') { inAlarm = true; continue; }
    if (inAlarm) {
      if (line === 'END:VALARM') inAlarm = false;
      continue;
    }
    if (inEvent && line === 'END:VEVENT') {
      result.push(...replacement);
      inEvent = false;
    }
    if (inEvent && replacedNames.has(line.split(/[:;]/, 1)[0])) continue;
    result.push(line);
  }
  return result.map(foldIcsLine).join('\r\n') + '\r\n';
}

async function withCalendar(calUid, cancellable, operation) {
  let opened = await dbusCall(
    CAL_BUS, CAL_FACTORY_PATH,
    'org.gnome.evolution.dataserver.CalendarFactory', 'OpenCalendar',
    new GLib.Variant('(s)', [calUid]), '(ss)', cancellable
  );
  let [objPath, busName] = opened.deep_unpack();
  if (!busName) busName = CAL_BUS;

  try {
    await dbusCall(busName, objPath, CAL_IFACE, 'Open', null, '(as)', cancellable);
    return await operation(busName, objPath);
  } finally {
    // Closing must still run when the operation's cancellable was cancelled.
    try { await dbusCall(busName, objPath, CAL_IFACE, 'Close', null, null); } catch { }
  }
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
export async function createEvent({ calUid, summary, gy, gm, gd, startMin = null, endMin = null, reminderMin = null }, cancellable = null) {
  return withCalendar(calUid, cancellable, async (busName, objPath) => {
    let uid = `shamsi-${GLib.uuid_string_random()}@gnome.scr.ir`;
    let ics = buildVevent({ uid, summary, gy, gm, gd, startMin, endMin, reminderMin });
    let reply = await dbusCall(
      busName, objPath, CAL_IFACE, 'CreateObjects',
      new GLib.Variant('(asu)', [[ics], 0]), '(as)', cancellable
    );
    return { uid: reply.deep_unpack()[0][0] };
  });
}

export async function modifyEvent({ calUid, uid, summary, gy, gm, gd, startMin = null, endMin = null, reminderMin = null }, cancellable = null) {
  return withCalendar(calUid, cancellable, async (busName, objPath) => {
    let reply = await dbusCall(busName, objPath, CAL_IFACE, 'GetObject',
      new GLib.Variant('(ss)', [uid, '']), '(s)', cancellable);
    let ics = mergeVevent(reply.deep_unpack()[0], buildVevent({ uid, summary, gy, gm, gd, startMin, endMin, reminderMin }));
    await dbusCall(
      busName, objPath, CAL_IFACE, 'ModifyObjects',
      new GLib.Variant('(assu)', [[ics], 'all', 0]), null, cancellable
    );
    return { uid };
  });
}

export function isNotFound(error) {
  const name = Gio.DBusError.get_remote_error(error);
  return name?.endsWith('.ObjectNotFound') ||
    name === 'org.gtk.GDBus.UnmappedGError.Quark._e_2dcal_2dclient_2derror_2dquark.Code1';
}

export async function eventExists({ calUid, uid }, cancellable = null) {
  try {
    await withCalendar(calUid, cancellable, (bus, path) => dbusCall(bus, path, CAL_IFACE, 'GetObject',
      new GLib.Variant('(ss)', [uid, '']), '(s)', cancellable));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Remove a calendar event from EDS by UID.
 * @param {object} args
 * @param {string} args.calUid - EDS source UID the event lives in
 * @param {string} args.uid    - iCalendar UID of the event
 */
export async function removeEvent({ calUid, uid }, cancellable = null) {
  return withCalendar(calUid, cancellable, async (busName, objPath) => {
    await dbusCall(
      busName, objPath, CAL_IFACE, 'RemoveObjects',
      new GLib.Variant('(a(ss)su)', [[[uid, '']], 'all', 0]), null, cancellable
    );
    return true;
  });
}
