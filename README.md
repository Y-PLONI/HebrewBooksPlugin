# תוסף HebrewBooks לאוצריא

תוסף לחיפוש מאוחד באינדקס אוצריא ובספריית HebrewBooks, ולקריאת PDF באמצעות
PDF.js, בעיצוב תואם אוצריא.

## שלושת המסכים ומה הם משקפים

| מסך התוסף | הווידג'ט המקביל באוצריא |
|-----------|--------------------------|
| מסך פתיחה ("ספרייה ריקה") | `lib/empty_library/empty_library_screen.dart` — `LibrarySetupView` |
| תוצאות חיפוש מאוחדות | `lib/search/view/tantivy_full_text_search.dart` + `tantivy_search_results.dart` |
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
# http://127.0.0.1:8080/?screen=library | results | unified | dialog | viewer
# פרמטרים נוספים: &mode=dark, &tab=navigation|search|thumbnails
```

לצילום מסך אוטומטי (headless Chrome עם המתנה אמיתית, כי `--virtual-time-budget`
אינו מריץ את ה-Web Worker של PDF.js):

```bash
node tools/screenshot.mjs "http://127.0.0.1:8080/?screen=viewer" shot.png 1400 900 7000
```

## תלות בשירות המקומי

התוסף פונה ל־`http://127.0.0.1:8080`. חיפוש דורש את הנתיבים `/health`,
`/search` ו־`/inbook`, שזמינים ב־`hbsearch-min` הרשמי. מציג ה־PDF שנשמר
בתוסף דורש בנוסף `/pdf/<fileId>` ושירות שמצהיר ב־`/health` על `apiVersion` 2
ועל capability בשם `pdf-range`; ה־runtime הרשמי עדיין אינו מספק אותם. כרגע
ספרי HebrewBooks נפתחים במציג המובנה של אוצריא, ולכן מגבלה זו אינה חוסמת את
החיפוש המאוחד.

החיפוש המאוחד דורש אוצריא 0.9.97 ומעלה. סימון "חפש גם בהיברובוקס" מפעיל
במקביל את האינדקס המקומי של אוצריא ואת שירות HebrewBooks. ספרי HebrewBooks
שנמצאה להם מהדורה מקבילה מקבלים את קטגוריית אוצריא; היתר מוצגים תחת
"ספרי היברובוקס". כפתור "טען עוד תוצאות" מתקדם בנפרד באינדקס אוצריא
ובחלון התוצאות של HebrewBooks; התוצאות החדשות נוספות לקיימות ללא כפילויות.

## מתקין Windows ופרסום

ה־workflow ב־`.github/workflows/release.yml` רץ בכל `push`, בודק את הקוד ובונה
שני artifacts: קובץ `.otzplugin` ומתקין Inno Setup. בענף `main` הוא גם מפעיל
את הוולידטור הרשמי, מפרסם את התוסף לחנות ויוצר GitHub Release שמכיל את שני
הקבצים. לפרסום בחנות יש להגדיר ב־GitHub את הסודות `OTZARIA_USER`
ו־`OTZARIA_PASSWORD`; לפני כל פרסום יש להעלות את הגרסה ב־`manifest.json`.

המתקין מוריד את `hbsearch-min.zip` ישירות מה־Release הרשמי של מפתחי
HebrewBooks, ומאמת SHA-256 מקובע לפני האריזה. אם המפתחים מחליפים את ה־asset,
יש לבדוק את הבנייה החדשה ולעדכן את `installer/dependencies.json`; שינוי מרוחק
לא מאומת יכשיל את הבנייה ולא ייכנס למתקין בשקט.

ב־Windows המתקין:

1. מתקין את ה־runtime תחת `Program Files (x86)\Otzaria HebrewBooks Search`.
2. מבקש את תיקיית הנתונים שמכילה `App\Katalog.db`.
3. מתקין שירות Windows בשם `OtzariaHebrewBooksSearch`, עם הפעלה אוטומטית
   מושהית וניסיון הפעלה מחדש לאחר תקלה.
4. מציע בסיום לפתוח קישור `otzaria://plugin/install-local`, כדי שאוצריא תעתיק
   ותתקין את קובץ התוסף.

הסרת המתקין עוצרת ומסירה את השירות ואת קובצי ה־runtime. היא אינה מסירה את
עותק התוסף שאוצריא כבר התקינה; אותו מסירים דרך מסך התוספים באוצריא.

## מהדורות מקבילות

בעת קריאת ספר טקסט או PDF של HebrewBooks, אוצריא מחשבת מתוך קטלוג ההשוואה
את המהדורות המקבילות ומציגה שני פקדים: פתיחת מהדורת ברירת המחדל ותפריט של
כל המהדורות. החישוב והפתיחה דקלרטיביים ואינם מפעילים את ה־WebView של התוסף.
