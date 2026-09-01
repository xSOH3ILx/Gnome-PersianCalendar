<div dir="rtl">

# 📅 تقویم فارسی گنوم — Gnome-PersianCalendar

افزونه‌ی تقویم هجری شمسی (جلالی) برای GNOME Shell ۴۶ تا ۵۰ — مدرن، سبک و منطبق بر Libadwaita.

## ✨ امکانات

- نمایش تاریخ شمسی در نوار بالا با قالب و موقعیت و رنگ دلخواه
- تقویم ماهانه با نمایش همزمان تاریخ شمسی، قمری و میلادی
- مناسبت‌ها و تعطیلات رسمی (شمسی، قمری، میلادی، جشن‌های کهن ایرانی)
- همگام‌سازی با Google Calendar و رویدادهای سیستم (GNOME Online Accounts)
- ابزار تبدیل تاریخ شمسی ↔ میلادی ↔ قمری
- اعلان مناسبت‌های روز و لحظه‌ی تحویل سال
- زیرساخت ترجمه (gettext) برای زبان‌های دیگر

## 📦 نصب

### روش ۱: اسکریپت نصب

</div>

```bash
git clone https://github.com/xSOH3ILx/Gnome-PersianCalendar.git
cd Gnome-PersianCalendar
./install.sh
```

<div dir="rtl">

### روش ۲: Makefile (بسته‌بندی استاندارد)

</div>

```bash
make install
```

<div dir="rtl">

سپس در Wayland یک‌بار از حساب خارج و وارد شوید و افزونه را فعال کنید:

</div>

```bash
gnome-extensions enable shamsi-calendar@gnome.scr.ir
```

<div dir="rtl">

## 🗂 ساختار پروژه

</div>

```text
Gnome-PersianCalendar/
├── src/                  # کد افزونه (extension.js, calendar.js, prefs.js, ...)
│   ├── schemas/          # GSettings schema
│   └── events/           # داده‌ی مناسبت‌ها
├── tests/                # تست‌های موتور تبدیل تاریخ
├── po/                   # فایل‌های ترجمه (gettext)
├── docs/                 # مستندات و تصاویر
├── Makefile              # pack / install / test / lint / pot
└── .github/workflows/    # CI
```

<div dir="rtl">

## 🛠 توسعه

</div>

```bash
npm install        # فقط برای lint
make test          # تست‌های خودکار
make lint          # ESLint
make pot           # به‌روزرسانی رشته‌های ترجمه
make pack          # ساخت بسته‌ی قابل نصب در build/
```

<div dir="rtl">

## 📜 مجوز و قدردانی

این پروژه تحت مجوز [GPL-3.0](LICENSE) منتشر می‌شود و بر پایه‌ی پروژه‌ی [gnome-shamsi-calendar](https://github.com/SCR-IR/gnome-shamsi-calendar) از SCR-IR بازسازی و بازطراحی شده است.

</div>
