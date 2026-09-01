import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { Str } from './otherFunctions.js';
import * as Tarikh from './Tarikh.js';
import * as Calendar from './calendar.js';
import * as Events from './Events.js';
import * as tahvil from './tahvil.js';

function _labelSchemaName(schema, isHoliday = false) {
  return isHoliday ? 'holiday-color' : 'not-holiday-color';
}

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {

    _init(_arg) {
      this.schema = _arg.settings;
      this.uuid = _arg.uuid;
      this.path = _arg.path;
      this._googleSync = _arg.googleSync;
      this._openPreferences = _arg.openPreferences;
      this._restartExtension = _arg.restartExtension;

      super._init(
        { left: 1.0, center: 0.5, right: 0.0 }[this.schema.get_string('window-position')] ?? 0.5,
        _('تقویم هجری شمسی')
      );

      this.schema_signals = [];

      this._mainLabel = new St.Label({
        style_class: 'shcalendar-panel-label',
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER
      });

      this.add_child(this._mainLabel);

      this._applyLabelStyle();

      this.schema_signals.push(
        this.schema.connect('changed::not-holiday-color', () => this._applyLabelStyle()),
        this.schema.connect('changed::holiday-color', () => this._applyLabelStyle()),
        this.schema.connect('changed::custom-color', () => this._applyLabelStyle()),
        this.schema.connect('changed::widget-format', () => this.updateDate(false, true)),
        this.schema.connect('changed::widget-position', () => this._restartExtension()),
        this.schema.connect('changed::window-position', () => this._restartExtension())
      );

      let bottomBarLabel = new St.Label({
        text: '',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        style_class: 'shcalendar-bottom-label'
      });

      this._todayJD = '';

      let vbox = new St.BoxLayout({
        vertical: true,
        style_class: 'shcalendar-main-box'
      });

      let calendarMenuItem = new PopupMenu.PopupBaseMenuItem({
        activate: false,
        hover: false,
        can_focus: false,
        style_class: 'shcalendar-popup-item'
      });
      calendarMenuItem.actor.add_child(vbox);
      this.menu.addMenuItem(calendarMenuItem);

      this._calendar = new Calendar.Calendar(
        this.schema,
        '',
        (text = '') => { bottomBarLabel.set_text(text); },
        this._googleSync
      );
      vbox.add_child(this._calendar.actor);

      let actionButtons = new St.BoxLayout({
        vertical: false,
        style_class: 'shcalendar-action-bar'
      });
      vbox.add_child(actionButtons);

      // Preferences button
      let prefsIcon = new St.Icon({
        icon_name: 'preferences-system-symbolic',
        icon_size: 16
      });
      let prefsButton = new St.Button({
        child: prefsIcon,
        reactive: true,
        can_focus: true,
        style_class: 'button shcalendar-btn'
      });
      prefsButton.connect('clicked', () => this._openPreferences());
      actionButtons.add_child(prefsButton);

      // Nowrooz Countdown button
      let nowroozIcon = new St.Icon({
        icon_name: 'starred-symbolic',
        icon_size: 16
      });
      let nowroozButton = new St.Button({
        child: nowroozIcon,
        reactive: true,
        can_focus: true,
        style_class: 'button shcalendar-btn'
      });
      nowroozButton.connect('clicked', () => {
        let dateObj = new Tarikh.TarikhObject();
        let targetYear = dateObj.persianYear + ((dateObj.persianMonth === 1) ? 0 : 1);
        let text = Str.numbersFormat(tahvil.tahvilData(targetYear).text);
        bottomBarLabel.set_text(text);
      });
      actionButtons.add_child(nowroozButton);

      // Today / Refresh button
      let todayIcon = new St.Icon({
        icon_name: 'view-refresh-symbolic',
        icon_size: 16
      });
      let todayButton = new St.Button({
        child: todayIcon,
        reactive: true,
        can_focus: true,
        style_class: 'button shcalendar-btn'
      });
      todayButton.connect('clicked', () => {
        this._calendar._selectedDateObj.setNow();
        this._calendar._update();
      });
      actionButtons.add_child(todayButton);

      actionButtons.add_child(bottomBarLabel);

      this.menu.connect('open-state-changed', (menu, isOpen) => {
        if (isOpen) {
          // Cheap no-op unless the day actually changed (covers suspend/resume)
          this.updateDate();
          if (this._googleSync) {
            this._googleSync.requestRange();
          }
          this._calendar._selectedDateObj.setNow();
          this._calendar._update();
        }
      });
    }

    _applyLabelStyle(isHoliday = false) {
      if (!this._mainLabel) return;
      if (this.schema.get_boolean('custom-color')) {
        let colorKey = _labelSchemaName(this.schema, isHoliday);
        this._mainLabel.set_style(`color: ${this.schema.get_string(colorKey)};`);
      } else {
        this._mainLabel.set_style('');
      }
    }

    updateDate(showNotification = false, force = false) {
      if (!this._mainLabel) return true;
      let dateObj = new Tarikh.TarikhObject();

      if (!force && this._todayJD === dateObj.julianDay) return true;
      this._todayJD = dateObj.julianDay;

      let events = new Events.Events(dateObj, this.schema, this._googleSync).getEvents(150);
      let isHoliday = events[1];

      this._applyLabelStyle(isHoliday);

      this._mainLabel.set_text(
        Str.numbersFormat(
          Str.dateStrFormat(
            this.schema.get_string('widget-format'),
            dateObj.persianDay,
            dateObj.persianMonth,
            dateObj.persianYear,
            dateObj.dayOfWeek,
            'persian'
          )
        )
      );

      if (showNotification) {
        let notifyTxt = '';
        for (let evObj of events[0]) {
          notifyTxt += Str.numbersFormat(`${evObj.symbol} ${evObj.event}${evObj.holiday ? ' (' + _('تعطیل') + ')' : ''}
`);
        }
        notify(
          Str.numbersFormat(
            `${dateObj.persianDay} ${Tarikh.mName.shamsi[dateObj.persianMonth]} ${dateObj.persianYear}`
          ),
          notifyTxt
        );
      }

      return true;
    }

    destroy() {
      if (this.schema_signals) {
        for (let sig of this.schema_signals) {
          this.schema.disconnect(sig);
        }
        this.schema_signals = [];
      }
      this._mainLabel = null;
      if (this._calendar) {
        this._calendar.destroy?.();
        this._calendar = null;
      }
      super.destroy();
    }
  }
);

function notify(title, body = '', iconName = 'x-office-calendar') {
  try {
    const source = MessageTray.getSystemSource();
    const params = {
      source,
      title,
      isTransient: true,
    };
    if (body !== '') {
      params.body = body;
    }
    const notification = new MessageTray.Notification(params);
    if (iconName) {
      notification.set({ iconName });
    }
    source.addNotification(notification);
  } catch (e) {
    console.error('ShamsiCalendar: Failed to show notification:', e);
  }
}

export default class ShamsiCalendarExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._indicator = null;
    this._googleSync = null;
    this._timers = [];
    this._settings = null;
    this._rebuildIdleId = null;
  }

  enable() {
    this._timers = [];
    this._settings = this.getSettings();

    if (this._settings.get_boolean('enable-google-calendar')) {
      this._googleSync = new Events.GoogleCalendarSync();
    }

    this._createIndicator();

    this._indicator.updateDate(this._settings.get_boolean('startup-notification'), true);

    // Refresh the panel label right after local midnight
    this._scheduleNextUpdate();
  }

  _createIndicator() {
    this._indicator = new Indicator({
      settings: this._settings,
      path: this.dir.get_path(),
      uuid: this.uuid,
      googleSync: this._googleSync,
      openPreferences: () => this.openPreferences(),
      restartExtension: () => this._rebuildIndicator()
    });

    let position = this._settings.get_string('widget-position');
    Main.panel.addToStatusArea(
      this.uuid,
      this._indicator,
      { 'left': 99999, 'center': 99999, 'right': 0 }[position] ?? 99999,
      position
    );
  }

  _rebuildIndicator() {
    // Rebuild only the indicator; never call disable()/enable() from inside
    // a settings signal handler (reentrancy + forbidden pattern on EGO).
    // Deferred to an idle callback so the signal handler unwinds first.
    if (this._rebuildIdleId) return;
    this._rebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._rebuildIdleId = null;
      if (this._indicator) {
        this._indicator.destroy();
        this._indicator = null;
      }
      if (this._settings) {
        this._createIndicator();
        this._indicator.updateDate(false, true);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _scheduleNextUpdate() {
    // Fire a few seconds after local midnight, then re-schedule for the
    // next day. Opening the menu also refreshes the label, which covers
    // clock jumps after suspend/resume.
    let now = new Date();
    let nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
    let seconds = Math.max(1, Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000));

    let timer = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      seconds,
      () => {
        this._timers = this._timers.filter((t) => t !== timer);
        this._indicator?.updateDate();
        this._scheduleNextUpdate();
        return GLib.SOURCE_REMOVE;
      }
    );
    this._timers.push(timer);
  }

  disable() {
    for (let timer of this._timers) {
      if (timer) GLib.Source.remove(timer);
    }
    this._timers = [];

    if (this._rebuildIdleId) {
      GLib.Source.remove(this._rebuildIdleId);
      this._rebuildIdleId = null;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    if (this._googleSync) {
      this._googleSync.destroy();
      this._googleSync = null;
    }

    this._settings = null;
  }
}
