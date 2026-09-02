import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Tarikh from './Tarikh.js';
import islamicEvents from './events/islamicEvents.js';
import persianEvents from './events/persianEvents.js';
import gregorianEvents from './events/gregorianEvents.js';
import oldPersianEvents from './events/oldPersianEvents.js';

// ---- Extra events overlay (v1.2.0) ----
// Additional events can be shipped or user-provided as JSON, without any code
// change. Lookup order (first file found wins):
//   1. $XDG_CONFIG_HOME/shamsi-calendar/extra-events.json
//   2. <extension>/events/extra-events.json
// Format (docs/EVENTS.md):
//   { "persian"|"islamic"|"gregorian": { "M/D": [["title", isHoliday, shadi], ...] } }

const _MODULE_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

class ExtraEvents {
  constructor(type, eventsMap) {
    this.name = 'مناسبت‌های افزوده';
    this.type = type;
    this.events = [[], [], [], [], [], [], [], [], [], [], [], [], []];
    for (let key in eventsMap) {
      let parts = key.split('/').map(Number);
      let m = parts[0];
      let d = parts[1];
      if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) continue;
      let list = eventsMap[key];
      if (!Array.isArray(list)) continue;
      let entries = list
        .filter(e => Array.isArray(e) && e.length >= 1)
        .map(e => [String(e[0]), e[1] === true, Number(e[2] ?? 0)]);
      if (entries.length === 0) continue;
      let dayIsHoliday = entries.some(e => e[1]);
      this.events[m][d] = [entries, dayIsHoliday];
    }
  }
}

let _extraEventsCache = null;

function getExtraEvents() {
  if (_extraEventsCache !== null) return _extraEventsCache;
  _extraEventsCache = [];
  let candidates = [
    GLib.build_filenamev([GLib.get_user_config_dir(), 'shamsi-calendar', 'extra-events.json']),
    GLib.build_filenamev([_MODULE_DIR, 'events', 'extra-events.json'])
  ];
  for (let path of candidates) {
    try {
      if (!GLib.file_test(path, GLib.FileTest.EXISTS)) continue;
      let [ok, bytes] = GLib.file_get_contents(path);
      if (!ok) continue;
      let data = JSON.parse(new TextDecoder().decode(bytes));
      for (let type of ['persian', 'islamic', 'gregorian']) {
        if (data[type] && typeof data[type] === 'object') {
          _extraEventsCache.push(new ExtraEvents(type, data[type]));
        }
      }
      break; // first found wins (user config overrides bundled file)
    } catch (e) {
      console.error('ShamsiCalendar: failed to load extra events from', path, e);
    }
  }
  return _extraEventsCache;
}

const CalendarServerIface = `<node>
  <interface name="org.gnome.Shell.CalendarServer">
    <method name="SetTimeRange">
      <arg type="x" name="since" direction="in"/>
      <arg type="x" name="until" direction="in"/>
      <arg type="b" name="force_reload" direction="in"/>
    </method>
    <signal name="EventsAddedOrUpdated">
      <arg type="a(ssxxa{sv})" name="events"/>
    </signal>
    <signal name="EventsRemoved">
      <arg type="as" name="ids"/>
    </signal>
    <property name="HasCalendars" type="b" access="read"/>
    <property name="Since" type="x" access="read"/>
    <property name="Until" type="x" access="read"/>
  </interface>
</node>`;

const CalendarServerProxy = Gio.DBusProxy.makeProxyWrapper(CalendarServerIface);

// Singleton manager for Google / EDS Calendar Events
export class GoogleCalendarSync {
  constructor() {
    this._proxy = null;
    this._events = new Map(); // id -> { id, summary, startTime, endTime, extras }
    this._listeners = new Set();
    this._initialized = false;
    this._initProxy();
  }

  _initProxy() {
    try {
      this._proxy = new CalendarServerProxy(
        Gio.DBus.session,
        'org.gnome.Shell.CalendarServer',
        '/org/gnome/Shell/CalendarServer'
      );

      this._signalId = this._proxy.connectSignal('EventsAddedOrUpdated', (proxy, sender, [events]) => {
        for (let ev of events) {
          // signature: (id, summary, startTime, endTime, extras)
          this._events.set(ev[0], {
            id: ev[0],
            summary: ev[1],
            startTime: Number(ev[2]),
            endTime: Number(ev[3]),
            extras: ev[4]
          });
        }
        this._notifyListeners();
      });

      this._removedSignalId = this._proxy.connectSignal('EventsRemoved', (proxy, sender, [ids]) => {
        for (let id of ids) {
          this._events.delete(id);
        }
        this._notifyListeners();
      });

      this.requestRange();
    } catch (e) {
      console.error('ShamsiCalendar: Error initializing CalendarServerProxy:', e);
    }
  }

  requestRange() {
    if (!this._proxy) return;
    try {
      let now = Math.floor(Date.now() / 1000);
      let since = now - 86400 * 60; // 60 days past
      let until = now + 86400 * 90; // 90 days future
      this._proxy.SetTimeRangeRemote(since, until, true, (res, err) => {
        if (err) {
          // calendar server might be inactive or starting up
        }
      });
    } catch (e) {
      console.error('ShamsiCalendar: Error setting time range:', e);
    }
  }

  addListener(fn) {
    this._listeners.add(fn);
  }

  removeListener(fn) {
    this._listeners.delete(fn);
  }

  _notifyListeners() {
    for (let fn of this._listeners) {
      try {
        fn();
      } catch (e) {
        console.error('ShamsiCalendar: Error in calendar listener callback:', e);
      }
    }
  }

  getEventsForDate(gregorianYear, gregorianMonth, gregorianDay) {
    // gregorianMonth is 1-12
    let dayStart = Math.floor(new Date(gregorianYear, gregorianMonth - 1, gregorianDay, 0, 0, 0).getTime() / 1000);
    let dayEnd = Math.floor(new Date(gregorianYear, gregorianMonth - 1, gregorianDay, 23, 59, 59).getTime() / 1000);

    let matching = [];
    for (let [_, ev] of this._events) {
      // Event intersects with the day (end is exclusive, so an event
      // ending exactly at midnight does not bleed into the next day)
      if (ev.startTime <= dayEnd && ev.endTime > dayStart) {
        matching.push(ev);
      }
    }
    return matching;
  }

  destroy() {
    if (this._proxy) {
      if (this._signalId) this._proxy.disconnectSignal(this._signalId);
      if (this._removedSignalId) this._proxy.disconnectSignal(this._removedSignalId);
      this._proxy = null;
    }
    this._listeners.clear();
    this._events.clear();
  }
}

export class Events {
  constructor(todayObj, schema, googleSync = null) {
    this.todayObj = todayObj;
    this.schema = schema;
    this.googleSync = googleSync;
    this._init();
  }

  _init() {
    this._eventsList = [];
    if (this.schema.get_boolean('show-islamic-events')) {
      this._eventsList.push(new islamicEvents(Tarikh, this.todayObj));
    }
    if (this.schema.get_boolean('show-persian-events')) {
      this._eventsList.push(new persianEvents(Tarikh, this.todayObj));
    }
    if (this.schema.get_boolean('show-gregorian-events')) {
      this._eventsList.push(new gregorianEvents(Tarikh, this.todayObj));
    }
    if (this.schema.get_boolean('show-old-events')) {
      this._eventsList.push(new oldPersianEvents(Tarikh, this.todayObj));
    }
    for (let extra of getExtraEvents()) {
      this._eventsList.push(extra);
    }
  }

  getEvents(maxLineLength = 40) {
    this._maxLineLength = maxLineLength;
    this._events = [];
    this._isHoliday = this.schema.get_boolean('none-work-' + this.todayObj.dayOfWeek);

    this._eventsList.forEach(this._checkEvent, this);

    // Google / EDS Calendar integration
    if (this.googleSync && this.schema.get_boolean('enable-google-calendar')) {
      let gEvents = this.googleSync.getEventsForDate(
        this.todayObj.gregorianYear,
        this.todayObj.gregorianMonth,
        this.todayObj.gregorianDay
      );

      for (let gEv of gEvents) {
        let startTimeStr = '';
        let startDate = new Date(gEv.startTime * 1000);
        let endDate = new Date(gEv.endTime * 1000);
        // All-day events span whole days, anchored to midnight (local or UTC,
        // depending on the backend); never rely on local hours alone.
        let _wholeDays = ((gEv.endTime - gEv.startTime) % 86400 === 0);
        let _localMidnights = startDate.getHours() === 0 && startDate.getMinutes() === 0 &&
          endDate.getHours() === 0 && endDate.getMinutes() === 0;
        let _utcMidnights = startDate.getUTCHours() === 0 && startDate.getUTCMinutes() === 0 &&
          endDate.getUTCHours() === 0 && endDate.getUTCMinutes() === 0;
        let isAllDay = _wholeDays && (_localMidnights || _utcMidnights);
        if (!isAllDay) {
          let hh = startDate.getHours().toString().padStart(2, '0');
          let mm = startDate.getMinutes().toString().padStart(2, '0');
          startTimeStr = ` (${hh}:${mm})`;
        }

        this._events.push({
          type: 'google',
          symbol: '📅',
          // LRI/PDI isolate: mixed titles like "رضا نجات‌جو's birthday" keep the apostrophe attached to the LTR run
          event: `\u2066${gEv.summary}\u2069${startTimeStr}`,
          shadi: false,
          holiday: false
        });
      }
    }

    return [this._events, this._isHoliday];
  }

  _checkEvent(el) {
    let evArr = el.events[this.todayObj[el.type][1]][this.todayObj[el.type][2]];
    let sym = { persian: '▪', islamic: '◆', gregorian: '▫' };
    if (evArr) {
      let events = evArr[0];
      for (let i in events) {
        let wTmp = events[i][0].split(' ');
        let event = '';
        let lineLength = 0;
        for (let w of wTmp) {
          let wLength = w.length + 1;
          if ((lineLength + wLength) > this._maxLineLength) {
            event += '\n     ' + w;
            lineLength = 4 + wLength;
          } else {
            event += ' ' + w;
            lineLength += wLength;
          }
        }

        this._events.push({
          type: el.type,
          symbol: sym[el.type],
          event: event,
          shadi: events[i][2],
          holiday: events[i][1]
        });
      }
      this._isHoliday = (this._isHoliday || evArr[1]);
    }
  }
}
