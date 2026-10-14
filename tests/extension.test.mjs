import test from 'node:test';
import assert from 'node:assert/strict';
import * as Tarikh from '../src/Tarikh.js';
import { Str } from '../src/otherFunctions.js';
import { Actor, St, Clutter, GLib, Gio, Settings, environment, loadSource, settle } from './helpers/shell.mjs';

test('online setting starts/stops sync without re-enabling extension; holiday color survives setting changes', async () => {
  const settings = new Settings({ 'enable-google-calendar': false, 'custom-color': true,
    'holiday-color': '#ff0000', 'not-holiday-color': '#0000ff' });
  const { Calendar, Events, calendar } = environment({}, settings);
  calendar.destroy();
  settings.values[`none-work-${new Tarikh.TarikhObject().dayOfWeek}`] = true;
  class Extension {
    constructor() { this.uuid = 'test'; this.dir = { get_path: () => '/mock' }; }
    getSettings() { return settings; }
    openPreferences() {}
  }
  class PanelButton extends Actor {
    _init() { this.menu = new Actor(); this.menu.addMenuItem = () => {}; }
  }
  const { ShamsiCalendarExtension } = loadSource('extension.js', {
    Tarikh, Str, Gio, GLib, St, Clutter, Extension,
    GObject: { registerClass: klass => class extends klass { constructor(args) { super(); this._init(args); } } },
    PanelMenu: { Button: PanelButton }, PopupMenu: { PopupBaseMenuItem: class { constructor() { this.actor = new Actor(); } } },
    Main: { panel: { addToStatusArea() {} } }, Calendar: { Calendar }, Events,
    Pango: { Alignment: { RIGHT: 2 }, WrapMode: { WORD_CHAR: 1 }, EllipsizeMode: { NONE: 0 } }, _: s => s,
    tahvil: {}, MessageTray: {}
  }, 'ShamsiCalendarExtension');
  const extension = new ShamsiCalendarExtension({}); extension.enable();
  assert.equal(extension._googleSync, null); assert.equal(extension._indicator._isHoliday, true);
  settings.set_string('holiday-color', '#00ff00'); assert.equal(extension._indicator._mainLabel.style, 'color: #00ff00;');
  const indicator = extension._indicator;
  indicator._calendar._beginEventForm(); indicator._calendar._draft.title = 'draft';
  settings.set_boolean('enable-google-calendar', true); await settle();
  assert(extension._googleSync); const sync = extension._googleSync;
  settings.set_boolean('enable-google-calendar', false); await settle();
  assert.equal(extension._googleSync, null); assert(sync._destroyed);
  assert.equal(extension._indicator, indicator); assert.equal(indicator._calendar._draft.title, 'draft');
  extension.disable(); assert.equal(settings.handlers.size, 0);
});
