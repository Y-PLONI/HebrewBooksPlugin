import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

/// גלילה רציפה של דפי ה-PDF, כמו ה-PdfViewer של אוצריא (pdfrx) במצב תצוגה
/// רגיל: כל הדפים זה מתחת לזה, רווח של 8px ביניהם (PdfViewerParams.margin),
/// צל דף, ו-zoom שבו 1.0 = התאמה לרוחב. רק הדפים הנראים (± דף אחד, כמו
/// verticalCacheExtent: 1) מרונדרים בפועל.

const pageMargin = 8;
const maximumCanvasPixels = 16_000_000;
const minimumZoom = 0.1;
const maximumZoom = 20;

export interface OutlineEntry {
  readonly title: string;
  readonly level: number;
  readonly pageNumber: number | null;
}

interface PageSlot {
  readonly element: HTMLElement;
  widthPt: number;
  heightPt: number;
  canvas: HTMLCanvasElement | null;
  renderedScale: number;
  task: RenderTask | null;
}

export class PdfDocumentView {
  private document: PDFDocumentProxy | null = null;
  private slots: PageSlot[] = [];
  private baseScale = 1;
  private zoomFactor = 1;
  private currentPageNumber = 1;
  private generation = 0;
  private scrollFrame = 0;
  private hydrationTimer = 0;

  onChanged: ((page: number, pageCount: number, zoom: number) => void) | null = null;
  onScrolled: (() => void) | null = null;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly pages: HTMLElement,
    workerUrl: string,
  ) {
    GlobalWorkerOptions.workerSrc = workerUrl;
    this.viewport.addEventListener('scroll', () => this.handleScroll(), { passive: true });
    this.viewport.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
  }

  get pageCount(): number {
    return this.document?.numPages ?? 0;
  }

  get currentPage(): number {
    return this.currentPageNumber;
  }

  get zoom(): number {
    return this.zoomFactor;
  }

  async open(url: string, initialPage: number): Promise<void> {
    const generation = ++this.generation;
    await this.clearDocument();
    if (generation !== this.generation) return;

    const document = await getDocument({
      url,
      disableRange: false,
      disableStream: true,
      disableAutoFetch: true,
      rangeChunkSize: 256 * 1024,
    }).promise;

    if (generation !== this.generation) {
      await document.destroy();
      return;
    }

    this.document = document;
    this.slots = [];
    const page = Math.min(Math.max(initialPage, 1), document.numPages);
    let firstPage: PDFPageProxy;
    let targetPage: PDFPageProxy | null;
    try {
      [firstPage, targetPage] = await Promise.all([
        document.getPage(1),
        page === 1 ? Promise.resolve(null) : document.getPage(page),
      ]);
    } catch (error) {
      if (generation !== this.generation) return;
      await this.clearDocument();
      if (generation !== this.generation) return;
      throw error;
    }
    if (generation !== this.generation) return;
    const firstViewport = firstPage.getViewport({ scale: 1 });
    const targetViewport = targetPage?.getViewport({ scale: 1 }) ?? firstViewport;
    const initialSize = { width: targetViewport.width, height: targetViewport.height };
    // PDF.js חושף גדלי דפים רק דרך getPage. בונים תחילה פריסה משוערת
    // במידות הדף הראשון, כדי שהעמוד המבוקש יופיע בלי לחכות לכל הספר.
    for (let number = 1; number <= document.numPages; number += 1) {
      const size = number === page ? initialSize : firstViewport;
      const element = window.document.createElement('div');
      element.className = 'pdf-page';
      element.dataset.page = String(number);
      this.slots.push({ element, widthPt: size.width, heightPt: size.height, canvas: null, renderedScale: 0, task: null });
    }
    this.pages.replaceChildren(...this.slots.map((slot) => slot.element));
    this.zoomFactor = 1;
    this.recomputeBaseScale();
    this.applyLayout();
    this.currentPageNumber = page;
    this.scrollToPage(this.currentPageNumber, 'instant');
    this.renderVisiblePages();
    this.notifyChanged();
    // עבודה מדורגת אחרי שהדפדפן קיבל הזדמנות לצייר את העמוד הראשון.
    this.hydrationTimer = window.setTimeout(() => {
      this.hydrationTimer = 0;
      void this.hydratePageSizes(document, generation, page);
    }, 0);
  }

  async close(): Promise<void> {
    ++this.generation;
    await this.clearDocument();
  }

  private async clearDocument(): Promise<void> {
    window.clearTimeout(this.hydrationTimer);
    this.hydrationTimer = 0;
    for (const slot of this.slots) {
      slot.task?.cancel();
      slot.task = null;
      slot.canvas = null;
    }
    this.slots = [];
    this.pages.replaceChildren();
    if (this.document) {
      const document = this.document;
      this.document = null;
      await document.destroy();
    }
  }

  private async hydratePageSizes(document: PDFDocumentProxy, generation: number, initialPage: number): Promise<void> {
    const batchSize = 8;
    for (let start = 2; start <= document.numPages && generation === this.generation; start += batchSize) {
      const numbers = Array.from({ length: Math.min(batchSize, document.numPages - start + 1) }, (_, index) => start + index)
        .filter((number) => number !== initialPage);
      const sizes = await Promise.all(numbers.map((number) => this.pageSize(document, number).catch(() => null)));
      if (generation !== this.generation) return;
      const anchor = this.slots[this.currentPageNumber - 1]?.element;
      const oldTop = anchor?.offsetTop ?? 0;
      const oldOffset = this.viewport.scrollTop - oldTop;
      const oldScale = this.scale;
      let changed = false;
      for (let index = 0; index < numbers.length; index += 1) {
        const size = sizes[index];
        const slot = this.slots[numbers[index]! - 1];
        if (!size || !slot) continue;
        if (slot.widthPt !== size.width || slot.heightPt !== size.height) changed = true;
        slot.widthPt = size.width;
        slot.heightPt = size.height;
      }
      if (changed) {
        this.recomputeBaseScale();
        this.applyLayout();
        if (anchor) this.viewport.scrollTop = anchor.offsetTop + oldOffset * (this.scale / oldScale);
        this.renderVisiblePages();
        this.onScrolled?.();
      }
      // מגביל עבודה על ספרים ארוכים ומאפשר אינטראקציה וביטול בין אצוות.
      if (start + batchSize <= document.numPages) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }

  async outline(): Promise<OutlineEntry[]> {
    const document = this.document;
    if (!document) return [];
    const raw = (await document.getOutline()) as OutlineNode[] | null;
    if (!raw) return [];
    const entries: OutlineEntry[] = [];
    const walk = async (nodes: OutlineNode[], level: number): Promise<void> => {
      for (const node of nodes) {
        entries.push({ title: node.title.trim(), level, pageNumber: await this.destinationPage(document, node) });
        if (node.items && node.items.length > 0) await walk(node.items, level + 1);
      }
    };
    await walk(raw, 0);
    return entries;
  }

  /// רינדור תמונה מוקטנת לחלונית הדפים (ThumbnailsView).
  async renderThumbnail(pageNumber: number, canvas: HTMLCanvasElement, maxHeight: number): Promise<void> {
    const document = this.document;
    if (!document) return;
    const generation = this.generation;
    const page = await document.getPage(pageNumber);
    if (generation !== this.generation) return;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: maxHeight / base.height });
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({ canvasContext: context, viewport }).promise.catch(ignoreCancellation);
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoomFactor * factor);
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  /// שינוי ה-zoom תוך שמירה על נקודת המרכז — כמו setZoom(centerPosition, zoom).
  setZoom(zoom: number): void {
    const next = Math.min(Math.max(zoom, minimumZoom), maximumZoom);
    if (next === this.zoomFactor) return;
    const ratio = next / this.zoomFactor;
    const centerX = this.viewport.scrollLeft + this.viewport.clientWidth / 2;
    const centerY = this.viewport.scrollTop + this.viewport.clientHeight / 2;
    this.zoomFactor = next;
    this.applyLayout();
    this.viewport.scrollLeft = centerX * ratio - this.viewport.clientWidth / 2;
    this.viewport.scrollTop = centerY * ratio - this.viewport.clientHeight / 2;
    this.renderVisiblePages();
    this.notifyChanged();
  }

  goToPage(pageNumber: number): void {
    if (!this.document) return;
    const page = Math.min(Math.max(Math.round(pageNumber), 1), this.document.numPages);
    this.scrollToPage(page, 'instant');
  }

  goNextPage(): void {
    this.goToPage(this.currentPageNumber + 1);
  }

  goPreviousPage(): void {
    this.goToPage(this.currentPageNumber - 1);
  }

  /// התאמה מחדש אחרי שינוי גודל החלון — הבסיס הוא רוחב הדף הרחב ביותר.
  handleResize(): void {
    if (this.slots.length === 0) return;
    const previousBase = this.baseScale;
    this.recomputeBaseScale();
    if (previousBase === this.baseScale) return;
    const anchor = this.currentPageNumber;
    this.applyLayout();
    this.scrollToPage(anchor, 'instant');
    this.renderVisiblePages();
    this.notifyChanged();
  }

  /// יחס הגלילה האנכית — משמש לציור פס הגלילה המותאם.
  get verticalScrollMetrics(): { offset: number; visible: number; total: number } {
    return {
      offset: this.viewport.scrollTop,
      visible: this.viewport.clientHeight,
      total: this.viewport.scrollHeight,
    };
  }

  get horizontalScrollMetrics(): { offset: number; visible: number; total: number } {
    return {
      offset: this.viewport.scrollLeft,
      visible: this.viewport.clientWidth,
      total: this.viewport.scrollWidth,
    };
  }

  scrollVerticalTo(offset: number): void {
    this.viewport.scrollTop = offset;
  }

  scrollHorizontalTo(offset: number): void {
    this.viewport.scrollLeft = offset;
  }

  scrollBy(delta: number): void {
    this.viewport.scrollTop += delta;
  }

  private async pageSize(document: PDFDocumentProxy, number: number): Promise<{ width: number; height: number }> {
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }

  private recomputeBaseScale(): void {
    const widest = this.slots.reduce((maximum, slot) => Math.max(maximum, slot.widthPt), 1);
    const styles = window.getComputedStyle(this.viewport);
    const gutter = Number.parseFloat(styles.paddingRight || '0');
    const available = this.viewport.clientWidth - gutter - pageMargin * 2;
    this.baseScale = Math.max(available, 1) / widest;
  }

  private get scale(): number {
    return this.baseScale * this.zoomFactor;
  }

  private applyLayout(): void {
    const scale = this.scale;
    for (const slot of this.slots) {
      slot.element.style.width = `${Math.floor(slot.widthPt * scale)}px`;
      slot.element.style.height = `${Math.floor(slot.heightPt * scale)}px`;
    }
  }

  private scrollToPage(pageNumber: number, behavior: 'instant' | 'smooth'): void {
    const slot = this.slots[pageNumber - 1];
    if (!slot) return;
    // PdfPageAnchor.top — ראש הדף נצמד לראש החלון.
    this.viewport.scrollTo({ top: slot.element.offsetTop - pageMargin, behavior });
    this.currentPageNumber = pageNumber;
    this.notifyChanged();
  }

  private handleScroll(): void {
    if (this.scrollFrame !== 0) return;
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.updateCurrentPage();
      this.renderVisiblePages();
      this.onScrolled?.();
    });
  }

  private handleWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  /// pdfTopmostVisiblePage — הדף הראשון שנחתך עם החלון הנראה.
  private updateCurrentPage(): void {
    const top = this.viewport.scrollTop;
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (!slot) continue;
      if (slot.element.offsetTop + slot.element.offsetHeight > top + 1) {
        if (this.currentPageNumber !== index + 1) {
          this.currentPageNumber = index + 1;
          this.notifyChanged();
        }
        return;
      }
    }
  }

  private renderVisiblePages(): void {
    if (!this.document) return;
    const top = this.viewport.scrollTop;
    const bottom = top + this.viewport.clientHeight;
    const first = this.slots.findIndex((slot) => slot.element.offsetTop + slot.element.offsetHeight > top);
    if (first < 0) return;
    let last = first;
    while (last + 1 < this.slots.length) {
      const slot = this.slots[last + 1];
      if (!slot || slot.element.offsetTop > bottom) break;
      last += 1;
    }

    const from = Math.max(first - 1, 0);
    const to = Math.min(last + 1, this.slots.length - 1);
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (!slot) continue;
      if (index < from || index > to) {
        slot.task?.cancel();
        slot.task = null;
        if (slot.canvas) {
          slot.canvas.remove();
          slot.canvas = null;
          slot.renderedScale = 0;
        }
      } else if (slot.renderedScale !== this.scale && slot.task === null) {
        void this.renderPage(index + 1, slot);
      }
    }
  }

  private async renderPage(pageNumber: number, slot: PageSlot): Promise<void> {
    const document = this.document;
    if (!document) return;
    const generation = this.generation;
    const scale = this.scale;
    let page: PDFPageProxy;
    try {
      page = await document.getPage(pageNumber);
    } catch {
      return;
    }
    if (generation !== this.generation) return;

    const cssViewport = page.getViewport({ scale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const requested = cssViewport.width * cssViewport.height * pixelRatio * pixelRatio;
    const safeRatio = requested > maximumCanvasPixels
      ? pixelRatio * Math.sqrt(maximumCanvasPixels / requested)
      : pixelRatio;
    const renderViewport = page.getViewport({ scale: scale * safeRatio });

    const canvas = slot.canvas ?? window.document.createElement('canvas');
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    if (!slot.canvas) {
      slot.canvas = canvas;
      slot.element.append(canvas);
    }

    const task = page.render({ canvasContext: context, viewport: renderViewport });
    slot.task = task;
    try {
      await task.promise;
      slot.renderedScale = scale;
    } catch (error) {
      ignoreCancellation(error);
    } finally {
      if (slot.task === task) {
        slot.task = null;
        if (generation === this.generation && slot.renderedScale > 0 && slot.renderedScale !== this.scale) {
          this.renderVisiblePages();
        }
      }
    }
  }

  private notifyChanged(): void {
    this.onChanged?.(this.currentPageNumber, this.pageCount, this.zoomFactor);
  }

  private async destinationPage(document: PDFDocumentProxy, node: OutlineNode): Promise<number | null> {
    try {
      const destination = typeof node.dest === 'string' ? await document.getDestination(node.dest) : node.dest;
      const reference = Array.isArray(destination) ? destination[0] : null;
      if (!reference) return null;
      return (await document.getPageIndex(reference as never)) + 1;
    } catch {
      return null;
    }
  }
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
}

function ignoreCancellation(error: unknown): void {
  if (error instanceof Error && error.name === 'RenderingCancelledException') return;
  if (error !== undefined && error !== null) console.warn('רינדור העמוד נכשל', error);
}
