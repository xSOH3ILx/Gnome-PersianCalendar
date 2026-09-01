# Translations / ترجمه‌ها

زبان مبدأ رشته‌ها فارسی است. برای افزودن زبان جدید (مثلاً انگلیسی):

```bash
msginit --locale=en --input=po/shamsi-calendar.pot --output=po/en.po
# پس از ترجمه:
mkdir -p src/locale/en/LC_MESSAGES
msgfmt po/en.po -o "src/locale/en/LC_MESSAGES/shamsi-calendar@gnome.scr.ir.mo"
```

برای به‌روزرسانی فایل الگو پس از تغییر کد: `make pot`
