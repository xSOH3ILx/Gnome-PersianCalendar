import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Str } from './otherFunctions.js';
import * as Tarikh from './Tarikh.js';
import * as Events from './Events.js';
import * as EDS from './EDS.js';

export class Calendar {

  constructor(Schema, cssThemeID, setBottomBarText = (text = '') => { }, googleSync = null) {
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

    this.actorRight.connect('scroll-event', this._onScroll);

    this._selectedDateObj = new Tarikh.TarikhObject();
    this._rtl = (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL);
    this._addEventFormOpen = false;
    this._edsCalendars = null;
    this._edsCalIndex = 0;
    this._activeCalBtn = null;
    let defaultTab = this.schema.get_string('default-tab');
    this._selectedTab = (defaultTab === 'prayTimes') ? 'events' : defaultTab;

    this._buildHeader();

    if (this.googleSync) {
      this._syncListener = () => {
        // Don't rebuild the UI while the user is typing in the add-event form
        if (!this._addEventFormOpen) this._update();
      };
      this.googleSync.addListener(this._syncListener);
    }
  }

  _buildHeader = () => {
    this.actorRight.destroy_all_children();

    this._topBox = new St.BoxLayout({
      style_class: 'shcalendar-nav-header'
    });
    this.actorRight.layout_manager.attach(this._topBox, 0, 0, 7, 1);

    let style = 'shcalendar-nav-button';
    // In RTL, the visually left-most button moves forward in time (next year), right-most moves backward (prev year).
    // In LTR, left-most is prev year, right-most is next year.
    let prevYearIcon = new St.Icon({ icon_name: this._rtl ? 'go-last-symbolic' : 'go-first-symbolic', icon_size: 16 });
    let prevYearBtn = new St.Button({ style_class: style, child: prevYearIcon });
    prevYearBtn.connect('clicked', this._rtl ? this._onNextYearButtonClicked : this._onPrevYearButtonClicked);
    this._topBox.add_child(prevYearBtn);

    let prevMonthIcon = new St.Icon({ icon_name: this._rtl ? 'go-next-symbolic' : 'go-previous-symbolic', icon_size: 16 });
    let prevMonthBtn = new St.Button({ style_class: style, child: prevMonthIcon });
    prevMonthBtn.connect('clicked', this._rtl ? this._onNextMonthButtonClicked : this._onPrevMonthButtonClicked);
    this._topBox.add_child(prevMonthBtn);

    this._monthLabel = new St.Label({
      style_class: 'shcalendar-month-label',
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: true
    });
    this._topBox.add_child(this._monthLabel);

    let nextMonthIcon = new St.Icon({ icon_name: this._rtl ? 'go-previous-symbolic' : 'go-next-symbolic', icon_size: 16 });
    let nextMonthBtn = new St.Button({ style_class: style, child: nextMonthIcon });
    nextMonthBtn.connect('clicked', this._rtl ? this._onPrevMonthButtonClicked : this._onNextMonthButtonClicked);
    this._topBox.add_child(nextMonthBtn);

    let nextYearIcon = new St.Icon({ icon_name: this._rtl ? 'go-first-symbolic' : 'go-last-symbolic', icon_size: 16 });
    let nextYearBtn = new St.Button({ style_class: style, child: nextYearIcon });
    nextYearBtn.connect('clicked', this._rtl ? this._onPrevYearButtonClicked : this._onNextYearButtonClicked);
    this._topBox.add_child(nextYearBtn);

    let todayBtn = new St.Button({
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
      case Clutter.ScrollDirection.LEFT:
        this._onNextMonthButtonClicked();
        break;
      case Clutter.ScrollDirection.DOWN:
      case Clutter.ScrollDirection.RIGHT:
        this._onPrevMonthButtonClicked();
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
      let addBtn = new St.Button({
        label: _('+ افزودن رویداد'),
        style_class: 'shcalendar-add-event-btn',
        x_expand: true
      });
      addBtn.connect('clicked', () => {
        this._addEventFormOpen = true;
        this._loadEdsCalendars();
        this._update();
      });
      addBox.add_child(addBtn);
    } else {
      let form = new St.BoxLayout({ vertical: true, style_class: 'shcalendar-add-event-form' });
      form.set_text_direction(Clutter.TextDirection.RTL);

      let titleEntry = new St.Entry({
        hint_text: _('عنوان رویداد'),
        can_focus: true,
        x_expand: true,
        style_class: 'shcalendar-converter-entry'
      });
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
      timeRow.add_child(startEntry);
      timeRow.add_child(endEntry);
      form.add_child(timeRow);

      let timeHint = new St.Label({
        text: _('ساعت‌ها را خالی بگذارید تا رویداد تمام‌روز ثبت شود'),
        style_class: 'shcalendar-add-event-hint'
      });
      form.add_child(timeHint);

      let calName = this._edsCalendars?.[this._edsCalIndex]?.name ?? _('پیش‌فرض سیستم');
      let calBtn = new St.Button({
        label: _('تقویم:') + ' ' + calName,
        style_class: 'shcalendar-add-event-cal',
        x_expand: true
      });
      calBtn.connect('clicked', () => {
        if (this._edsCalendars && this._edsCalendars.length > 1) {
          this._edsCalIndex = (this._edsCalIndex + 1) % this._edsCalendars.length;
          calBtn.set_label(_('تقویم:') + ' ' + this._edsCalendars[this._edsCalIndex].name);
        }
      });
      this._activeCalBtn = calBtn;
      form.add_child(calBtn);

      let btnRow = new St.BoxLayout({ style_class: 'shcalendar-add-event-actions' });
      btnRow.set_text_direction(Clutter.TextDirection.RTL);
      let saveBtn = new St.Button({ label: _('ذخیره'), style_class: 'shcalendar-add-event-save', x_expand: true });
      let cancelBtn = new St.Button({ label: _('انصراف'), style_class: 'shcalendar-add-event-cancel', x_expand: true });
      btnRow.add_child(saveBtn);
      btnRow.add_child(cancelBtn);
      form.add_child(btnRow);

      saveBtn.connect('clicked', () => {
        this._savePersonalEvent(titleEntry.get_text(), startEntry.get_text(), endEntry.get_text());
      });
      cancelBtn.connect('clicked', () => {
        this._addEventFormOpen = false;
        this._activeCalBtn = null;
        this._update();
      });

      addBox.add_child(form);
    }

    parentBox.add_child(addBox);
  }

  _loadEdsCalendars = () => {
    if (this._edsCalendars) return;
    EDS.listCalendars().then(cals => {
      if (cals.length === 0) return;
      this._edsCalendars = cals;
      let idx = cals.findIndex(c => c.uid === 'system-calendar');
      this._edsCalIndex = idx >= 0 ? idx : 0;
      // Update the open form's calendar button in place (no rebuild, keeps typed text)
      if (this._activeCalBtn) {
        this._activeCalBtn.set_label(_('تقویم:') + ' ' + cals[this._edsCalIndex].name);
      }
    }).catch(e => {
      console.error('ShamsiCalendar: EDS listCalendars failed:', e);
    });
  }

  _parseTimeText = (txt) => {
    txt = (txt ?? '').trim();
    if (txt === '') return null;
    txt = txt
      .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    let m = txt.match(/^(\d{1,2})(?:[:.،](\d{1,2}))?$/);
    if (!m) return NaN;
    let h = parseInt(m[1], 10);
    let mi = m[2] !== undefined ? parseInt(m[2], 10) : 0;
    if (h > 23 || mi > 59) return NaN;
    return h * 60 + mi;
  }

  _savePersonalEvent = (title, startTxt, endTxt) => {
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

    let calUid = this._edsCalendars?.[this._edsCalIndex]?.uid ?? 'system-calendar';
    this.setBottomBarText(_('در حال ذخیره…'));

    EDS.createEvent({
      calUid,
      summary: title,
      gy: this._selectedDateObj.gregorianYear,
      gm: this._selectedDateObj.gregorianMonth,
      gd: this._selectedDateObj.gregorianDay,
      startMin,
      endMin
    }).then(() => {
      this._addEventFormOpen = false;
      this._activeCalBtn = null;
      this.setBottomBarText(_('رویداد ذخیره شد ✓'));
      if (this.googleSync) this.googleSync.requestRange();
      this._update();
    }).catch(e => {
      console.error('ShamsiCalendar: createEvent failed:', e);
      this.setBottomBarText(_('خطا در ذخیرهٔ رویداد — جزئیات در journalctl'));
    });
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
    let weekStart = parseInt(this.schema.get_string('week-start'));
    let dateDisplay = {
      persian: this.schema.get_boolean('persian-display'),
      islamic: this.schema.get_boolean('islamic-display'),
      gregorian: this.schema.get_boolean('gregorian-display')
    };

    let children = this.actorRight.get_children();
    for (let i = this._firstDayIndex; i < children.length; i++) {
      children[i].destroy();
    }

    const weekdayAbbr = ['ش', '۱ش', '۲ش', '۳ش', '۴ش', '۵ش', 'ج'];
    for (let i = weekStart; i < (weekStart + 7); i++) {
      let label = new St.Label({
        style_class: 'shcalendar-day-heading shcalendar-rtl',
        text: weekdayAbbr[i % 7]
      });
      let [left, top, width, height] = this._rotate(
        Math.abs(this._colPosition(this._rtl, this.schema) - ((7 + i - weekStart) % 7)),
        1, 1, 1,
        this.schema
      );
      this.actorRight.layout_manager.attach(label, left, top, width, height);
    }

    this.actorLeft.destroy_all_children();
    let nowObj = new Tarikh.TarikhObject();

    this._monthLabel.text = `${Tarikh.mName.shamsi[this._selectedDateObj.persianMonth]} ${Str.numbersFormat(this._selectedDateObj.persianYear)}`;

    // Accurate start of the month grid alignment
    let iterObj = new Tarikh.TarikhObject();
    iterObj.julianDay = this._selectedDateObj.julianDay;
    iterObj.persianDay = 1;
    let offset = (iterObj.dayOfWeek - weekStart + 7) % 7;
    iterObj.julianDay -= offset;

    let row = 2;
    let selectedDateEvents = [[], false];
    let afterSelectedDateEvents = [[], false];

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

      let dayButton = new St.Button({
        child: datesOfDay,
        style_class: 'shcalendar-day-button'
      });

      if (isOtherMonth) dayButton.add_style_class_name('other-month');
      if (isToday) dayButton.add_style_class_name('today');
      if (isSelected) {
        dayButton.add_style_class_name('selected');
        selectedDateEvents = events;
      }
      if (isHoliday) dayButton.add_style_class_name('holiday');

      let iterObj_julianDay = iterObj.julianDay;
      dayButton.connect('clicked', () => {
        this._selectedDateObj.julianDay = iterObj_julianDay;
        this._update();
      });

      if (iterObj.julianDay === (this._selectedDateObj.julianDay + 1)) {
        afterSelectedDateEvents = events;
      }

      let [left, top, width, height] = this._rotate(
        Math.abs(this._colPosition(this._rtl, this.schema) - ((7 + iterObj.dayOfWeek - weekStart) % 7)),
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

    if (!selectedDateEvents || selectedDateEvents[0].length === 0) {
      let _currObj = new Tarikh.TarikhObject();
      _currObj.julianDay = this._selectedDateObj.julianDay;
      selectedDateEvents = new Events.Events(_currObj, this.schema, this.googleSync).getEvents();
    }

    if (!afterSelectedDateEvents || afterSelectedDateEvents[0].length === 0) {
      let _iterObj = new Tarikh.TarikhObject();
      _iterObj.julianDay = this._selectedDateObj.julianDay + 1;
      afterSelectedDateEvents = new Events.Events(_iterObj, this.schema, this.googleSync).getEvents();
    }

    // Left Panel - Selected Date Card & Details
    let _datesBox = new St.BoxLayout({
      vertical: true,
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
      x_align: Clutter.ActorAlign.CENTER,
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
        x_align: Clutter.ActorAlign.CENTER,
        style_class: 'shcalendar-card-pdate'
      });
      _datesBox.add_child(pLabel);
    }

    if (dateDisplay.islamic || dateDisplay.gregorian) {
      let subDatesHbox = new St.BoxLayout({
        vertical: false,
        x_align: Clutter.ActorAlign.CENTER,
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

      if (dateDisplay.islamic && dateDisplay.gregorian) {
        subDatesHbox.add_child(new St.Label({ text: '  |  ', style_class: 'shcalendar-card-sep' }));
      }

      if (dateDisplay.gregorian) {
        let gLabel = new St.Label({
          text: Str.dateStrFormat(
            this.schema.get_string('gregorian-display-format'),
            this._selectedDateObj.gregorianDay,
            this._selectedDateObj.gregorianMonth,
            this._selectedDateObj.gregorianYear,
            this._selectedDateObj.dayOfWeek,
            'gregorian'
          ) + ' M',
          style_class: 'shcalendar-card-gdate'
        });
        subDatesHbox.add_child(gLabel);
      }

      _datesBox.add_child(subDatesHbox);
    }

    let evTopPosition = 0;

    // Tabs Header
    let _tabContainer = new St.BoxLayout({
      style_class: 'shcalendar-tab-bar'
    });
    // Persian UI: first tab belongs on the right, regardless of system locale
    _tabContainer.set_text_direction(Clutter.TextDirection.RTL);

    let tabs = {
      events: _('مناسبت‌ها و رویدادها'),
      dateConvert: _('تبدیل تاریخ')
    };

    for (let tabKey in tabs) {
      let tabBtn = new St.Button({
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
      overlay_scrollbars: true,
      enable_mouse_scrolling: true,
      hscrollbar_policy: St.PolicyType ? St.PolicyType.NEVER : 2,
      style_class: 'shcalendar-events-scrollable'
    });
    this.actorLeft.layout_manager.attach(_scrollBox, 0, ++evTopPosition, 1, 1);

    if (this._selectedTab === 'events') {
      let _eventsBox = new St.BoxLayout({ vertical: true, style_class: 'shcalendar-events-layout' });
      if (typeof _scrollBox.set_child === 'function') {
        _scrollBox.set_child(_eventsBox);
      } else {
        _scrollBox.add_child(_eventsBox);
      }

      if (selectedDateEvents[0].length === 0) {
        let emptyLabel = new St.Label({
          text: _('مناسبت یا رویدادی برای این روز ثبت نشده است.'),
          x_align: Clutter.ActorAlign.CENTER,
          x_expand: true,
          style_class: 'shcalendar-empty-event-label'
        });
        _eventsBox.add_child(emptyLabel);
      } else {
        for (let evObj of selectedDateEvents[0]) {
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

      this._buildAddEventArea(_eventsBox);

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
      let _activeConverter = ConverterTypes.fromPersian;
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

      const enNum = (faNum_) => {
        let faNum = "" + faNum_;
        let fa = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
        let out = "";
        for (let i in faNum) {
          out += (fa[faNum[i]] !== undefined) ? fa[faNum[i]] : faNum[i];
        }
        return out;
      };

      const _onModifyConverter = () => {
        convertedDatesVbox.destroy_all_children();

        let year = converterYear.get_text();
        let month = converterMonth.get_text();
        let day = converterDay.get_text();

        if (!day || !month || !year) return;

        [year, month, day] = [parseInt(enNum(year)), parseInt(enNum(month)), parseInt(enNum(day))];
        if (isNaN(year) || isNaN(month) || isNaN(day)) return;

        let cDateObj = new Tarikh.TarikhObject();
        let checkInputDate = false;

        switch (_activeConverter) {
          case ConverterTypes.fromGregorian:
            checkInputDate = Tarikh.check_gregorian(year, month, day, false);
            if (checkInputDate) cDateObj.gregorian = [year, month, day];
            break;
          case ConverterTypes.fromPersian:
            checkInputDate = Tarikh.check_persian(year, month, day, false);
            if (checkInputDate) cDateObj.persian = [year, month, day];
            break;
          case ConverterTypes.fromIslamic:
            checkInputDate = Tarikh.check_islamic(year, month, day, false);
            if (checkInputDate) cDateObj.islamic = [year, month, day];
            break;
          default:
            return;
        }

        if (!checkInputDate) {
          let errLabel = new St.Label({
            text: _('تاریخ وارد شده در تقویم معتبر نیست!'),
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
          let copyBtn = new St.Button({
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
          let jumpBtn = new St.Button({
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
        let btn = new St.Button({
          label: t.label,
          style_class: 'shcalendar-converter-type-btn' + (t.id === _activeConverter ? ' active' : '')
        });
        btn.connect('clicked', () => {
          _activeConverter = t.id;
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

      let inputsHbox = new St.BoxLayout({ style_class: 'shcalendar-converter-inputs' });
      inputsHbox.add_child(converterYear);
      inputsHbox.add_child(converterMonth);
      inputsHbox.add_child(converterDay);

      _converterRoot.add_child(inputsHbox);
      _converterRoot.add_child(convertedDatesVbox);
    }
  }

  _rotate = (a, b, x, y, Schema) => {
    return (Schema.get_boolean('rotation-to-vertical')) ? [7 - b, 8 - a + 1, y, x] : [a, b, x, y];
  }

  _colPosition = (rtl, Schema) => {
    return ((
      Schema.get_boolean('reverse-direction') && rtl ||
      !Schema.get_boolean('reverse-direction') && !rtl
    ) ? 6 : 0);
  }

  destroy() {
    if (this.googleSync && this._syncListener) {
      this.googleSync.removeListener(this._syncListener);
      this._syncListener = null;
    }
    this.actor.destroy();
  }
}
