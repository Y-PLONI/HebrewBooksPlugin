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

  showReady(statusText: string): void {
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
    this.body.replaceChildren(view);
  }

  showOffline(message: string): void {
    this.body.replaceChildren(
      informativeState({
        icon: 'warning_24_regular',
        title: 'שירות החיפוש אינו זמין',
        message,
        action: { text: 'בדוק שוב', icon: 'search_24_regular', onClick: this.handlers.onRetry },
      }),
    );
  }
}
