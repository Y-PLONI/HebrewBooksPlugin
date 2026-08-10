# תוסף HebrewBooks לאוצריא

בסיס תוסף לחיפוש בספריית HebrewBooks ולקריאת PDF באמצעות PDF.js, בעיצוב תואם אוצריא.

ה־UI משתמש ב־Segoe UI המקומי, בארבעה משקלים/סגנונות, כפי שנעשה בתוסף `iyun_h-halacha_plugin`.

## פיתוח

```bash
npm install
npm run check
npm test
npm run build
```

התוצר נכתב אל `dist/`. אפשר לטעון את התיקייה הזו במסך פיתוח התוספים של אוצריא, או לארוז אותה:

```bash
dart /path/to/otzaria/tool/plugins/package_plugin.dart dist --force
```

## תלות בשירות המקומי

התוסף פונה ל־`http://127.0.0.1:8080` ומצפה לנתיבים `/health`, `/search`, `/inbook` ו־`/pdf/<fileId>`. הקורא דורש שירות שמצהיר ב־`/health` על `apiVersion` 2 ועל capability בשם `pdf-range`.

הרחבת השירות ומנגנון ההזרקה העתידי של אוצריא אינם חלק מבסיס זה.
