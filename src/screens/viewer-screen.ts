import type { IconName } from '../icons.generated';
import { PdfDocumentView, type OutlineEntry } from '../viewer/pdf-document-view';
import {
  barButton,
  centeredProgress,
  element,
  iconElement,
  informativeState,
  topBar,
} from '../ui/widgets';

interface ViewerHandlers {
  readonly onBack: () => void;
  readonly onOpenTextEdition: () => void;
  readonly onOpenWebsite: () => void;
  readonly onInBookSearch: (query: string) => void;
}

interface ToolbarAction {
  readonly icon: IconName;
  readonly tooltip: string;
  readonly onClick: () => void;
}

type PaneTab = 'navigation' | 'search' | 'thumbnails';

const paneTabs: ReadonlyArray<{ id: PaneTab; icon: IconName; iconFilled: IconName; label: string }> = [
  { id: 'navigation', icon: 'list_24_regular', iconFilled: 'list_24_filled', label: 'ניווט' },
  { id: 'search', icon: 'search_24_regular', iconFilled: 'search_24_filled', label: 'חיפוש' },
  {
    id: 'thumbnails',
    icon: 'document_multiple_24_regular',
    iconFilled: 'document_multiple_24_filled',
    label: 'דפים',
  },
];

/// מסך הצגת ה-PDF — שיקוף של PdfBookScreen: סרגל עליון עם ניווט ומספר עמוד
/// במרכזו, חלונית צד עם שלוש לשוניות (ניווט / חיפוש / דפים), גלילה רציפה של
/// הדפים, פסי גלילה מותאמים וסרגל זום צף שנעלם לאחר שתי שניות.
export class ViewerScreen {
  readonly root = element('main', 'screen viewer-screen');
  readonly view: PdfDocumentView;

  private readonly body = element('div', 'screen-body viewer-body');
  private readonly pane = element('aside', 'reader-pane closed');
  private readonly paneCard = element('div', 'reader-pane-card');
  private readonly scrim = element('div', 'reader-scrim closed');
  private readonly paneTabsRow = element('div', 'panel-tabs');
  private readonly panelViews = new Map<PaneTab, HTMLElement>();
  private readonly readerMain = element('div', 'reader-main');
  private readonly viewport = element('div', 'pdf-viewport');
  private readonly pagesContainer = element('div', 'pdf-pages');
  private readonly verticalScrollbar = element('div', 'pdf-scrollbar');
  private readonly verticalThumb = element('div', 'pdf-scrollbar-thumb');
  private readonly horizontalScrollbar = element('div', 'pdf-hscrollbar');
  private readonly horizontalThumb = element('div', 'pdf-hscrollbar-thumb');
  private readonly zoomBar = element('div', 'pdf-zoom-bar hidden');
  private readonly zoomValue = element('span', 'zoom-value', '100%');
  private readonly overlay = element('div', 'pdf-loading-overlay');
  private readonly titleElement = element('span', 'top-bar-title');
  private readonly pageDisplay = element('div', 'page-number-display');
  private readonly trailing = element('div', 'top-bar-trailing');
  private readonly paneToggle: HTMLButtonElement;
  private readonly searchField = element('input');
  private readonly searchCount = element('div', 'pane-result-count');
  private readonly searchResults = element('div', 'pane-results');
  private readonly outlineList = element('div', 'outline-list');
  private readonly thumbnailsList = element('div', 'thumbnails-list');

  private activeTab: PaneTab = 'search';
  private paneOpen = false;
  private panePinned = false;
  private zoomBarTimer = 0;
  private matchPages: number[] = [];
  private outlineEntries: OutlineEntry[] = [];
  private thumbnailObserver: IntersectionObserver | null = null;

  constructor(private readonly handlers: ViewerHandlers, workerUrl: string) {
    this.paneToggle = barButton({
      tooltip: 'חיפוש וניווט',
      icon: 'text_continuous_24_regular',
      selected: false,
      onClick: () => this.setPaneOpen(!this.paneOpen),
    });

    const bar = topBar();
    bar.leading.append(
      barButton({
        tooltip: 'חזרה לתוצאות החיפוש',
        icon: 'arrow_left_24_regular',
        mirrored: true,
        onClick: handlers.onBack,
      }),
      this.paneToggle,
    );
    bar.center.append(this.buildNavCenter());
    bar.root.replaceChildren(bar.leading, bar.center, this.trailing);

    this.view = new PdfDocumentView(this.viewport, this.pagesContainer, workerUrl);
    this.view.onChanged = (page, count, zoom) => this.handleViewChanged(page, count, zoom);
    this.view.onScrolled = () => this.syncScrollbars();

    this.buildPane();
    this.buildReaderMain();
    // סדר ה-Row של AdaptiveSidePane כשהפאנל בצד ההתחלה: פאנל, ואחריו התוכן.
    this.body.append(this.pane, this.scrim, this.readerMain);
    this.root.append(bar.root, this.body);
    this.buildToolbar();
    this.updateNavCenter();
    window.addEventListener('resize', () => {
      this.buildToolbar();
      this.updateNavCenter();
      this.view.handleResize();
      this.syncScrollbars();
    });
  }

  /// ReaderNavCenter מצמצם את עצמו כשהמרחב אוזל: מתחת ל-240 עוברים לכפתורים
  /// קומפקטיים, וכשאין מקום ל-4 כפתורים + 80px כותרת — כפתורי הקצה מוסתרים.
  private updateNavCenter(): void {
    const bar = this.root.querySelector('.top-bar');
    const leading = this.root.querySelector('.top-bar-leading');
    if (!bar || !leading) return;
    const available = bar.clientWidth - leading.clientWidth - this.trailing.clientWidth - 16;
    const forceCompact = available < 240;
    const buttonWidth = (forceCompact ? 36 : 40) + 4;
    const showMajor = available >= 4 * buttonWidth + 2 * 4 + 80;
    const navButtonsWidth = (showMajor ? 4 : 2) * buttonWidth + 2 * 4;
    for (const button of this.root.querySelectorAll<HTMLElement>('.nav-major')) {
      button.classList.toggle('hidden', !showMajor);
    }
    this.titleElement.style.maxWidth = `${Math.max(Math.min(available - navButtonsWidth, 340), 0)}px`;
  }

  /// ReaderNavCenter — [ראשון][הקודם] כותרת + מספר עמוד [הבא][אחרון]
  private buildNavCenter(): HTMLElement {
    const center = element('div', 'reader-nav-center');
    const first = barButton({
      tooltip: 'תחילת הספר',
      icon: 'arrow_previous_24_filled',
      onClick: () => this.view.goToPage(1),
    });
    const last = barButton({
      tooltip: 'סוף הספר',
      icon: 'arrow_next_24_filled',
      onClick: () => this.view.goToPage(this.view.pageCount),
    });
    first.classList.add('nav-major');
    last.classList.add('nav-major');
    center.append(
      first,
      barButton({ tooltip: 'הקודם', icon: 'chevron_left_24_regular', onClick: () => this.view.goPreviousPage() }),
      this.titleElement,
      this.pageDisplay,
      barButton({ tooltip: 'הבא', icon: 'chevron_right_24_regular', onClick: () => this.view.goNextPage() }),
      last,
    );
    return center;
  }

  /// ResponsiveActionBar — maxToolbarButtonsForWidth קובע כמה כפתורים גלויים.
  private buildToolbar(): void {
    const actions: ToolbarAction[] = [
      {
        icon: 'document_column_24_regular',
        tooltip: 'פתח ספר במהדורת טקסט',
        onClick: this.handlers.onOpenTextEdition,
      },
      { icon: 'open_24_regular', tooltip: 'פתח באתר היברובוקס', onClick: this.handlers.onOpenWebsite },
      { icon: 'zoom_in_24_regular', tooltip: 'הגדל את התצוגה', onClick: () => this.zoomBy(1.1) },
      { icon: 'zoom_out_24_regular', tooltip: 'הקטן את התצוגה', onClick: () => this.zoomBy(1 / 1.1) },
    ];
    const maximum = Math.max(0, Math.floor((window.innerWidth - 260) / 44));
    const visible = actions.slice(0, Math.max(maximum - 1, 0));
    const hidden = actions.slice(visible.length);

    this.trailing.replaceChildren(
      ...visible.map((action) =>
        barButton({ tooltip: action.tooltip, icon: action.icon, onClick: action.onClick }),
      ),
    );
    if (hidden.length > 0) {
      this.trailing.append(this.buildOverflowButton(hidden));
    }
  }

  private buildOverflowButton(actions: ToolbarAction[]): HTMLElement {
    const wrap = element('div', 'overflow-anchor');
    const menu = element('div', 'overflow-menu hidden');
    for (const action of actions) {
      const item = element('button');
      item.type = 'button';
      item.append(iconElement(action.icon, 18), document.createTextNode(action.tooltip));
      item.addEventListener('click', () => {
        menu.classList.add('hidden');
        action.onClick();
      });
      menu.append(item);
    }
    const button = barButton({
      tooltip: 'פעולות נוספות',
      icon: 'more_horizontal_24_regular',
      onClick: () => menu.classList.toggle('hidden'),
    });
    document.addEventListener('click', (event) => {
      if (!wrap.contains(event.target as Node)) menu.classList.add('hidden');
    });
    wrap.append(button, menu);
    return wrap;
  }

  private buildPane(): void {
    const header = element('div', 'panel-tab-header');
    header.append(this.paneTabsRow);
    const pin = element('button', 'pin-button');
    pin.type = 'button';
    pin.dataset.tooltip = 'נעץ את החלונית';
    pin.setAttribute('aria-pressed', 'false');
    pin.append(iconElement('pin_24_regular', 20));
    pin.addEventListener('click', () => {
      this.panePinned = !this.panePinned;
      pin.setAttribute('aria-pressed', String(this.panePinned));
      pin.replaceChildren(iconElement(this.panePinned ? 'pin_24_filled' : 'pin_24_regular', 20));
    });
    header.append(pin);

    const navigation = element('div', 'panel-view');
    navigation.append(this.outlineList);
    const search = element('div', 'panel-view');
    search.append(this.buildSearchPane());
    const thumbnails = element('div', 'panel-view');
    thumbnails.append(this.thumbnailsList);
    this.panelViews.set('navigation', navigation);
    this.panelViews.set('search', search);
    this.panelViews.set('thumbnails', thumbnails);

    this.paneCard.append(header, navigation, search, thumbnails);
    this.pane.append(this.paneCard);
    this.scrim.addEventListener('click', () => this.setPaneOpen(false));
    this.renderPaneTabs();
    this.setActiveTab('search');
  }

  private buildSearchPane(): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const wrap = element('div', 'pane-search-field-wrap');
    const field = element('div', 'otzaria-search-field');
    field.append(iconElement('search_24_regular', 20, 'icon leading-icon'));
    this.searchField.type = 'search';
    this.searchField.placeholder = 'חפש כאן..';
    this.searchField.setAttribute('aria-label', 'חיפוש בספר');
    this.searchField.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const query = this.searchField.value.trim();
      if (query.length > 0) this.handlers.onInBookSearch(query);
    });
    field.append(this.searchField);
    const clear = element('button', 'pane-action-button');
    clear.type = 'button';
    clear.dataset.tooltip = 'נקה';
    clear.append(iconElement('dismiss_24_regular', 18));
    clear.addEventListener('click', () => {
      this.searchField.value = '';
      this.searchField.focus();
    });
    field.append(clear);
    wrap.append(field);
    fragment.append(wrap, this.searchCount, this.searchResults);
    return fragment;
  }

  private buildReaderMain(): void {
    this.viewport.tabIndex = 0;
    this.viewport.append(this.pagesContainer);
    this.verticalScrollbar.append(this.verticalThumb);
    this.horizontalScrollbar.append(this.horizontalThumb);

    const card = element('div', 'pdf-zoom-bar-card');
    const reset = element('button', 'zoom-reset', 'אפס');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.view.resetZoom();
      this.revealZoomBar();
    });
    const zoomIn = element('button', 'zoom-button');
    zoomIn.type = 'button';
    zoomIn.dataset.tooltip = 'הגדל את התצוגה';
    zoomIn.append(iconElement('add_24_regular', 20));
    zoomIn.addEventListener('click', () => this.zoomBy(1.1));
    const zoomOut = element('button', 'zoom-button');
    zoomOut.type = 'button';
    zoomOut.dataset.tooltip = 'הקטן את התצוגה';
    zoomOut.append(iconElement('subtract_24_regular', 20));
    zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.1));
    card.append(
      reset,
      element('div', 'zoom-divider'),
      zoomIn,
      element('div', 'zoom-divider'),
      zoomOut,
      this.zoomValue,
    );
    this.zoomBar.append(card);

    this.readerMain.append(
      this.viewport,
      this.verticalScrollbar,
      this.horizontalScrollbar,
      this.zoomBar,
      this.overlay,
    );
    this.attachScrollbarDragging();
    this.attachKeyboardNavigation();
  }

  // ── ניהול מצב ────────────────────────────────────────────────────────────

  async openBook(title: string, url: string, matchPages: number[], initialPage: number): Promise<void> {
    this.titleElement.textContent = title;
    this.matchPages = matchPages;
    this.renderMatchPages();
    this.outlineList.replaceChildren(centeredProgress());
    this.thumbnailsList.replaceChildren();
    this.overlay.className = 'pdf-loading-overlay';
    this.overlay.replaceChildren(centeredProgress());
    // ספר שנפתח מתוצאות חיפוש נפתח עם חלונית הצד פתוחה (openLeftPane
    // באוצריא), כדי שרשימת העמודים שנמצאו תהיה גלויה מיד.
    if (matchPages.length > 0) {
      this.setActiveTab('search');
      this.setPaneOpen(true);
    }
    try {
      await this.view.open(url, initialPage);
      this.overlay.classList.add('hidden');
      this.renderOutline(await this.view.outline());
      this.buildThumbnails();
      this.syncScrollbars();
    } catch (error) {
      this.overlay.className = 'pdf-error-overlay';
      this.overlay.replaceChildren(
        informativeState({
          icon: 'warning_24_regular',
          title: 'לא ניתן לפתוח את הספר',
          message: error instanceof Error ? error.message : 'אירעה שגיאה בפתיחת קובץ ה-PDF',
        }),
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    this.thumbnailObserver?.disconnect();
    this.thumbnailObserver = null;
    await this.view.close();
  }

  setMatchPages(pages: number[]): void {
    this.matchPages = pages;
    this.renderMatchPages();
  }

  setSearchQuery(query: string): void {
    this.searchField.value = query;
  }

  private setPaneOpen(open: boolean): void {
    this.paneOpen = open;
    this.pane.classList.toggle('closed', !open);
    this.scrim.classList.toggle('closed', !open);
    this.paneToggle.setAttribute('aria-pressed', String(open));
    this.paneToggle.replaceChildren(
      iconElement(open ? 'text_continuous_24_filled' : 'text_continuous_24_regular', 20),
    );
    window.setTimeout(() => {
      this.updateNavCenter();
      this.view.handleResize();
      this.syncScrollbars();
    }, 320);
  }

  private renderPaneTabs(): void {
    this.paneTabsRow.replaceChildren(
      ...paneTabs.map((tab) => {
        const button = element('button', 'panel-tab');
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(tab.id === this.activeTab));
        button.append(
          iconElement(tab.id === this.activeTab ? tab.iconFilled : tab.icon, 16),
          element('span', undefined, tab.label),
        );
        button.addEventListener('click', () => this.setActiveTab(tab.id));
        return button;
      }),
    );
  }

  private setActiveTab(tab: PaneTab): void {
    this.activeTab = tab;
    this.renderPaneTabs();
    for (const [id, view] of this.panelViews) view.classList.toggle('active', id === tab);
  }

  private handleViewChanged(page: number, count: number, zoom: number): void {
    this.renderPageDisplay(page, count);
    this.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    this.highlightCurrentPage(page);
    this.syncScrollbars();
  }

  /// PageNumberDisplay — "N/M" שלחיצה עליו הופכת אותו לשדה קלט.
  private renderPageDisplay(page: number, count: number): void {
    if (count === 0) {
      this.pageDisplay.replaceChildren();
      return;
    }
    const button = element('button', undefined, `${page}/${count}`);
    button.type = 'button';
    button.dataset.tooltip = 'הזן מספר דף';
    button.addEventListener('click', () => {
      const input = element('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.value = String(page);
      input.placeholder = `1-${count}`;
      input.setAttribute('aria-label', 'מספר דף');
      const commit = (): void => {
        const target = Number.parseInt(input.value, 10);
        if (Number.isFinite(target)) this.view.goToPage(target);
        this.renderPageDisplay(this.view.currentPage, this.view.pageCount);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
      });
      input.addEventListener('blur', () => this.renderPageDisplay(this.view.currentPage, this.view.pageCount));
      this.pageDisplay.replaceChildren(input);
      input.focus();
      input.select();
    });
    this.pageDisplay.replaceChildren(button);
  }

  private zoomBy(factor: number): void {
    this.view.zoomBy(factor);
    this.revealZoomBar();
  }

  /// סרגל הזום מוצג בעקבות פעולת זום ונעלם אחרי שתי שניות (PdfBookBloc).
  private revealZoomBar(): void {
    this.zoomBar.classList.remove('hidden');
    window.clearTimeout(this.zoomBarTimer);
    this.zoomBarTimer = window.setTimeout(() => this.zoomBar.classList.add('hidden'), 2000);
  }

  // ── חלוניות הצד ──────────────────────────────────────────────────────────

  private renderOutline(entries: OutlineEntry[]): void {
    this.outlineEntries = entries;
    if (entries.length === 0) {
      this.outlineList.replaceChildren(element('div', 'outline-empty', 'אין תוכן עניינים'));
      return;
    }
    this.outlineList.replaceChildren(
      ...entries.map((entry) => {
        const item = element('button', `outline-item level-${Math.min(entry.level, 3)}`);
        item.type = 'button';
        item.style.paddingInlineStart = `${16 + entry.level * 24}px`;
        item.append(
          iconElement(entry.level === 0 ? 'book_24_regular' : 'text_bullet_list_24_regular', entry.level === 0 ? 20 : 18),
          element('span', 'outline-title', entry.title),
        );
        if (entry.pageNumber === null) {
          item.disabled = true;
        } else {
          item.addEventListener('click', () => this.view.goToPage(entry.pageNumber ?? 1));
        }
        return item;
      }),
    );
  }

  private renderMatchPages(): void {
    const count = this.matchPages.length;
    this.searchCount.textContent = count === 0 ? '' : `נמצאו ${count} תוצאות`;
    if (count === 0) {
      this.searchResults.replaceChildren(element('div', 'pane-empty', 'אין תוצאות'));
      return;
    }
    this.searchResults.replaceChildren(
      ...this.matchPages.map((page) => {
        const tile = element('button', 'pane-result-tile', `עמוד ${page}`);
        tile.type = 'button';
        tile.dataset.page = String(page);
        tile.addEventListener('click', () => this.view.goToPage(page));
        return tile;
      }),
    );
    this.highlightCurrentPage(this.view.currentPage);
  }

  private buildThumbnails(): void {
    this.thumbnailObserver?.disconnect();
    const items: HTMLElement[] = [];
    for (let page = 1; page <= this.view.pageCount; page += 1) {
      const item = element('button', 'thumbnail-item');
      item.type = 'button';
      item.dataset.page = String(page);
      const frame = element('div', 'thumbnail-frame');
      item.append(frame, element('span', undefined, String(page)));
      item.addEventListener('click', () => this.view.goToPage(page));
      items.push(item);
    }
    this.thumbnailsList.replaceChildren(...items);

    this.thumbnailObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = entry.target as HTMLElement;
          const page = Number(item.dataset.page);
          const frame = item.querySelector('.thumbnail-frame');
          if (!frame || frame.childElementCount > 0) continue;
          const canvas = document.createElement('canvas');
          frame.append(canvas);
          void this.view.renderThumbnail(page, canvas, 220);
          observer.unobserve(item);
        }
      },
      { root: this.thumbnailsList, rootMargin: '200px' },
    );
    for (const item of items) this.thumbnailObserver.observe(item);
    this.highlightCurrentPage(this.view.currentPage);
  }

  private highlightCurrentPage(page: number): void {
    for (const tile of this.searchResults.querySelectorAll<HTMLElement>('.pane-result-tile')) {
      tile.setAttribute('aria-current', String(Number(tile.dataset.page) === page));
    }
    for (const item of this.thumbnailsList.querySelectorAll<HTMLElement>('.thumbnail-item')) {
      const selected = Number(item.dataset.page) === page;
      item.setAttribute('aria-current', String(selected));
      if (selected) item.scrollIntoView({ block: 'nearest' });
    }
    for (const [index, item] of [...this.outlineList.querySelectorAll<HTMLElement>('.outline-item')].entries()) {
      item.setAttribute('aria-current', String(this.outlineEntries[index]?.pageNumber === page));
    }
  }

  // ── פסי הגלילה המותאמים (PdfScrollbar) ──────────────────────────────────

  private syncScrollbars(): void {
    const vertical = this.view.verticalScrollMetrics;
    const trackHeight = this.verticalScrollbar.clientHeight;
    if (vertical.total <= vertical.visible || trackHeight === 0) {
      this.verticalThumb.classList.add('hidden');
    } else {
      const height = Math.max(50, (vertical.visible / vertical.total) * trackHeight);
      const maximumOffset = vertical.total - vertical.visible;
      const top = (vertical.offset / maximumOffset) * (trackHeight - height);
      this.verticalThumb.classList.remove('hidden');
      this.verticalThumb.style.height = `${height}px`;
      this.verticalThumb.style.top = `${top}px`;
      this.verticalThumb.textContent = String(this.view.currentPage);
    }

    const horizontal = this.view.horizontalScrollMetrics;
    // מרזב הפס האופקי נמדד מאזור הקריאה ולא מהפס עצמו: כשהפס מוסתר
    // (display:none) רוחבו 0, וזה היה מונע ממנו לחזור ולהופיע.
    const trackWidth = this.readerMain.clientWidth - 16;
    if (horizontal.total <= horizontal.visible + 1 || trackWidth <= 0) {
      this.horizontalThumb.classList.add('hidden');
    } else {
      const width = Math.max(50, (horizontal.visible / horizontal.total) * trackWidth);
      const maximumOffset = horizontal.total - horizontal.visible;
      const offset = (Math.abs(horizontal.offset) / maximumOffset) * (trackWidth - width);
      this.horizontalThumb.classList.remove('hidden');
      this.horizontalThumb.style.width = `${width}px`;
      this.horizontalThumb.style.left = `${offset}px`;
    }
  }

  private attachScrollbarDragging(): void {
    let dragging: 'vertical' | 'horizontal' | null = null;
    let startPointer = 0;
    let startOffset = 0;

    const begin = (kind: 'vertical' | 'horizontal') => (event: PointerEvent) => {
      dragging = kind;
      startPointer = kind === 'vertical' ? event.clientY : event.clientX;
      startOffset = kind === 'vertical'
        ? this.view.verticalScrollMetrics.offset
        : this.view.horizontalScrollMetrics.offset;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const move = (event: PointerEvent): void => {
      if (!dragging) return;
      if (dragging === 'vertical') {
        const metrics = this.view.verticalScrollMetrics;
        const trackHeight = this.verticalScrollbar.clientHeight;
        const thumbHeight = this.verticalThumb.clientHeight;
        const travel = Math.max(trackHeight - thumbHeight, 1);
        const delta = ((event.clientY - startPointer) / travel) * (metrics.total - metrics.visible);
        this.view.scrollVerticalTo(startOffset + delta);
      } else {
        const metrics = this.view.horizontalScrollMetrics;
        const trackWidth = this.horizontalScrollbar.clientWidth;
        const thumbWidth = this.horizontalThumb.clientWidth;
        const travel = Math.max(trackWidth - thumbWidth, 1);
        const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
        const delta = ((event.clientX - startPointer) / travel) * (metrics.total - metrics.visible);
        this.view.scrollHorizontalTo(startOffset + delta * direction);
      }
      this.syncScrollbars();
    };

    const end = (): void => {
      dragging = null;
    };

    this.verticalThumb.addEventListener('pointerdown', begin('vertical'));
    this.horizontalThumb.addEventListener('pointerdown', begin('horizontal'));
    for (const thumb of [this.verticalThumb, this.horizontalThumb]) {
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', end);
      thumb.addEventListener('pointercancel', end);
    }
  }

  /// אותם קיצורים כמו במסך ה-PDF של אוצריא: שמאלה = הדף הבא, ימינה = הקודם.
  private attachKeyboardNavigation(): void {
    this.viewport.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowLeft':
          this.view.goNextPage();
          break;
        case 'ArrowRight':
          this.view.goPreviousPage();
          break;
        case 'ArrowDown':
          this.view.scrollBy(25);
          break;
        case 'ArrowUp':
          this.view.scrollBy(-25);
          break;
        default:
          return;
      }
      event.preventDefault();
    });
  }
}
