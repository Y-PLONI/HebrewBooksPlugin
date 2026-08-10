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
  readonly widthPt: number;
  readonly heightPt: number;
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
    await this.close();

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
    const firstPage = await document.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    // גדלי שאר הדפים נקראים ישירות מהמפרט, בלי לטעון כל דף — כמו
    // ש-pdfrx בונה את ה-layout מהמטא-דאטה לפני הרינדור.
    for (let number = 1; number <= document.numPages; number += 1) {
      const size = number === 1
        ? { width: firstViewport.width, height: firstViewport.height }
        : await this.pageSize(document, number);
      const element = window.document.createElement('div');
      element.className = 'pdf-page';
      element.dataset.page = String(number);
      this.slots.push({ element, widthPt: size.width, heightPt: size.height, canvas: null, renderedScale: 0, task: null });
    }
    if (generation !== this.generation) return;

    this.pages.replaceChildren(...this.slots.map((slot) => slot.element));
    this.zoomFactor = 1;
    this.recomputeBaseScale();
    this.applyLayout();
    this.currentPageNumber = Math.min(Math.max(initialPage, 1), document.numPages);
    this.scrollToPage(this.currentPageNumber, 'instant');
    this.renderVisiblePages();
    this.notifyChanged();
  }

  async close(): Promise<void> {
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
      if (slot.task === task) slot.task = null;
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
