import { actionButton, centeredProgress, element, iconElement, informativeState, topBar } from '../ui/widgets';

/// מסך הפתיחה של התוסף — שיקוף של LibrarySetupView
/// (lib/empty_library/empty_library_screen.dart): אייקון 64, כותרת 24 מודגשת,
/// הסבר 16 ב-onSurfaceVariant וכפתור מומלץ ברוחב מלא.
///
/// שירות החיפוש המקומי מוצג באותו דפוס שאוצריא מציגה בו מצבי אין-תוצאות:
/// אייקון אזהרה, כותרת, הסבר וכפתור ניטרלי.
export class LibraryScreen {
  readonly root = element('main', 'screen library-screen');
  private readonly body = element('div', 'screen-body library-body');
  private currentHebrewBooksPath: string | null = null;

  constructor(
    private readonly handlers: {
      readonly onSearch: () => void;
      readonly onRetry: () => void;
    },
  ) {
    const bar = topBar();
    bar.center.append(element('h1', 'top-bar-title', 'היברובוקס'));
    this.root.append(bar.root, this.body);
  }

  showChecking(): void {
    this.body.replaceChildren(centeredProgress());
  }

  setHebrewBooksPath(path: string | null): void {
    this.currentHebrewBooksPath = path;
    const el = this.body.querySelector('.library-hebrewbooks-path-status');
    if (el) {
      el.textContent = formatHebrewBooksPathStatus(path);
    }
  }

  showReady(statusText: string, hebrewBooksPath?: string | null): void {
    if (hebrewBooksPath !== undefined) {
      this.currentHebrewBooksPath = hebrewBooksPath;
    }
    const view = element('section', 'library-setup-view');
    view.append(iconElement('library_24_regular', 64, 'icon hero-icon'));
    view.append(element('h2', undefined, 'ספריית היברובוקס'));
    view.append(
      element(
        'p',
        undefined,
        'עשרות אלפי ספרים סרוקים מהיברובוקס, זמינים לחיפוש ולעיון.\n' +
          'החיפוש מתבצע בשירות היברובוקס, והספר נפתח כאן בקורא ה-PDF.',
      ),
    );
    view.append(
      actionButton({
        text: 'חפש בהיברובוקס',
        variant: 'recommended',
        icon: 'search_24_regular',
        fullWidth: true,
        centeredLabel: true,
        onClick: this.handlers.onSearch,
      }),
    );
    view.append(element('p', 'library-status', statusText));
    view.append(
      element(
        'p',
        'library-hebrewbooks-path-status',
        formatHebrewBooksPathStatus(this.currentHebrewBooksPath),
      ),
    );
    this.body.replaceChildren(view);
  }

  showOffline(message: string, hebrewBooksPath?: string | null): void {
    if (hebrewBooksPath !== undefined) {
      this.currentHebrewBooksPath = hebrewBooksPath;
    }
    const infoState = informativeState({
      icon: 'warning_24_regular',
      title: 'שירות החיפוש אינו זמין',
      message,
      action: { text: 'בדוק שוב', icon: 'search_24_regular', onClick: this.handlers.onRetry },
    });
    infoState.append(
      element(
        'p',
        'library-hebrewbooks-path-status',
        formatHebrewBooksPathStatus(this.currentHebrewBooksPath),
      ),
    );
    this.body.replaceChildren(infoState);
  }
}

export function formatHebrewBooksPathStatus(path: string | null | undefined): string {
  if (typeof path === 'string' && path.trim() !== '') {
    return `מיקום ספרי היברובוקס באוצריא: הוגדר (${path.trim()})`;
  }
  return 'מיקום ספרי היברובוקס באוצריא: לא הוגדר';
}
