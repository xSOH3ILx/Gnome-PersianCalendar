import fs from 'node:fs';
import vm from 'node:vm';
import * as Tarikh from '../../src/Tarikh.js';
import { Str } from '../../src/otherFunctions.js';
import persianEvents from '../../src/events/persianEvents.js';
import islamicEvents from '../../src/events/islamicEvents.js';
import gregorianEvents from '../../src/events/gregorianEvents.js';
import oldPersianEvents from '../../src/events/oldPersianEvents.js';

export function loadSource(file, globals, symbols) {
  let source = fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export default /g, '').replace(/export /g, '')
    .replace(/^const _MODULE_DIR = .*;$/m, 'const _MODULE_DIR = "mock";');
  let context = vm.createContext({ Date, Map, Set, TextEncoder, TextDecoder, console: { error() {} }, ...globals });
  vm.runInContext(source + `\nglobalThis.exports = {${symbols}};`, context, { filename: file });
  return context.exports;
}

class Signals {
  constructor() { this.handlers = new Map(); this.nextId = 1; }
  connect(name, fn) { let id = this.nextId++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { this.handlers.delete(id); }
  emit(name, ...args) { for (let h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

export class Settings extends Signals {
  constructor(values = {}) {
    super();
    this.values = { 'week-start': '0', 'default-tab': 'events', 'personal-events': '[]',
      'persian-display': true, 'islamic-display': true, 'gregorian-display': true,
      'show-persian-events': true, 'show-islamic-events': true, 'show-gregorian-events': true,
      'none-work-6': true, 'enable-google-calendar': true,
      'persian-display-format': '%d %MM %Y', 'islamic-display-format': '%d %MM %Y',
      'gregorian-display-format': '%d %MM %Y', 'widget-position': 'center', 'window-position': 'center',
      'widget-format': '%WW %d %MM', ...values };
  }
  get_string(k) { return this.values[k] ?? ''; }
  get_boolean(k) { return !!this.values[k]; }
  set_string(k, v) { this.values[k] = v; this.emit('changed', k); this.emit(`changed::${k}`, k); }
  set_boolean(k, v) { this.set_string(k, v); }
}

export class Actor extends Signals {
  static created = 0;
  constructor(props = {}) {
    super(); Actor.created++; Object.assign(this, props); this.children = [];
    this.clutter_text = new Signals(); this.clutter_text.set_line_alignment = a => { this.alignment = a; };
    this.text = props.text ?? ''; if (props.layout_manager) props.layout_manager.owner = this;
    if (props.child) this.add_child(props.child);
  }
  add_child(child) { this.children.push(child); child.parent = this; }
  set_child(child) { this.add_child(child); }
  get_children() { if (this.dead) throw Error('destroyed actor'); return [...this.children]; }
  set_text_direction(dir) { this.direction = dir; }
  set_text(text) { this.text = text; this.clutter_text.emit('text-changed'); }
  get_text() { return this.text; }
  get_stage() { return { height: 900 }; }
  grab_key_focus() { this.focused = true; }
  set_label(text) { this.label = text; }
  set_style(text) { this.style = text; }
  add_style_class_name(name) { this.classes ??= new Set(); this.classes.add(name); }
  remove_style_class_name(name) { this.classes?.delete(name); }
  destroy_all_children() { for (let child of [...this.children]) child.destroy(); }
  destroy() { this.destroy_all_children(); this.dead = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
}
class Grid { attach(child) { this.owner.add_child(child); } }
class Label extends Actor {}
class Entry extends Actor {}
class Button extends Actor {}
export const St = { Widget: Actor, BoxLayout: Actor, ScrollView: Actor, Icon: Actor, Label, Entry, Button,
  PolicyType: { NEVER: 2 }, Clipboard: { get_default: () => ({ set_text() {} }) }, ClipboardType: { CLIPBOARD: 1 } };
export const Clutter = { GridLayout: Grid, TextDirection: { RTL: 1, LTR: 0 },
  ActorAlign: { CENTER: 1, END: 2 }, ScrollDirection: { UP: 1, DOWN: 2, LEFT: 3, RIGHT: 4 } };
const ids = new Map(); let nextId = 1;
export const GLib = { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
  idle_add(priority, fn) { let id = nextId++; ids.set(id, setTimeout(() => { ids.delete(id); fn(); }, 0)); return id; },
  timeout_add_seconds() { return nextId++; }, Source: { remove(id) { clearTimeout(ids.get(id)); ids.delete(id); } },
  get_user_config_dir: () => '/mock', build_filenamev: a => a.join('/'), file_test: () => false, FileTest: { EXISTS: 1 } };
export class Proxy extends Signals {
  constructor(bus, name, path, callback) { super(); this.HasCalendars = true; this.g_name_owner = 'mock'; this.ranges = []; queueMicrotask(() => callback(this, null)); }
  connectSignal(name, fn) { return this.connect(name, fn); }
  disconnectSignal(id) { this.disconnect(id); }
  signal(name, args) { this.emit(name, 'mock', args); }
  SetTimeRangeRemote(since, until, force, callback) { this.ranges.push([since, until, force]); queueMicrotask(() => callback([], null)); }
  run_dispose() { this.disposed = true; }
}
export const Gio = { Cancellable: class { cancel() { this.cancelled = true; } },
  DBus: { session: {} }, DBusProxy: { makeProxyWrapper: () => Proxy } };

export function environment(edsOverrides = {}, settings = new Settings()) {
  const Events = loadSource('Events.js', { Tarikh, Str, persianEvents, islamicEvents, gregorianEvents, oldPersianEvents, Gio, GLib }, 'Events, GoogleCalendarSync');
  const EDS = { listCalendars: async () => [], createEvent: async () => ({ uid: 'new' }),
    eventExists: async () => true,
    modifyEvent: async args => ({ uid: args.uid }), removeEvent: async () => true,
    isNotFound: error => error.code === 'not-found', ...edsOverrides };
  const { Calendar } = loadSource('calendar.js', { Tarikh, Str, Events, EDS, St, Clutter, Gio, GLib,
    Pango: { Alignment: { RIGHT: 2 }, WrapMode: { WORD_CHAR: 1 }, EllipsizeMode: { NONE: 0 } }, _: s => s }, 'Calendar');
  let status = [];
  const calendar = new Calendar(settings, '', s => status.push(s));
  return { calendar, Calendar, Events, EDS, settings, status };
}
export function descendants(actor) { return [actor, ...actor.children.flatMap(descendants)]; }
export const settle = () => new Promise(resolve => setTimeout(resolve, 5));
