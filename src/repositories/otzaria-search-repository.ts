import type { HostBridge } from '../bridge';
import { requireHostData } from '../bridge';
import type {
  ExternalSearchResultPayload,
  HostBookIdentity,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchHit,
  ResolvedBook,
} from '../models';

export class OtzariaSearchRepository {
  constructor(private readonly bridge: HostBridge) {}

  async *search(
    request: HostSearchRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OtzariaSearchChunk> {
    const stream = this.bridge.call('search.query', {
      ...request,
      includeBookCounts: false,
    });
    const iterator = stream[Symbol.asyncIterator]();
    let finished = false;
    const cancel = (): void => {
      const cancellation = iterator.return?.();
      if (cancellation) void cancellation.catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) return;
      while (!signal?.aborted) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        yield parseSearchChunk(next.value);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!finished) await iterator.return?.();
    }
  }

  async resolveBooks(identities: HostBookIdentity[]): Promise<Array<ResolvedBook | null>> {
    if (identities.length === 0) return [];
    const chunks = chunk(identities, 100);
    const resolved = await Promise.all(
      chunks.map((items) => requireHostData<unknown[]>(this.bridge, 'library.resolveBooks', { items })),
    );
    return resolved.flat().map(parseResolvedBook);
  }

  async openBook(
    identity: HostBookIdentity,
    index: number,
    searchQuery: string,
    matches?: { pages: number[]; matchedTerms: string[] },
  ): Promise<boolean> {
    return requireHostData<boolean>(this.bridge, 'reader.openBook', {
      ...identity,
      index,
      searchQuery,
      navigateToPositionIfReused: true,
      ...(matches && matches.pages.length > 0
        ? { matchPages: matches.pages, matchedTerms: matches.matchedTerms }
        : {}),
    });
  }

  /// רושם את התוסף כספק חיפוש-בתוך-ספר לספרי היברובוקס — הקורא המובנה של
  /// אוצריא ישלח אלינו אירועי reader.inBookSearch.requested.
  async registerInBookSearchProvider(): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.registerInBookSearchProvider', {
      provider: 'hebrewbooks',
    });
  }

  async respondInBookSearch(
    requestId: string,
    result: { pages: number[]; matchedTerms: string[]; query: string } | { error: string },
  ): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.respondInBookSearch', {
      requestId,
      ...result,
    });
  }

  /// פותח כרטיסיית חיפוש מובנית באוצריא עם שורת ההיברובוקס מסומנת —
  /// התוצאות יוצגו שם דרך ספק התוצאות החיצוני.
  async openSearchTab(query: string): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.openSearchTab', {
      query,
      selectItems: ['include-hebrewbooks'],
    });
  }

  /// רושם את התוסף כספק תוצאות חיצוני לטאב החיפוש המובנה — אוצריא תשלח
  /// אלינו אירועי search.external.requested במקום לפתוח את מסך התוסף.
  async registerExternalSearchProvider(): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.registerExternalSearchProvider', {
      provider: 'hebrewbooks',
    });
  }

  async respondExternalSearch(
    requestId: string,
    result:
      | {
          results: ExternalSearchResultPayload[];
          totalBooks: number;
          totalHits: number;
          hasMore: boolean;
        }
      | { error: string },
  ): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.respondExternalSearch', {
      requestId,
      ...result,
    });
  }
}

function parseSearchChunk(value: unknown): OtzariaSearchChunk {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('אוצריא החזירה תשובת חיפוש לא תקינה');
  }
  return {
    sequence: nonNegativeInteger(value.sequence, 'sequence'),
    results: value.results.map(parseSearchHit),
    total: value.total === null ? null : nonNegativeInteger(value.total, 'total'),
    groupCount: value.groupCount === null ? null : nonNegativeInteger(value.groupCount, 'groupCount'),
    truncated: value.truncated === true,
    limit: nonNegativeInteger(value.limit, 'limit'),
    offset: nonNegativeInteger(value.offset, 'offset'),
    facets: Array.isArray(value.facets)
      ? value.facets.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function parseSearchHit(value: unknown): OtzariaSearchHit {
  if (
    !isRecord(value) ||
    typeof value.book !== 'string' ||
    typeof value.reference !== 'string' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('אוצריא החזירה תוצאת חיפוש לא תקינה');
  }
  return {
    ...parseIdentity(value),
    book: value.book,
    categoryPath: optionalString(value.categoryPath),
    reference: value.reference,
    text: value.text,
    index: nonNegativeInteger(value.index, 'index'),
    mergedCount: nonNegativeInteger(value.mergedCount, 'mergedCount'),
  };
}

function parseResolvedBook(value: unknown): ResolvedBook | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.title !== 'string') {
    throw new Error('אוצריא החזירה זהות ספר לא תקינה');
  }
  return {
    ...parseIdentity(value),
    title: value.title,
    categoryPath: optionalString(value.categoryPath),
  };
}

function parseIdentity(value: Record<string, unknown>): HostBookIdentity {
  const identity: HostBookIdentity = {};
  if (Number.isInteger(value.id)) identity.id = Number(value.id);
  if (typeof value.bookId === 'string') identity.bookId = value.bookId;
  if (typeof value.type === 'string') identity.type = value.type as HostBookIdentity['type'];
  if (typeof value.source === 'string') identity.source = value.source as HostBookIdentity['source'];
  if (isRecord(value.external) && typeof value.external.provider === 'string') {
    const id = value.external.id;
    if (typeof id === 'string' || Number.isInteger(id)) {
      identity.external = {
        provider: value.external.provider as 'hebrewbooks' | 'otzar',
        id: id as number | string,
      };
    }
  }
  return identity;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`אוצריא החזירה ${field} לא תקין`);
  }
  return Number(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
