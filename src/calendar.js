import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Str } from './otherFunctions.js';
import * as Tarikh from './Tarikh.js';
import * as Events from './Events.js';
import * as EDS from './EDS.js';

// Reminder choices in minutes before the event; null = no reminder
const REMINDER_OPTIONS = [null, 10, 30, 60, 1440];

export class Calendar {

  constructor(Schema, cssThemeID, setBottomBarText = () => { }, googleSync = null) {
    this.schema = Schema;
    this.cssThemeID = cssThemeID;
    this.setBottomBarText = setBottomBarText;
    this.googleSync = googleSync;

    this.actorRight = new St.Widget({
      style_class: 'shcalendar-actor-right',
      layout_manager: new Clutter.GridLayout(),
      reactive: true
    });
    this.actorLeft = new St.Widget({
      style_class: 'shcalendar-actor-left',
      layout_manager: new Clutter.GridLayout(),
      reactive: true
    });

    this.actor = new St.Widget({
      style_class: 'shcalendar-root-container',
      layout_manager: new Clutter.GridLayout(),
      reactive: true
    });
    this.actor.layout_manager.attach(this.actorLeft, 0, 0, 1, 1);
    this.actor.layout_manager.attach(this.actorRight, 1, 0, 1, 1);
    this.actor.set_text_direction(Clutter.TextDirection.RTL);
    this.actorLeft.set_text_direction(Clutter.TextDirection.RTL);
    // Grid coordinates are explicit; do not mirror them a second time.
    this.actorRight.set_text_direction(Clutter.TextDirection.LTR);

    this.actorRight.connect('scroll-event', this._onScroll);

    this._selectedDateObj = new Tarikh.TarikhObject();
    this._destroyed = false;
    this._visible = false;
    this._refreshIdleId = 0;
    this._cancellable = new Gio.Cancellable();
    this._busy = false;
    this._operationButtons = [];
    this._gridKey = null;
    this._gridDays = new Map();
    this._draft = null;
    this._checkedPersonalEvents = new Set();
    this._converterState = { type: 0, year: '', month: '', day: '' };
    this._addEventFormOpen = false;
    this._edsCalendars = null;
    this._edsCalIndex = 0;
    this._activeCalBtn = null;
    this._editingEvent = null;
    this._reminderIndex = 0;
    let defaultTab = this.schema.get_string('default-tab');
    this._selectedTab = (defaultTab === 'prayTimes') ? 'events' : defaultTab;

    this._buildHeader();
    this._settingsSignalId = this.schema.connect('changed', (settings, key) => {
      if (key === 'default-tab') {
        this._selectedTab = this.schema.get_string(key) === 'dateConvert' ? 'dateConvert' : 'events';
      }
      this.queueRefresh();
    });

    this.setGoogleSync(googleSync);
  }

  setGoogleSync = (sync) => {
    if (this.googleSync && this._syncListener) this.googleSync.removeListener(this._syncListener);
    this.googleSync = sync;
    this._syncListener = null;
    if (sync) {
      this._syncListener = change => { this._reconcilePersonalEvents(change); this.queueRefresh(); };
      sync.addListener(this._syncListener);
    }
    this._gridKey = null;
    this.queueRefresh();
  }

  queueRefresh = () => {
    if (this._destroyed || !this._visible || this._addEventFormOpen || this._refreshIdleId) return;
    this._refreshIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._refreshIdleId = 0;
      if (!this._destroyed && this._visible) this._update();
      return GLib.SOURCE_REMOVE;
    });
  }

  setVisible = (visible) => {
    this._visible = visible;
    if (visible) {
      this._checkedPersonalEvents.clear();
      if (this.googleSync?.state === 'error') this.googleSync.requestRange(null, null, true);
      if (!this._addEventFormOpen) this._selectedDateObj.setNow();
      this._update();
    }
  }

  _beginEventForm = (editing = null) => {
    this._editingEvent = editing;
    this._addEventFormOpen = true;
    this._reminderIndex = Math.max(0, REMINDER_OPTIONS.indexOf(editing?.reminderMin ?? null));
    this._draft = {
      title: editing?.title ?? '',
      start: editing?.startMin !== null && editing?.startMin !== undefined ? this._formatTime(editing.startMin) : '',
      end: editing?.endMin !== null && editing?.endMin !== undefined ? this._formatTime(editing.endMin) : '',
      gy: editing?.gy ?? this._selectedDateObj.gregorianYear,
      gm: editing?.gm ?? this._selectedDateObj.gregorianMonth,
      gd: editing?.gd ?? this._selectedDateObj.gregorianDay,
      calUid: editing?.calUid ?? this._edsCalendars?.[this._edsCalIndex]?.uid ?? null
    };
    this._loadEdsCalendars();
    this._update();
    this._titleEntry.grab_key_focus();
  }

  _buildHeader = () => {
    this.actorRight.destroy_all_children();

    this._topBox = new St.BoxLayout({
      style_class: 'shcalendar-nav-header'
    });
    this._topBox.set_text_direction(Clutter.TextDirection.LTR);
    this.actorRight.layout_manager.attach(this._topBox, 0, 0, 7, 1);

    let style = 'shcalendar-nav-button';
    // Persian navigation: next on the left, previous on the right.
    let nextYearIcon = new St.Icon({ icon_name: 'go-first-symbolic', icon_size: 16 });
    let nextYearBtn = new St.Button({ can_focus: true, style_class: style, child: nextYearIcon, accessible_name: _('سال بعد') });
    nextYearBtn.connect('clicked', this._onNextYearButtonClicked);
    this._topBox.add_child(nextYearBtn);

    let nextMonthIcon = new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: 16 });
    let nextMonthBtn = new St.Button({ can_focus: true, style_class: style, child: nextMonthIcon, accessible_name: _('ماه بعد') });
    nextMonthBtn.connect('clicked', this._onNextMonthButtonClicked);
    this._topBox.add_child(nextMonthBtn);

    this._monthLabel = new St.Label({
      style_class: 'shcalendar-month-label',
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: true
    });
    this._topBox.add_child(this._monthLabel);
    this._monthLabel.set_text_direction(Clutter.TextDirection.RTL);

    let prevMonthIcon = new St.Icon({ icon_name: 'go-next-symbolic', icon_size: 16 });
    let prevMonthBtn = new St.Button({ can_focus: true, style_class: style, child: prevMonthIcon, accessible_name: _('ماه قبل') });
    prevMonthBtn.connect('clicked', this._onPrevMonthButtonClicked);
    this._topBox.add_child(prevMonthBtn);

    let prevYearIcon = new St.Icon({ icon_name: 'go-last-symbolic', icon_size: 16 });
    let prevYearBtn = new St.Button({ can_focus: true, style_class: style, child: prevYearIcon, accessible_name: _('سال قبل') });
    prevYearBtn.connect('clicked', this._onPrevYearButtonClicked);
    this._topBox.add_child(prevYearBtn);

    let todayBtn = new St.Button({ can_focus: true,
      style_class: 'shcalendar-today-button',
      label: _('امروز')
    });
    todayBtn.connect('clicked', this._onTodayButtonClicked);
    this._topBox.add_child(todayBtn);

    this._firstDayIndex = this.actorRight.get_children().length;
  }

  _onScroll = (actor, event) => {
    switch (event.get_scroll_direction()) {
      case Clutter.ScrollDirection.UP:
      case Clutter.ScrollDirection.RIGHT:
        this._onPrevMonthButtonClicked();
        break;
      case Clutter.ScrollDirection.DOWN:
      case Clutter.ScrollDirection.LEFT:
        this._onNextMonthButtonClicked();
        break;
    }
  }

  _onTodayButtonClicked = () => {
    this._selectedDateObj.julianDay = new Tarikh.TarikhObject().julianDay;
    this._update();
  }

  // --- Personal events (v1.1.0) ---

  _buildAddEventArea = (parentBox) => {
    let addBox = new St.BoxLayout({ vertical: true, style_class: 'shcalendar-add-event-container' });
    addBox.set_text_direction(Clutter.TextDirection.RTL);

    if (!this._addEventFormOpen) {
      let addBtn = new St.Button({ can_focus: true,
        label: _('+ افزودن رویداد'),
        style_class: 'shcalendar-add-event-btn',
        x_expand: true
      });
      addBtn.connect('clicked', () => {
        this._beginEventForm();
      });
      addBox.add_child(addBtn);
    } else {
      let form = new St.BoxLayout({ vertical: true, style_class: 'shcalendar-add-event-form' });
      form.set_text_direction(Clutter.TextDirection.RTL);

      let editing = this._editingEvent;
      if (editing) {
        let editHeader = new St.Label({
          text: _('ویرایش رویداد'),
          style_class: 'shcalendar-add-event-hint'
        });
        form.add_child(editHeader);
      }

      let titleEntry = new St.Entry({
        hint_text: _('عنوان رویداد'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });
      let draft = this._draft;
      let destination = Tarikh.gregorian_to_persian(draft.gy, draft.gm, draft.gd);
      form.add_child(new St.Label({
        text: _('تاریخ رویداد:') + ' ' + Str.numbersFormat(destination.join('/')),
        x_expand: true, style_class: 'shcalendar-add-event-hint'
      }));
      form.add_child(new St.Label({ text: _('عنوان رویداد'), x_expand: true, style_class: 'shcalendar-add-event-hint' }));
      this._titleEntry = titleEntry;
      titleEntry.set_text_direction(Clutter.TextDirection.RTL);
      titleEntry.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);
      titleEntry.set_text(draft.title);
      titleEntry.clutter_text.connect('text-changed', () => { draft.title = titleEntry.get_text(); });
      form.add_child(titleEntry);

      let timeRow = new St.BoxLayout({ style_class: 'shcalendar-add-event-times' });
      timeRow.set_text_direction(Clutter.TextDirection.RTL);
      let startEntry = new St.Entry({
        hint_text: _('شروع (۰۹:۰۰)'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });
      let endEntry = new St.Entry({
        hint_text: _('پایان (۱۰:۰۰)'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });
      startEntry.set_text_direction(Clutter.TextDirection.LTR);
      endEntry.set_text_direction(Clutter.TextDirection.LTR);
      startEntry.set_text(draft.start);
      endEntry.set_text(draft.end);
      startEntry.clutter_text.connect('text-changed', () => { draft.start = startEntry.get_text(); });
      endEntry.clutter_text.connect('text-changed', () => { draft.end = endEntry.get_text(); });
      for (let [label, entry] of [[_('شروع'), startEntry], [_('پایان'), endEntry]]) {
        let column = new St.BoxLayout({ vertical: true, x_expand: true });
        column.add_child(new St.Label({ text: label, x_expand: true, style_class: 'shcalendar-add-event-hint' }));
        column.add_child(entry);
        timeRow.add_child(column);
      }
      form.add_child(timeRow);

      let timeHint = new St.Label({
        text: _('ساعت‌ها را خالی بگذارید تا رویداد تمام‌روز ثبت شود'),
        style_class: 'shcalendar-add-event-hint'
      });
      form.add_child(timeHint);

      if (draft.calUid && this._edsCalendars) {
        let ci = this._edsCalendars.findIndex(c => c.uid === draft.calUid);
        if (ci >= 0) this._edsCalIndex = ci;
      }
      let calName = !this._edsCalendars && this._calendarsLoading ? _('در حال دریافت تقویم‌ها…') : this._draft?.calUid
        ? this._edsCalendars?.find(c => c.uid === this._draft.calUid)?.name ?? _('تقویم اصلی در دسترس نیست')
        : this._edsCalendars?.[this._edsCalIndex]?.name ?? _('پیش‌فرض سیستم');
      let calBtn = new St.Button({ can_focus: true,
        label: _('تقویم:') + ' ' + calName,
        style_class: 'shcalendar-add-event-cal',
        x_expand: true
      });
      calBtn.connect('clicked', () => {
        if (this._edsCalendars && this._edsCalendars.length > 0) {
          this._edsCalIndex = this._edsCalendars.some(c => c.uid === draft.calUid)
            ? (this._edsCalIndex + 1) % this._edsCalendars.length : 0;
          draft.calUid = this._edsCalendars[this._edsCalIndex].uid;
          calBtn.set_label(_('تقویم:') + ' ' + this._edsCalendars[this._edsCalIndex].name);
        }
      });
      this._activeCalBtn = calBtn;
      form.add_child(calBtn);

      let remLabels = [_('بدون یادآور'), _('۱۰ دقیقه قبل'), _('۳۰ دقیقه قبل'), _('۱ ساعت قبل'), _('۱ روز قبل')];
      let remBtn = new St.Button({ can_focus: true,
        label: _('یادآور:') + ' ' + remLabels[this._reminderIndex],
        style_class: 'shcalendar-add-event-cal',
        x_expand: true
      });
      remBtn.connect('clicked', () => {
        this._reminderIndex = (this._reminderIndex + 1) % REMINDER_OPTIONS.length;
        remBtn.set_label(_('یادآور:') + ' ' + remLabels[this._reminderIndex]);
      });
      form.add_child(remBtn);

      let btnRow = new St.BoxLayout({ style_class: 'shcalendar-add-event-actions' });
      btnRow.set_text_direction(Clutter.TextDirection.RTL);
      let saveBtn = new St.Button({ can_focus: true, label: _('ذخیره'), style_class: 'shcalendar-add-event-save', x_expand: true });
      let cancelBtn = new St.Button({ can_focus: true, label: _('انصراف'), style_class: 'shcalendar-add-event-cancel', x_expand: true });
      btnRow.add_child(saveBtn);
      btnRow.add_child(cancelBtn);
      form.add_child(btnRow);
      this._operationButtons.push(saveBtn, cancelBtn, calBtn, remBtn, titleEntry, startEntry, endEntry);

      saveBtn.connect('clicked', () => {
        this._savePersonalEvent(titleEntry.get_text(), startEntry.get_text(), endEntry.get_text());
      });
      cancelBtn.connect('clicked', () => {
        this._addEventFormOpen = false;
        this._activeCalBtn = null;
        this._editingEvent = null;
        this._draft = null;
        this._update();
      });

      addBox.add_child(form);
    }

    parentBox.add_child(addBox);
  }

  _getPersonalEvents = () => {
    try {
      let list = JSON.parse(this.schema.get_string('personal-events'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _setPersonalEvents = (list) => {
    this.schema.set_string('personal-events', JSON.stringify(list));
  }

  _personalEventsForDay = (gy, gm, gd) => {
    return this._getPersonalEvents().filter(p => p.gy === gy && p.gm === gm && p.gd === gd);
  }

  _formatTime = (min) => {
    let h = String(Math.floor(min / 60)).padStart(2, '0');
    let m = String(min % 60).padStart(2, '0');
    return Str.numbersFormat(`${h}:${m}`);
  }

  _renderPersonalEventRows = (parentBox, personalEvents) => {
    for (let pEv of personalEvents) {
      let row = new St.BoxLayout({
        vertical: false,
        style_class: 'shcalendar-event-item personal'
      });
      row.set_text_direction(Clutter.TextDirection.RTL);

      let badge = new St.Label({ text: '✏️', style_class: 'shcalendar-event-badge' });
      row.add_child(badge);

      let timeStr = (pEv.startMin !== null && pEv.startMin !== undefined)
        ? ` (${this._formatTime(pEv.startMin)}–${this._formatTime(pEv.endMin)})`
        : '';
      let lbl = new St.Label({
        text: pEv.title + timeStr,
        x_expand: true,
        style_class: 'shcalendar-event-text'
      });
      lbl.clutter_text.line_wrap = true;
      lbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
      row.add_child(lbl);

      let editBtn = new St.Button({ can_focus: true, label: _('ویرایش'), style_class: 'shcalendar-event-mini-btn' });
      editBtn.connect('clicked', () => {
        this._beginEventForm(pEv);
      });
      this._operationButtons.push(editBtn);
      row.add_child(editBtn);

      let delBtn = new St.Button({ can_focus: true, label: _('حذف'), style_class: 'shcalendar-event-mini-btn danger' });
      delBtn.connect('clicked', () => {
        this._deletePersonalEvent(pEv);
      });
      this._operationButtons.push(delBtn);
      row.add_child(delBtn);

      parentBox.add_child(row);
    }
  }

  _setBusy = (busy) => {
    this._busy = busy;
    if (this._destroyed) return;
    for (let button of this._operationButtons) {
      button.reactive = !busy;
      button.can_focus = !busy;
      if (button instanceof St.Entry) button.clutter_text.editable = !busy;
    }
  }

  _refreshEvents = () => {
    if (this._destroyed) return;
    if (this.googleSync) this.googleSync.requestRange(null, null, true);
    this._update();
  }

  _reconcilePersonalEvents = ({ removed = [], updated = [] } = {}) => {
    let list = this._getPersonalEvents();
    let changed = false;
    list = list.filter(p => {
      if (removed.some(id => `${p.calUid}\n${p.uid}\n`.startsWith(id))) {
        changed = true;
        return false;
      }
      let remote = updated.find(ev => ev.id === `${p.calUid}\n${p.uid}\n`);
      if (remote) {
        let start = new Date(remote.startTime * 1000);
        let end = new Date(remote.endTime * 1000);
        let allDay = start.getHours() === 0 && start.getMinutes() === 0 &&
          end.getHours() === 0 && end.getMinutes() === 0 && remote.endTime > remote.startTime;
        let next = { ...p, title: remote.summary, gy: start.getFullYear(), gm: start.getMonth() + 1,
          gd: start.getDate(), startMin: allDay ? null : start.getHours() * 60 + start.getMinutes(),
          endMin: allDay ? null : end.getHours() * 60 + end.getMinutes() };
        if (JSON.stringify(next) !== JSON.stringify(p)) {
          Object.assign(p, next);
          changed = true;
        }
      }
      return true;
    });
    if (changed) this._setPersonalEvents(list);
  }

  _verifyPersonalEvents = (records) => {
    if (!this._visible) return;
    for (let record of records) {
      let key = `${record.calUid}\n${record.uid}`;
      if (this._checkedPersonalEvents.has(key)) continue;
      this._checkedPersonalEvents.add(key);
      EDS.eventExists(record, this._cancellable).then(exists => {
        if (exists || this._destroyed) return;
        this._setPersonalEvents(this._getPersonalEvents().filter(p => p.calUid !== record.calUid || p.uid !== record.uid));
        this.queueRefresh();
      }).catch(error => {
        this._checkedPersonalEvents.delete(key);
        if (!this._destroyed) console.error('ShamsiCalendar: event lookup failed:', error);
      });
    }
  }

  _deletePersonalEvent = async (pEv) => {
    if (this._busy || this._destroyed) return;
    this._setBusy(true);
    this.setBottomBarText(_('در حال حذف…'));
    try {
      try {
        await EDS.removeEvent({ calUid: pEv.calUid, uid: pEv.uid }, this._cancellable);
      } catch (e) {
        if (!EDS.isNotFound(e)) throw e;
      }
      this._setPersonalEvents(this._getPersonalEvents().filter(x => x.uid !== pEv.uid || x.calUid !== pEv.calUid));
      if (this._destroyed) return;
      this.setBottomBarText(_('رویداد حذف شد'));
      this._refreshEvents();
    } catch (e) {
      if (this._destroyed) return;
      console.error('ShamsiCalendar: removeEvent failed:', e);
      this.setBottomBarText(_('حذف انجام نشد؛ اتصال و دسترسی تقویم را بررسی کنید'));
    } finally {
      this._setBusy(false);
    }
  }

  _loadEdsCalendars = () => {
    if (this._calendarsLoading) return;
    this._calendarsLoading = true;
    EDS.listCalendars(this._cancellable).then(cals => {
      if (this._destroyed) return;
      if (cals.length === 0) {
        this.setBottomBarText(_('تقویم قابل نوشتن در دسترس نیست؛ اتصال و دسترسی حساب را بررسی کنید'));
        return;
      }
      this._edsCalendars = cals;
      let idx = cals.findIndex(c => c.uid === (this._draft?.calUid ?? 'system-calendar'));
      this._edsCalIndex = idx >= 0 ? idx : 0;
      if (this._draft && (!this._draft.calUid || (idx < 0 && !this._editingEvent))) {
        this._draft.calUid = cals[this._edsCalIndex].uid;
        idx = this._edsCalIndex;
      }
      // Update the open form's calendar button in place (no rebuild, keeps typed text)
      if (this._activeCalBtn) {
        let name = idx < 0 && this._draft?.calUid ? _('تقویم اصلی در دسترس نیست') : cals[this._edsCalIndex].name;
        this._activeCalBtn.set_label(_('تقویم:') + ' ' + name);
      }
    }).catch(e => {
      if (this._destroyed) return;
      console.error('ShamsiCalendar: EDS listCalendars failed:', e);
      this.setBottomBarText(_('فهرست تقویم‌ها در دسترس نیست؛ حساب آنلاین را بررسی کنید'));
    }).finally(() => { this._calendarsLoading = false; });
  }

  _parseTimeText = (txt) => {
    txt = (txt ?? '').trim();
    if (txt === '') return null;
    txt = Str.toEnglishDigits(txt);
    let m = txt.match(/^(\d{1,2})(?:[:.،](\d{1,2}))?$/);
    if (!m) return NaN;
    let h = parseInt(m[1], 10);
    let mi = m[2] !== undefined ? parseInt(m[2], 10) : 0;
    if (h > 23 || mi > 59) return NaN;
    return h * 60 + mi;
  }

  _savePersonalEvent = async (title, startTxt, endTxt) => {
    if (this._busy || this._destroyed) return;
    title = (title ?? '').trim();
    if (title === '') {
      this.setBottomBarText(_('عنوان رویداد را وارد کنید'));
      return;
    }
    let startMin = this._parseTimeText(startTxt);
    let endMin = this._parseTimeText(endTxt);
    if (Number.isNaN(startMin) || Number.isNaN(endMin)) {
      this.setBottomBarText(_('قالب ساعت درست نیست (مثال: ۰۹:۳۰)'));
      return;
    }
    if (startMin === null && endMin !== null) startMin = Math.max(0, endMin - 60);
    if (startMin !== null && endMin === null) endMin = Math.min(23 * 60 + 59, startMin + 60);
    if (startMin !== null && endMin <= startMin) {
      this.setBottomBarText(_('ساعت پایان باید بعد از شروع باشد'));
      return;
    }

    let editing = this._editingEvent;
    let calUid = this._draft?.calUid ?? this._edsCalendars?.[this._edsCalIndex]?.uid ?? editing?.calUid ?? 'system-calendar';
    let reminderMin = REMINDER_OPTIONS[this._reminderIndex] ?? null;
    let gy = this._draft?.gy ?? editing?.gy ?? this._selectedDateObj.gregorianYear;
    let gm = this._draft?.gm ?? editing?.gm ?? this._selectedDateObj.gregorianMonth;
    let gd = this._draft?.gd ?? editing?.gd ?? this._selectedDateObj.gregorianDay;

    this.setBottomBarText(_('در حال ذخیره…'));
    this._setBusy(true);
    const args = { calUid, summary: title, gy, gm, gd, startMin, endMin, reminderMin };
    let incompleteMove = false;
    try {
      let result = editing && editing.calUid === calUid
        ? await EDS.modifyEvent({ ...args, uid: editing.uid }, this._cancellable)
        : await EDS.createEvent(args, this._cancellable);
      let record = { uid: result.uid, calUid, title, gy, gm, gd, startMin, endMin, reminderMin };
      if (editing && editing.calUid !== calUid) {
        try {
          await EDS.removeEvent(editing, this._cancellable);
        } catch (e) {
          if (!EDS.isNotFound(e)) {
            let sourceExists;
            try { sourceExists = await EDS.eventExists(editing); } catch { sourceExists = null; }
            if (sourceExists === false) {
              // A timed-out removal may already have committed; keep the destination.
            } else {
              if (sourceExists === true) {
                try { await EDS.removeEvent(record); } catch (rollbackError) {
                  incompleteMove = true;
                  console.error('ShamsiCalendar: move rollback failed:', rollbackError);
                }
              } else incompleteMove = true;
              // Never delete the destination while the source's existence is unknown.
              if (incompleteMove) {
                this._setPersonalEvents([...this._getPersonalEvents(), record]);
              }
              throw e;
            }
          }
        }
      }
      let list = this._getPersonalEvents().filter(x => !editing || x.uid !== editing.uid || x.calUid !== editing.calUid);
      list.push(record);
      this._setPersonalEvents(list);
      if (this._destroyed) return;
      this._addEventFormOpen = false;
      this._activeCalBtn = null;
      this._editingEvent = null;
      this._draft = null;
      this.setBottomBarText(_('رویداد ذخیره شد ✓'));
      this._refreshEvents();
    } catch (e) {
      if (this._destroyed) return;
      console.error('ShamsiCalendar: createEvent failed:', e);
      this.setBottomBarText(incompleteMove
        ? _('جابجایی کامل نشد؛ نسخهٔ مقصد حفظ شد، هر دو تقویم را بررسی کنید')
        : _('ذخیره انجام نشد؛ اتصال و دسترسی تقویم را بررسی کنید'));
    } finally {
      this._setBusy(false);
    }
  }

  _onPrevMonthButtonClicked = () => {
    let [y, m, d] = this._selectedDateObj.persian;
    if (m === 1) {
      m = 12;
      y--;
      let dom = Tarikh.daysOfMonth_persian(y, 12);
      if (d > dom) d = dom;
    } else {
      m--;
      let dom = Tarikh.daysOfMonth_persian(y, m);
      if (d > dom) d = dom;
    }
    this._selectedDateObj.persian = [y, m, d];
    this._update();
  }

  _onNextMonthButtonClicked = () => {
    let [y, m, d] = this._selectedDateObj.persian;
    if (m === 12) {
      y++;
      m = 1;
    } else {
      m++;
    }
    let dom = Tarikh.daysOfMonth_persian(y, m);
    if (d > dom) d = dom;
    this._selectedDateObj.persian = [y, m, d];
    this._update();
  }

  _onPrevYearButtonClicked = () => {
    let [y, m, d] = this._selectedDateObj.persian;
    y--;
    let dom = Tarikh.daysOfMonth_persian(y, m);
    if (d > dom) d = dom;
    this._selectedDateObj.persian = [y, m, d];
    this._update();
  }

  _onNextYearButtonClicked = () => {
    let [y, m, d] = this._selectedDateObj.persian;
    y++;
    let dom = Tarikh.daysOfMonth_persian(y, m);
    if (d > dom) d = dom;
    this._selectedDateObj.persian = [y, m, d];
    this._update();
  }

  _update = () => {
    if (this._destroyed) return;
    let weekStart = Number(this.schema.get_string('week-start'));
    if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) weekStart = 0;
    let dateDisplay = {
      persian: this.schema.get_boolean('persian-display'),
      islamic: this.schema.get_boolean('islamic-display'),
      gregorian: this.schema.get_boolean('gregorian-display')
    };
    let nowObj = new Tarikh.TarikhObject();
    let personalAll = this._getPersonalEvents();
    let gridKey = JSON.stringify([
      this._selectedDateObj.persianYear, this._selectedDateObj.persianMonth, weekStart,
      dateDisplay, nowObj.julianDay, this.googleSync?.revision, personalAll,
      ...['show-persian-events', 'show-islamic-events', 'show-gregorian-events', 'show-old-events',
        'enable-google-calendar', 'rotation-to-vertical', 'reverse-direction',
        ...Array.from({ length: 7 }, (_, i) => `none-work-${i}`)].map(k => this.schema.get_boolean(k))
    ]);

    if (gridKey !== this._gridKey) {
      this._gridDays.clear();
      const personalDays = new Set(personalAll.map(p => `${p.gy}/${p.gm}/${p.gd}`));
      let children = this.actorRight.get_children();
      for (let i = this._firstDayIndex; i < children.length; i++) {
        children[i].destroy();
      }

      const weekdayAbbr = ['ش', '۱ش', '۲ش', '۳ش', '۴ش', '۵ش', 'ج'];
      for (let i = weekStart; i < (weekStart + 7); i++) {
        let label = new St.Label({
          style_class: 'shcalendar-day-heading shcalendar-rtl' + (this.schema.get_boolean(`none-work-${i % 7}`) ? ' holiday' : ''),
          text: weekdayAbbr[i % 7]
        });
        let [left, top, width, height] = this._rotate(
          Math.abs(this._colPosition(this.schema) - ((7 + i - weekStart) % 7)),
          1, 1, 1,
          this.schema
        );
        this.actorRight.layout_manager.attach(label, left, top, width, height);
      }

      this._monthLabel.text = `${Tarikh.mName.shamsi[this._selectedDateObj.persianMonth]} ${Str.numbersFormat(this._selectedDateObj.persianYear)}`;

      // Accurate start of the month grid alignment
      let iterObj = new Tarikh.TarikhObject();
      iterObj.julianDay = this._selectedDateObj.julianDay;
      iterObj.persianDay = 1;
      let offset = (iterObj.dayOfWeek - weekStart + 7) % 7;
      iterObj.julianDay -= offset;
      let monthEnd = Tarikh.persian_to_julianDay(this._selectedDateObj.persianYear, this._selectedDateObj.persianMonth, 1) +
        Tarikh.daysOfMonth_persian(this._selectedDateObj.persianYear, this._selectedDateObj.persianMonth);
      let gridEnd = iterObj.julianDay + Math.ceil((monthEnd - iterObj.julianDay) / 7) * 7;
      if (this.googleSync) {
        let start = new Date(...[iterObj.gregorianYear, iterObj.gregorianMonth - 1, iterObj.gregorianDay]);
        let [ey, em, ed] = Tarikh.julianDay_to_gregorian(gridEnd);
        this.googleSync.requestRange(start.getTime() / 1000, new Date(ey, em - 1, ed).getTime() / 1000);
      }

      let row = 2;

      // Reusable events generator
      let eventChecker = new Events.Events(iterObj, this.schema, this.googleSync);

      while (true) {
        eventChecker.todayObj = iterObj;
        let events = eventChecker.getEvents();

        let isOtherMonth = (iterObj.persianMonth !== this._selectedDateObj.persianMonth);
        let isToday = (iterObj.julianDay === nowObj.julianDay);
        let isSelected = (iterObj.julianDay === this._selectedDateObj.julianDay);
        let isHoliday = events[1];

        let shamsiLabel = new St.Label({
          text: (dateDisplay.persian ? Str.numbersFormat(iterObj.persianDay) : ' '),
          style_class: 'shcalendar-pdate-day-txt' + (isHoliday ? ' holiday' : '')
        });

        let ghamariLabel = new St.Label({
          text: (dateDisplay.islamic ? Str.numbersFormat(iterObj.islamicDay) : ' '),
          style_class: 'shcalendar-hdate-day-txt'
        });

        let miladiLabel = new St.Label({
          text: (dateDisplay.gregorian ? iterObj.gregorianDay.toString() : ' '),
          style_class: 'shcalendar-gdate-day-txt'
        });

        let datesOfDay = new St.Widget({
          style_class: 'shcalendar-day-content',
          layout_manager: new Clutter.GridLayout(),
          reactive: true
        });
        datesOfDay.layout_manager.attach(shamsiLabel, 0, 0, 2, 2);
        datesOfDay.layout_manager.attach(ghamariLabel, 2, 0, 1, 1);
        datesOfDay.layout_manager.attach(miladiLabel, 2, 1, 1, 1);

        let dayButton = new St.Button({ can_focus: true,
          child: datesOfDay,
          accessible_name: Str.numbersFormat(Str.dateStrFormat('%WW %d %MM %Y', iterObj.persianDay,
            iterObj.persianMonth, iterObj.persianYear, iterObj.dayOfWeek, 'persian')),
          style_class: 'shcalendar-day-button'
        });

        if (isOtherMonth) {
          dayButton.add_style_class_name('other-month');
          dayButton.opacity = 110;
        }
        if (isToday) dayButton.add_style_class_name('today');
        if (isSelected) {
          dayButton.add_style_class_name('selected');
        }
        if (isHoliday) dayButton.add_style_class_name('holiday');

        // Dot marker: only personal/Google events (official events would mark almost every day)
        let hasUserEvents = events[0].some(e => e.type === 'google') ||
          personalDays.has(`${iterObj.gregorianYear}/${iterObj.gregorianMonth}/${iterObj.gregorianDay}`);
        if (hasUserEvents) dayButton.add_style_class_name('has-events');
        datesOfDay.layout_manager.attach(new St.Label({
          text: hasUserEvents ? '●' : ' ', style_class: 'shcalendar-event-dot',
          x_align: Clutter.ActorAlign.CENTER
        }), 0, 2, 3, 1);

        let iterObj_julianDay = iterObj.julianDay;
        this._gridDays.set(iterObj_julianDay, { button: dayButton, events });
        dayButton.connect('clicked', () => {
          this._selectedDateObj.julianDay = iterObj_julianDay;
          this._update();
        });

        let [left, top, width, height] = this._rotate(
          Math.abs(this._colPosition(this.schema) - ((7 + iterObj.dayOfWeek - weekStart) % 7)),
          row,
          1,
          1,
          this.schema
        );
        this.actorRight.layout_manager.attach(dayButton, left, top, width, height);

        iterObj.julianDay++;

        if (iterObj.dayOfWeek === weekStart) {
          if (iterObj.persianMonth > this._selectedDateObj.persianMonth || iterObj.persianYear > this._selectedDateObj.persianYear) {
            break;
          }
          row++;
        }
      }
      this._gridKey = gridKey;
    }
    for (let [jd, { button }] of this._gridDays) {
      if (jd === this._selectedDateObj.julianDay) button.add_style_class_name('selected');
      else button.remove_style_class_name('selected');
    }
    let selectedDateEvents = this._gridDays.get(this._selectedDateObj.julianDay)?.events;
    if (!selectedDateEvents) {
      let _currObj = new Tarikh.TarikhObject();
      _currObj.julianDay = this._selectedDateObj.julianDay;
      selectedDateEvents = new Events.Events(_currObj, this.schema, this.googleSync).getEvents();
    }

    this._activeCalBtn = null;
    this._titleEntry = null;
    this._operationButtons = [];
    this.actorLeft.destroy_all_children();
    // Left Panel - Selected Date Card & Details
    let _datesBox = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      style_class: 'shcalendar-selected-card'
    });
    this.actorLeft.layout_manager.attach(_datesBox, 0, 0, 1, 1);

    let diffDays = this._selectedDateObj.julianDay - nowObj.julianDay;
    let relText = (diffDays === 0) ? _('امروز') : (diffDays < 0 ? `${-diffDays} ${_('روز پیش')}` : `${diffDays} ${_('روز بعد')}`);

    let dateTitle = new St.Label({
      text: Str.numbersFormat(
        Str.dateStrFormat(
          '%WW',
          this._selectedDateObj.persianDay,
          this._selectedDateObj.persianMonth,
          this._selectedDateObj.persianYear,
          this._selectedDateObj.dayOfWeek,
          'persian'
        ) + `  •  ${relText}`
      ),
      x_expand: true,
      style_class: 'shcalendar-card-header'
    });
    _datesBox.add_child(dateTitle);

    if (dateDisplay.persian) {
      let pLabel = new St.Label({
        text: Str.numbersFormat(
          Str.dateStrFormat(
            this.schema.get_string('persian-display-format'),
            this._selectedDateObj.persianDay,
            this._selectedDateObj.persianMonth,
            this._selectedDateObj.persianYear,
            this._selectedDateObj.dayOfWeek,
            'persian'
          )
        ) + ' ' + _('هـ.ش'),
        x_expand: true,
        style_class: 'shcalendar-card-pdate'
      });
      _datesBox.add_child(pLabel);
    }

    if (dateDisplay.islamic || dateDisplay.gregorian) {
      let subDatesHbox = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: 'shcalendar-card-subdates'
      });

      if (dateDisplay.islamic) {
        let hLabel = new St.Label({
          text: Str.numbersFormat(
            Str.dateStrFormat(
              this.schema.get_string('islamic-display-format'),
              this._selectedDateObj.islamicDay,
              this._selectedDateObj.islamicMonth,
              this._selectedDateObj.islamicYear,
              this._selectedDateObj.dayOfWeek,
              'islamic'
            )
          ) + ' ' + _('هـ.ق'),
          style_class: 'shcalendar-card-hdate'
        });
        subDatesHbox.add_child(hLabel);
      }

      if (dateDisplay.gregorian) {
        let gLabel = new St.Label({
          text: Str.bidiIsolate(Str.dateStrFormat(
            this.schema.get_string('gregorian-display-format'),
            this._selectedDateObj.gregorianDay,
            this._selectedDateObj.gregorianMonth,
            this._selectedDateObj.gregorianYear,
            this._selectedDateObj.dayOfWeek,
            'gregorian'
          ) + ' M', 'ltr'),
          style_class: 'shcalendar-card-gdate'
        });
        subDatesHbox.add_child(gLabel);
      }

      _datesBox.add_child(subDatesHbox);
    }

    let evTopPosition = 0;

    // Tabs Header
    let _tabContainer = new St.BoxLayout({
      x_expand: true,
      style_class: 'shcalendar-tab-bar'
    });
    // Persian UI: first tab belongs on the right, regardless of system locale
    _tabContainer.set_text_direction(Clutter.TextDirection.RTL);

    let tabs = {
      events: _('مناسبت‌ها و رویدادها'),
      dateConvert: _('تبدیل تاریخ')
    };

    for (let tabKey in tabs) {
      let tabBtn = new St.Button({ can_focus: true,
        label: tabs[tabKey],
        style_class: 'shcalendar-tab-button' + ((this._selectedTab === tabKey) ? ' active' : '')
      });
      tabBtn.connect('clicked', () => {
        this._selectedTab = tabKey;
        this._update();
      });
      _tabContainer.add_child(tabBtn);
    }
    this.actorLeft.layout_manager.attach(_tabContainer, 0, ++evTopPosition, 1, 1);

    // Scrollable Content
    let _scrollBox = new St.ScrollView({
      x_expand: true,
      overlay_scrollbars: true,
      enable_mouse_scrolling: true,
      hscrollbar_policy: St.PolicyType ? St.PolicyType.NEVER : 2,
      style_class: 'shcalendar-events-scrollable'
    });
    this.actorLeft.layout_manager.attach(_scrollBox, 0, ++evTopPosition, 1, 1);

    if (this._selectedTab === 'events') {
      let _eventsBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'shcalendar-events-layout' });
      if (typeof _scrollBox.set_child === 'function') {
        _scrollBox.set_child(_eventsBox);
      } else {
        _scrollBox.add_child(_eventsBox);
      }
      if (this._addEventFormOpen) {
        let maxHeight = Math.max(180, Math.min(420, (this.actor.get_stage()?.height ?? 800) - 400));
        _scrollBox.set_style(`max-height: ${maxHeight}px;`);
        this._buildAddEventArea(_eventsBox);
      } else {
        if (this.googleSync && this.googleSync.state !== 'ready') {
          const syncStatus = {
            loading: _('در حال دریافت رویدادهای تقویم…'),
            error: _('دریافت رویدادها انجام نشد؛ اتصال و حساب آنلاین را بررسی کنید'),
            unavailable: _('سرویس تقویم در دسترس نیست'),
            empty: _('تقویمی در سیستم فعال نیست؛ حساب آنلاین را در تنظیمات گنوم اضافه کنید')
          };
          let status = new St.Label({ text: syncStatus[this.googleSync.state] ?? '',
            x_expand: true, style_class: 'shcalendar-sync-status' });
          status.clutter_text.line_wrap = true;
          _eventsBox.add_child(status);
        }

        let selPersonal = this._personalEventsForDay(
          this._selectedDateObj.gregorianYear,
          this._selectedDateObj.gregorianMonth,
          this._selectedDateObj.gregorianDay
        );
        let personalIds = new Set(selPersonal.map(p => `${p.calUid}\n${p.uid}`));

        if (selectedDateEvents[0].length === 0 && selPersonal.length === 0) {
          let emptyLabel = new St.Label({
            text: _('مناسبت یا رویدادی برای این روز ثبت نشده است.'),
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'shcalendar-empty-event-label'
          });
          _eventsBox.add_child(emptyLabel);
        } else {
          for (let evObj of selectedDateEvents[0]) {
            // Skip EDS copies of personal events; they are rendered below with edit/delete controls
            if (evObj.type === 'google' && personalIds.has(`${evObj.calUid}\n${evObj.uid}`)) {
              continue;
            }
            let evItemBox = new St.BoxLayout({
              vertical: false,
              style_class: 'shcalendar-event-item' + (evObj.holiday ? ' holiday' : '')
            });
            // Persian UI: badge sits to the right of the text, regardless of system locale
            evItemBox.set_text_direction(Clutter.TextDirection.RTL);

            let evBadge = new St.Label({
              text: evObj.holiday ? _('تعطیل') : (evObj.symbol ?? '•'),
              style_class: 'shcalendar-event-badge' + (evObj.holiday ? ' holiday' : '')
            });
            evItemBox.add_child(evBadge);

            let evLabel = new St.Label({
              text: Str.numbersFormat(evObj.event.trim()),
              x_expand: true,
              style_class: 'shcalendar-event-text' + (evObj.holiday ? ' holiday' : '')
            });
            evLabel.clutter_text.line_wrap = true;
            evLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            evItemBox.add_child(evLabel);

            _eventsBox.add_child(evItemBox);
          }
        }

        this._renderPersonalEventRows(_eventsBox, selPersonal);
        this._verifyPersonalEvents(selPersonal);

        this._buildAddEventArea(_eventsBox);
      }

    } else if (this._selectedTab === 'dateConvert') {
      let _converterRoot = new St.BoxLayout({ vertical: true, style_class: 'shcalendar-converter-container' });
      if (typeof _scrollBox.set_child === 'function') {
        _scrollBox.set_child(_converterRoot);
      } else {
        _scrollBox.add_child(_converterRoot);
      }

      const ConverterTypes = {
        fromPersian: 0,
        fromGregorian: 1,
        fromIslamic: 2
      };
      let _activeConverter = this._converterState.type;
      let convertedDatesVbox = new St.BoxLayout({ vertical: true, style_class: 'shcalendar-converter-results' });

      let converterYear = new St.Entry({
        hint_text: _('سال (مثال: ۱۴۰۴)'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });
      let converterMonth = new St.Entry({
        hint_text: _('ماه (۱-۱۲)'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });
      let converterDay = new St.Entry({
        hint_text: _('روز (۱-۳۱)'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });

      const _onModifyConverter = () => {
        convertedDatesVbox.destroy_all_children();

        let year = converterYear.get_text();
        let month = converterMonth.get_text();
        let day = converterDay.get_text();
        Object.assign(this._converterState, { year, month, day });

        if (!day || !month || !year) return;

        [year, month, day] = [year, month, day].map(Str.parseInteger);

        let cDateObj = new Tarikh.TarikhObject();
        let checkInputDate = false;

        switch (_activeConverter) {
          case ConverterTypes.fromGregorian:
            checkInputDate = Tarikh.check_gregorian(year, month, day, true);
            if (checkInputDate) cDateObj.gregorian = [year, month, day];
            break;
          case ConverterTypes.fromPersian:
            checkInputDate = Tarikh.check_persian(year, month, day, true);
            if (checkInputDate) cDateObj.persian = [year, month, day];
            break;
          case ConverterTypes.fromIslamic:
            checkInputDate = Tarikh.check_islamic(year, month, day, true);
            if (checkInputDate) cDateObj.islamic = [year, month, day];
            break;
          default:
            return;
        }

        if (!checkInputDate || cDateObj.persianYear < 1178 || cDateObj.persianYear > 1633) {
          let errLabel = new St.Label({
            text: _('تاریخ معتبر نیست؛ بازهٔ پشتیبانی‌شده: سال شمسی ۱۱۷۸ تا ۱۶۳۳'),
            style_class: 'shcalendar-converter-error'
          });
          convertedDatesVbox.add_child(errLabel);
          return;
        }

        let pDateStr = Str.numbersFormat(
          Str.dateStrFormat(
            this.schema.get_string('persian-display-format'),
            cDateObj.persianDay,
            cDateObj.persianMonth,
            cDateObj.persianYear,
            cDateObj.dayOfWeek,
            'persian'
          )
        ) + ' ' + _('هـ.ش');

        let gDateStr = Str.dateStrFormat(
          this.schema.get_string('gregorian-display-format'),
          cDateObj.gregorianDay,
          cDateObj.gregorianMonth,
          cDateObj.gregorianYear,
          cDateObj.dayOfWeek,
          'gregorian'
        ) + ' ' + _('میلادی');

        let hDateStr = Str.numbersFormat(
          Str.dateStrFormat(
            this.schema.get_string('islamic-display-format'),
            cDateObj.islamicDay,
            cDateObj.islamicMonth,
            cDateObj.islamicYear,
            cDateObj.dayOfWeek,
            'islamic'
          )
        ) + ' ' + _('هـ.ق');

        let results = [
          { label: pDateStr, copy: pDateStr },
          { label: gDateStr, copy: gDateStr },
          { label: hDateStr, copy: hDateStr }
        ];

        results.forEach(res => {
          let row = new St.BoxLayout({ style_class: 'shcalendar-convert-row' });
          row.set_text_direction(Clutter.TextDirection.RTL);
          let lbl = new St.Label({ text: res.label, x_expand: true, style_class: 'shcalendar-convert-label' });
          let copyBtn = new St.Button({ can_focus: true,
            label: _('کپی'),
            style_class: 'shcalendar-copy-btn'
          });
          copyBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, res.copy);
          });
          row.add_child(lbl);
          row.add_child(copyBtn);
          convertedDatesVbox.add_child(row);
        });

        if (this._selectedDateObj.julianDay !== cDateObj.julianDay) {
          let jumpBtn = new St.Button({ can_focus: true,
            label: _('رفتن به این تاریخ در تقویم'),
            style_class: 'shcalendar-jump-btn'
          });
          jumpBtn.connect('clicked', () => {
            this._selectedDateObj.julianDay = cDateObj.julianDay;
            this._update();
          });
          convertedDatesVbox.add_child(jumpBtn);
        }
      };

      let typeHbox = new St.BoxLayout({ style_class: 'shcalendar-converter-type-bar' });
      let types = [
        { id: ConverterTypes.fromPersian, label: _('از شمسی') },
        { id: ConverterTypes.fromGregorian, label: _('از میلادی') },
        { id: ConverterTypes.fromIslamic, label: _('از قمری') }
      ];

      types.forEach(t => {
        let btn = new St.Button({ can_focus: true,
          label: t.label,
          style_class: 'shcalendar-converter-type-btn' + (t.id === _activeConverter ? ' active' : '')
        });
        btn.connect('clicked', () => {
          _activeConverter = t.id;
          this._converterState.type = t.id;
          typeHbox.get_children().forEach(c => c.remove_style_class_name('active'));
          btn.add_style_class_name('active');
          _onModifyConverter();
        });
        typeHbox.add_child(btn);
      });

      _converterRoot.add_child(typeHbox);

      converterYear.clutter_text.connect('text-changed', _onModifyConverter);
      converterMonth.clutter_text.connect('text-changed', _onModifyConverter);
      converterDay.clutter_text.connect('text-changed', _onModifyConverter);
      const savedConverter = { ...this._converterState };
      for (let [entry, key] of [[converterYear, 'year'], [converterMonth, 'month'], [converterDay, 'day']]) {
        entry.set_text_direction(Clutter.TextDirection.LTR);
        entry.set_text(savedConverter[key]);
      }
      _onModifyConverter();

      let inputsHbox = new St.BoxLayout({ style_class: 'shcalendar-converter-inputs' });
      for (let [label, entry] of [[_('سال'), converterYear], [_('ماه'), converterMonth], [_('روز'), converterDay]]) {
        let column = new St.BoxLayout({ vertical: true, x_expand: true });
        column.add_child(new St.Label({ text: label, x_expand: true, style_class: 'shcalendar-add-event-hint' }));
        entry.accessible_name = label;
        column.add_child(entry);
        inputsHbox.add_child(column);
      }

      _converterRoot.add_child(inputsHbox);
      _converterRoot.add_child(convertedDatesVbox);
    }
    this._alignDetails(this.actorLeft);
    this._setBusy(this._busy);
  }

  _alignDetails = (actor) => {
    actor.set_text_direction(Clutter.TextDirection.RTL);
    if (actor instanceof St.Entry) {
      actor.set_text_direction(actor.hint_text === _('عنوان رویداد') ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR);
      actor.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);
      return;
    }
    if (actor instanceof St.Label) {
      actor.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);
      actor.clutter_text.line_wrap = true;
      actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
      actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }
    for (let child of actor.get_children()) this._alignDetails(child);
  }

  _rotate = (a, b, x, y, Schema) => {
    return (Schema.get_boolean('rotation-to-vertical')) ? [7 - b, 8 - a + 1, y, x] : [a, b, x, y];
  }

  _colPosition = (Schema) => {
    return Schema.get_boolean('reverse-direction') ? 0 : 6;
  }

  destroy() {
    this._destroyed = true;
    this._cancellable.cancel();
    if (this._refreshIdleId) GLib.Source.remove(this._refreshIdleId);
    this._refreshIdleId = 0;
    this._activeCalBtn = null;
    if (this._settingsSignalId) this.schema.disconnect(this._settingsSignalId);
    if (this.googleSync && this._syncListener) {
      this.googleSync.removeListener(this._syncListener);
      this._syncListener = null;
    }
    this.actor.destroy();
  }
}
