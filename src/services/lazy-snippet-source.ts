import type { SnippetSource } from './external-search-server';

/// המקום שחבילת הגזירים מציבה בו את המחלץ ברגע שהיא נטענת.
export const snippetSourceGlobalKey = 'hebrewBooksSnippetSource';

function installedSource(): SnippetSource | null {
  const value = (globalThis as Record<string, unknown>)[snippetSourceGlobalKey] as
    | SnippetSource
    | undefined;
  return typeof value?.load === 'function' ? value : null;
}

/// תגית <script> קלאסית היא הדרך היחידה למשוך קוד נוסף לדף של התוסף: הוא
/// נטען מ-file://, שם WebView2 חוסם גם import() דינמי וגם Worker.
export function appendScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error(`טעינת ${src} נכשלה`)), { once: true });
    document.head.append(script);
  });
}

/// SnippetSource שמושך את חבילת pdf.js רק בגזיר הראשון שבאמת נדרש. כך מופע
/// הרקע עולה על חבילה קטנה ובכל זאת מגיש קטעי טקסט למדור החיצוני.
export function lazySnippetSource(
  src: string,
  append: (src: string) => Promise<void> = appendScript,
): SnippetSource {
  let ready: Promise<SnippetSource | null> | null = null;
  const loadBundle = async (): Promise<SnippetSource> => {
    const already = installedSource();
    if (already) return already;
    await append(src);
    const loaded = installedSource();
    if (!loaded) throw new Error(`${src} נטען בלי להתקין מחלץ גזירים`);
    return loaded;
  };
  // ניסיון אחד בלבד: תחת file:// נתיב שנכשל ייכשל גם בפעם המאה, ובינתיים כל
  // תוצאה בעמוד הייתה מזריקה <script> נוסף.
  const resolveOnce = (): Promise<SnippetSource | null> =>
    (ready ??= loadBundle().catch((error: unknown) => {
      console.warn(`snippet bundle: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }));
  return {
    prepare: () => resolveOnce().then((source) => source !== null),
    load: (url, fileId, pageNumber, query) =>
      resolveOnce().then((source) => source?.load(url, fileId, pageNumber, query) ?? null),
  };
}
