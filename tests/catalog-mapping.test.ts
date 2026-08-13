import { describe, expect, it } from 'vitest';
import type { HostBridge } from '../src/bridge';
import { CatalogMappingRepository } from '../src/repositories/catalog-mapping-repository';

describe('CatalogMappingRepository', () => {
  it('chunks ids by the database policy and batches at most two queries per RPC', async () => {
    const batchSizes: number[] = [];
    const bridge: HostBridge = {
      call: (async <T>(method: string, payload?: Record<string, unknown>) => {
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
      }) as HostBridge['call'],
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

  it('מסלול ה-bulk ממפה 1200 מזהים בקריאת batch אחת (3 שאילתות של עד 500)', async () => {
    const batches: Array<Array<Record<string, unknown>>> = [];
    const bridge: HostBridge = {
      call: (async <T>(method: string, payload?: Record<string, unknown>) => {
        expect(method).toBe('database.batchQuery');
        const queries = (payload?.queries ?? []) as Array<Record<string, unknown>>;
        batches.push(queries);
        const results = queries.map((query) => {
          const where = query.where as { conditions: Array<{ value?: number[] }> };
          const values = where.conditions[0]?.value ?? [];
          return { rows: values.map((id) => ({ hb_id: id, otzaria_id: id + 1000 })) };
        });
        return { success: true, data: { results } as T, error: null };
      }) as HostBridge['call'],
      on: () => {},
    };
    const repository = new CatalogMappingRepository(bridge);

    const mapping = await repository.findBestOtzariaIdsBulk(
      Array.from({ length: 1200 }, (_, index) => String(index + 1)),
    );

    // מעבר גשר אחד בלבד: 3 שאילתות (500+500+200) ב-batch יחיד.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    const firstQuery = batches[0]?.[0] as { limit: number; where: { conditions: unknown[] } };
    expect(firstQuery.limit).toBe(1000);
    // הסינון ל-is_best נשאר בשאילתה עצמה — לא מסתמכים על מיון בלבד.
    expect(firstQuery.where.conditions).toContainEqual({ op: '=', left: 'm.is_best', value: 1 });
    expect(mapping).toHaveLength(1200);
    expect(mapping.get('1200')).toBe(2200);
  });

  it('במיפוי כפול לאותו hb_id — השורה הראשונה (confidence גבוה) מנצחת', async () => {
    const bridge: HostBridge = {
      call: (async <T>() => {
        const results = [
          {
            rows: [
              { hb_id: 5, otzaria_id: 800 },
              { hb_id: 5, otzaria_id: 900 },
            ],
          },
        ];
        return { success: true, data: { results } as T, error: null };
      }) as unknown as HostBridge['call'],
      on: () => {},
    };
    const repository = new CatalogMappingRepository(bridge);
    const mapping = await repository.findBestOtzariaIdsBulk(['5']);
    expect(mapping.get('5')).toBe(800);
  });
});
