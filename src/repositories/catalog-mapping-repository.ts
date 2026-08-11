import type { HostBridge } from '../bridge';
import { requireHostData } from '../bridge';

interface DatabaseQueryResult {
  rows: Array<Record<string, unknown>>;
}

interface DatabaseBatchResult {
  results: DatabaseQueryResult[];
}

export class CatalogMappingRepository {
  constructor(private readonly bridge: HostBridge) {}

  async findBestOtzariaIds(fileIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(fileIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return new Map();

    const queries = chunk(ids, 20).map((values) => ({
      sourceId: 'external_catalog',
      from: { table: 'otzaria_hebrew_books', alias: 'm' },
      select: [
        { expr: 'm.hb_id', as: 'hb_id' },
        { expr: 'm.otzaria_id', as: 'otzaria_id' },
        { expr: 'm.is_best', as: 'is_best' },
        { expr: 'm.confidence', as: 'confidence' },
      ],
      where: {
        op: 'and',
        conditions: [
          { op: 'in', left: 'm.hb_id', value: values },
          { op: '=', left: 'm.is_best', value: 1 },
        ],
      },
      orderBy: [
        { expr: 'm.confidence', direction: 'desc' },
        { expr: 'm.hb_id', direction: 'asc' },
      ],
      limit: 20,
      rowFormat: 'object',
    }));
    const batches = await Promise.all(
      chunk(queries, 2).map((batch) =>
        requireHostData<DatabaseBatchResult>(this.bridge, 'database.batchQuery', { queries: batch }),
      ),
    );

    const mapping = new Map<string, number>();
    for (const batch of batches) {
      if (!Array.isArray(batch.results)) throw new Error('טבלת ההשוואה החזירה תשובה לא תקינה');
      for (const result of batch.results) {
        if (!Array.isArray(result.rows)) throw new Error('טבלת ההשוואה החזירה שורות לא תקינות');
        for (const row of result.rows) {
          const hbId = Number(row.hb_id);
          const otzariaId = Number(row.otzaria_id);
          if (Number.isInteger(hbId) && hbId > 0 && Number.isInteger(otzariaId) && otzariaId > 0) {
            if (!mapping.has(String(hbId))) mapping.set(String(hbId), otzariaId);
          }
        }
      }
    }
    return mapping;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
