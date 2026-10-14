import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Tarikh from './Tarikh.js';
import islamicEvents from './events/islamicEvents.js';
import persianEvents from './events/persianEvents.js';
import gregorianEvents from './events/gregorianEvents.js';
import oldPersianEvents from './events/oldPersianEvents.js';
import { Str } from './otherFunctions.js';

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
    <signal name="ClientDisappeared">
      <arg type="s" name="source_uid"/>
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
    this._destroyed = false;
    this._cancellable = new Gio.Cancellable();
    this._eventsByDay = null;
    this._range = null;
    this._requestSerial = 0;
    this.state = 'loading';
    this.revision = 0;
    this._initProxy();
  }

  _initProxy() {
    try {
      this._proxy = new CalendarServerProxy(
        Gio.DBus.session,
        'org.gnome.Shell.CalendarServer',
        '/org/gnome/Shell/CalendarServer',
        (proxy, error) => {
          if (this._destroyed) return;
          if (error) {
            this.state = 'error';
            this._notifyListeners();
            console.error('ShamsiCalendar: calendar connection failed:', error);
            return;
          }
          this._initialized = true;
          this._connectProxy(proxy);
          this.requestRange(null, null, true);
        },
        this._cancellable
      );
    } catch (e) {
      this.state = 'error';
      console.error('ShamsiCalendar: Error initializing CalendarServerProxy:', e);
    }
  }

  _connectProxy(proxy) {
    this._signalId = proxy.connectSignal('EventsAddedOrUpdated', (proxy, sender, [events]) => {
      let handled = new Set();
      for (let ev of events) {
        let prefix = ev[0].slice(0, ev[0].lastIndexOf('\n') + 1);
        if (!ev[0].endsWith('\n') && !handled.has(prefix)) {
          this._removeMatching(prefix);
          handled.add(prefix);
        }
        // signature: (id, summary, startTime, endTime, extras)
        this._events.set(ev[0], {
          id: ev[0],
          summary: ev[1],
          startTime: Number(ev[2]),
          endTime: Number(ev[3]),
          extras: ev[4]
        });
      }
      this._eventsByDay = null;
      this.revision++;
      this._notifyListeners({ updated: events.map(e => this._events.get(e[0])) });
    });

    this._removedSignalId = proxy.connectSignal('EventsRemoved', (proxy, sender, [ids]) => {
      for (let id of ids) this._removeMatching(id);
      this._notifyListeners({ removed: ids });
    });
    this._clientSignalId = proxy.connectSignal('ClientDisappeared', (proxy, sender, [uid]) => {
      this._removeMatching(uid + '\n');
      this._notifyListeners();
    });
    this._ownerSignalId = proxy.connect('notify::g-name-owner', () => {
      this._events.clear();
      this._eventsByDay = null;
      this.revision++;
      this._requestSerial++;
      if (proxy.g_name_owner) this.requestRange(null, null, true);
      else {
        this.state = 'unavailable';
        this._notifyListeners();
      }
    });
    this._propertiesSignalId = proxy.connect('g-properties-changed', () => this._notifyListeners());
  }

  _removeMatching(prefix) {
    for (let id of this._events.keys()) {
      if (id.startsWith(prefix)) this._events.delete(id);
    }
    this._eventsByDay = null;
    this.revision++;
  }

  requestRange(since = null, until = null, force = false) {
    if (this._destroyed) return;
    if (since === null || until === null) {
      let now = new Date();
      [since, until] = this._range ?? [
        new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000,
        new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000
      ];
    }
    let changed = !this._range || this._range[0] !== since || this._range[1] !== until;
    this._range = [since, until];
    if (!this._initialized && this.state === 'error') {
      this._proxy?.run_dispose();
      this.state = 'loading';
      this._initProxy();
      return;
    }
    if (!this._initialized || !this._proxy || (!changed && !force)) return;
    if (changed || force) {
      this._events.clear();
      this._eventsByDay = null;
      this.revision++;
    }
    const serial = ++this._requestSerial;
    this.state = 'loading';
    try {
      this._proxy.SetTimeRangeRemote(since, until, true, (res, err) => {
        if (this._destroyed || serial !== this._requestSerial) return;
        this.state = err ? 'error' : (this._proxy.HasCalendars ? 'ready' : 'empty');
        if (err) console.error('ShamsiCalendar: calendar range failed:', err);
        this._notifyListeners();
      }, this._cancellable);
    } catch (e) {
      this.state = 'error';
      this._notifyListeners();
      console.error('ShamsiCalendar: Error setting time range:', e);
    }
  }

  addListener(fn) {
    this._listeners.add(fn);
  }

  removeListener(fn) {
    this._listeners.delete(fn);
  }

  _notifyListeners(change = {}) {
    if (this._destroyed) return;
    for (let fn of this._listeners) {
      try {
          fn(change);
      } catch (e) {
        console.error('ShamsiCalendar: Error in calendar listener callback:', e);
      }
    }
  }

  getEventsForDate(gregorianYear, gregorianMonth, gregorianDay) {
    let dayStart = Math.floor(new Date(gregorianYear, gregorianMonth - 1, gregorianDay, 0, 0, 0).getTime() / 1000);
    if (this._eventsByDay === null) {
      this._eventsByDay = new Map();
      const [since, until] = this._range ?? [dayStart, new Date(gregorianYear, gregorianMonth - 1, gregorianDay + 1).getTime() / 1000];
      for (let ev of this._events.values()) {
        let day = new Date(Math.max(since, ev.startTime) * 1000);
        day.setHours(0, 0, 0, 0);
        while (day.getTime() / 1000 < until) {
          let begin = day.getTime() / 1000;
          day.setDate(day.getDate() + 1);
          let end = day.getTime() / 1000;
          if (ev.endTime <= begin && !(ev.startTime === ev.endTime && ev.startTime >= begin)) break;
          if (ev.startTime < end && (ev.endTime > begin || ev.startTime === ev.endTime)) {
            if (!this._eventsByDay.has(begin)) this._eventsByDay.set(begin, []);
            this._eventsByDay.get(begin).push(ev);
          }
        }
      }
      for (let events of this._eventsByDay.values()) events.sort((a, b) => a.startTime - b.startTime);
    }
    return this._eventsByDay.get(dayStart) ?? [];
  }

  destroy() {
    this._destroyed = true;
    this._cancellable.cancel();
    if (this._proxy) {
      if (this._signalId) this._proxy.disconnectSignal(this._signalId);
      if (this._removedSignalId) this._proxy.disconnectSignal(this._removedSignalId);
        if (this._clientSignalId) this._proxy.disconnectSignal(this._clientSignalId);
        if (this._ownerSignalId) this._proxy.disconnect(this._ownerSignalId);
        if (this._propertiesSignalId) this._proxy.disconnect(this._propertiesSignalId);
        this._proxy.run_dispose();
      this._proxy = null;
    }
    this._listeners.clear();
    this._events.clear();
    this._eventsByDay = null;
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
    this._years = [this.todayObj.persianYear, this.todayObj.islamicYear];
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
    if (this._years[0] !== this.todayObj.persianYear || this._years[1] !== this.todayObj.islamicYear) this._init();
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
        let isAllDay = gEv.endTime > gEv.startTime && (_localMidnights || (_wholeDays && _utcMidnights));
        if (!isAllDay) {
          let hh = startDate.getHours().toString().padStart(2, '0');
          let mm = startDate.getMinutes().toString().padStart(2, '0');
          startTimeStr = ` (${hh}:${mm})`;
        }

        this._events.push({
          type: 'google',
          calUid: gEv.id.split('\n')[0],
          uid: gEv.id.split('\n')[1],
          symbol: '📅',
          event: Str.bidiIsolate(gEv.summary) + (startTimeStr ? Str.bidiIsolate(startTimeStr, 'ltr') : ''),
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
