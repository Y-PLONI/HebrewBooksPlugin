import type { HostBridge } from '../bridge';
import { requireHostData } from '../bridge';
import type {
  HostBookIdentity,
  HostSearchRequest,
  OtzariaSearchHit,
  OtzariaSearchResponse,
  ResolvedBook,
} from '../models';

export class OtzariaSearchRepository {
  constructor(private readonly bridge: HostBridge) {}

  async search(request: HostSearchRequest): Promise<OtzariaSearchResponse> {
    const data = await requireHostData<unknown>(this.bridge, 'search.query', {
      ...request,
      includeBookCounts: false,
    });
    return parseSearchResponse(data);
  }

  async resolveBooks(identities: HostBookIdentity[]): Promise<Array<ResolvedBook | null>> {
    if (identities.length === 0) return [];
    const chunks = chunk(identities, 100);
    const resolved = await Promise.all(
      chunks.map((items) => requireHostData<unknown[]>(this.bridge, 'library.resolveBooks', { items })),
    );
    return resolved.flat().map(parseResolvedBook);
  }

  async openBook(identity: HostBookIdentity, index: number, searchQuery: string): Promise<boolean> {
    return requireHostData<boolean>(this.bridge, 'reader.openBook', {
      ...identity,
      index,
      searchQuery,
      navigateToPositionIfReused: true,
    });
  }
}

function parseSearchResponse(value: unknown): OtzariaSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('אוצריא החזירה תשובת חיפוש לא תקינה');
  }
  return {
    results: value.results.map(parseSearchHit),
    total: nonNegativeInteger(value.total, 'total'),
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
