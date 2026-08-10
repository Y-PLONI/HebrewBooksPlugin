import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

const maximumCanvasPixels = 16_000_000;

export class PdfViewerController {
  private document: PDFDocumentProxy | null = null;
  private renderTask: RenderTask | null = null;
  private pageNumber = 1;
  private scale = 1;
  private rotation = 0;
  private generation = 0;
  onChanged: ((page: number, pageCount: number, zoom: number) => void) | null = null;
  onLoading: ((isLoading: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly stage: HTMLElement) {
    GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', document.baseURI).toString();
  }

  get currentPage(): number { return this.pageNumber; }
  get pageCount(): number { return this.document?.numPages ?? 0; }
  get zoom(): number { return this.scale; }

  async open(url: string, initialPage = 1): Promise<void> {
    const generation = ++this.generation;
    this.onLoading?.(true);
    await this.closeDocument();
    const loadingTask = getDocument({
      url,
      disableRange: false,
      disableStream: true,
      disableAutoFetch: true,
      rangeChunkSize: 256 * 1024,
    });
    try {
      const documentProxy = await loadingTask.promise;
      if (generation !== this.generation) {
        await documentProxy.destroy();
        return;
      }
      this.document = documentProxy;
      this.pageNumber = Math.min(Math.max(initialPage, 1), documentProxy.numPages);
      this.scale = 1;
      this.rotation = 0;
      await this.fitWidth();
    } finally {
      if (generation === this.generation) this.onLoading?.(false);
    }
  }

  async goToPage(page: number): Promise<void> {
    if (!this.document) return;
    this.pageNumber = Math.min(Math.max(Math.round(page), 1), this.document.numPages);
    await this.render();
  }

  async zoomBy(factor: number): Promise<void> {
    this.scale = Math.min(Math.max(this.scale * factor, 0.25), 4);
    await this.render();
  }

  async fitWidth(): Promise<void> {
    if (!this.document) return;
    const page = await this.document.getPage(this.pageNumber);
    const baseViewport = page.getViewport({ scale: 1, rotation: this.rotation });
    this.scale = Math.min(Math.max((this.stage.clientWidth - 48) / baseViewport.width, 0.25), 4);
    await this.render(page);
  }

  async rotate(): Promise<void> {
    this.rotation = (this.rotation + 90) % 360;
    await this.fitWidth();
  }

  async destroy(): Promise<void> {
    this.generation++;
    await this.closeDocument();
  }

  private async render(preloadedPage?: Awaited<ReturnType<PDFDocumentProxy['getPage']>>): Promise<void> {
    if (!this.document) return;
    const page = preloadedPage ?? await this.document.getPage(this.pageNumber);
    this.renderTask?.cancel();
    const cssViewport = page.getViewport({ scale: this.scale, rotation: this.rotation });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const requestedPixels = cssViewport.width * cssViewport.height * pixelRatio * pixelRatio;
    const safeRatio = requestedPixels > maximumCanvasPixels
      ? pixelRatio * Math.sqrt(maximumCanvasPixels / requestedPixels)
      : pixelRatio;
    const renderViewport = page.getViewport({ scale: this.scale * safeRatio, rotation: this.rotation });

    this.canvas.width = Math.floor(renderViewport.width);
    this.canvas.height = Math.floor(renderViewport.height);
    this.canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    this.canvas.style.height = `${Math.floor(cssViewport.height)}px`;
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('לא ניתן ליצור משטח להצגת ה־PDF');

    this.renderTask = page.render({ canvasContext: context, viewport: renderViewport });
    try {
      await this.renderTask.promise;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
    } finally {
      this.renderTask = null;
    }
    this.onChanged?.(this.pageNumber, this.document.numPages, this.scale);
  }

  private async closeDocument(): Promise<void> {
    this.renderTask?.cancel();
    this.renderTask = null;
    if (this.document) await this.document.destroy();
    this.document = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
