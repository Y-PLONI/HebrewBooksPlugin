# תוסף HebrewBooks לאוצריא

בסיס תוסף לחיפוש בספריית HebrewBooks ולקריאת PDF באמצעות PDF.js, בעיצוב תואם אוצריא.

## שלושת המסכים ומה הם משקפים

| מסך התוסף | הווידג'ט המקביל באוצריא |
|-----------|--------------------------|
| מסך פתיחה ("ספרייה ריקה") | `lib/empty_library/empty_library_screen.dart` — `LibrarySetupView` |
| תוצאות חיפוש | `lib/search/view/tantivy_full_text_search.dart` + `tantivy_search_results.dart` |
| דיאלוג החיפוש | `lib/search/view/search_dialog.dart` |
| מסך PDF | `lib/pdf_book/view/pdf_book_screen.dart` (עם `pdf_zoom_bar`, `pdf_scrollbar`, `pdf_thumbnails_screen`, `pdf_outlines_screen`) |

### כיצד נשמרת ההתאמה

* **מידות וצורות** — כל מספר ב-`src/styles.css` נלקח מהווידג'ט המקביל, והמקור
  מצוין בהערה לידו (גובה סרגל 56/44, רדיוס 8 מ-`AppTokens`, כפתורי סרגל 40/36,
  כרטיס תוצאה עם מסגרת `outline` ב-30% וכו').
* **צבעים** — אין צבע קשיח בקוד למעט אלה שקשיחים גם באוצריא (`AppColors`,
  וצבעי סרגל הזום). כל השאר מגיע מ-`theme` דרך ה-API והופך ל-CSS custom
  properties בשמות תפקידי Material 3 (`src/theme.ts`), כולל גזירת משטחי
  `AppSurfaces` (רקע קריאה, רקע לוח, רקע כרטיס) לפי מצב בהיר/כהה.
* **אייקונים** — מחולצים מאותן ספריות שאוצריא מציירת מהן: גופן
  FluentUI System Icons וקובצי ה-SVG של `otzaria_icons`. `tools/extract_icons.py`
  מייצר מהם את `src/icons.generated.ts` (הפלט נשמר בגיט; אין צורך להריץ בכל build).
* **גופנים** — הממשק ב-Segoe UI הארוז בתוסף; טקסט הספר (למשל שורות התוצאות
  בחלונית החיפוש שבמסך ה-PDF) משתמש בגופן ובגודל שמגיעים ב-`theme.typography`,
  שעבורם אוצריא מזריקה `@font-face` ל-WebView.

## פיתוח

```bash
npm install
npm run verify
```

התוצר נכתב אל `dist/`. אפשר לטעון את התיקייה הזו במסך פיתוח התוספים של אוצריא, או לארוז אותה:

```bash
dart /path/to/otzaria/tool/plugins/package_plugin.dart dist --force
```

### תצוגה מקדימה בדפדפן

`tools/preview-server.mjs` מגיש את `dist/` יחד עם שירות hbsearch מדומה וגם עם
SDK מדומה (`tools/preview-stub.js`) שכולל את ערכות הצבעים והטיפוגרפיה
האמיתיות של אוצריא — כך שאפשר לבדוק את המסכים בלי התוכנה ובלי השירות:

```bash
python3 tools/make_sample_pdf.py tools/sample.pdf   # נדרש רק בפעם הראשונה
npm run dev
# http://127.0.0.1:8080/?screen=library | results | dialog | viewer
# פרמטרים נוספים: &mode=dark, &tab=navigation|search|thumbnails
```

לצילום מסך אוטומטי (headless Chrome עם המתנה אמיתית, כי `--virtual-time-budget`
אינו מריץ את ה-Web Worker של PDF.js):

```bash
node tools/screenshot.mjs "http://127.0.0.1:8080/?screen=viewer" shot.png 1400 900 7000
```

## תלות בשירות המקומי

התוסף פונה ל־`http://127.0.0.1:8080` ומצפה לנתיבים `/health`, `/search`, `/inbook` ו־`/pdf/<fileId>`. הקורא דורש שירות שמצהיר ב־`/health` על `apiVersion` 2 ועל capability בשם `pdf-range`.

הרחבת השירות ומנגנון ההזרקה העתידי של אוצריא אינם חלק מבסיס זה.
