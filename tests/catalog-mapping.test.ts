import { describe, expect, it } from 'vitest';
import type { HostBridge } from '../src/bridge';
import { CatalogMappingRepository } from '../src/repositories/catalog-mapping-repository';

describe('CatalogMappingRepository', () => {
  it('chunks ids by the database policy and batches at most two queries per RPC', async () => {
    const batchSizes: number[] = [];
    const bridge: HostBridge = {
      call: async <T>(method: string, payload?: Record<string, unknown>) => {
        expect(method).toBe('database.batchQuery');
        const queries = (payload?.queries ?? []) as Array<Record<string, unknown>>;
        batchSizes.push(queries.length);
        const results = queries.map((query) => {
          const where = query.where as { conditions: Array<{ value?: number[] }> };
          const values = where.conditions[0]?.value ?? [];
          return {
            rows: values.map((id) => ({ hb_id: id, otzaria_id: id + 1000, is_best: 1, confidence: 1 })),
          };
        });
        return { success: true, data: { results } as T, error: null };
      },
      on: () => {},
    };
    const repository = new CatalogMappingRepository(bridge);

    const mapping = await repository.findBestOtzariaIds(
      Array.from({ length: 45 }, (_, index) => String(index + 1)),
    );

    expect(batchSizes).toEqual([2, 1]);
    expect(mapping).toHaveLength(45);
    expect(mapping.get('45')).toBe(1045);
  });
});
