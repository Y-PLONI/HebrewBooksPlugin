/// קטעי הטקסט של מופע הרקע. אוצריא משגרת אליו את search.external.requested
/// כשהוא חי, ולכן הגזירים של המדור החיצוני חייבים להיווצר כאן — מחבילת
/// pdf.js שנטענת רק כשנדרש הגזיר הראשון, ולא באתחול.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootPayload,
  createMockHost,
  hebrewBooksNdjson,
  hebrewBooksRow,
  type MockHost,
} from './helpers/mock-host';

const pdf = vi.hoisted(() => ({
  opens: [] as string[],
  pages: [] as number[],
  text: `${'מילת רקע '.repeat(30)}ברכת המזון בשלוש ברכות${' עוד טקסט'.repeat(30)}`,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: ({ url }: { url: string }) => {
    pdf.opens.push(url);
    return {
      promise: Promise.resolve({
        numPages: 50,
        getPage: (page: number) => {
          pdf.pages.push(page);
          return Promise.resolve({
            getTextContent: () =>
              Promise.resolve({ items: pdf.text.split(' ').map((str) => ({ str })) }),
          });
        },
        destroy: () => Promise.resolve(),
      }),
    };
  },
}));

// טעינת חבילת הגזירים האמיתית — בדיוק מה ש-assets/snippets.js עושה בדף.
await import('../src/snippets-entry');

const service = {
  '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }),
  '/inbook': () => ({
    body: JSON.stringify({ hitCount: 4, pages: [9], matchedTerms: ['ברכת', 'המזון'] }),
  }),
};

async function startBackgroundInstance(): Promise<MockHost> {
  const host = createMockHost({ network: service });
  (globalThis as { window?: unknown }).window = { Otzaria: host.bridge };
  vi.resetModules();
  await import('../src/background');
  host.emit('plugin.boot', bootPayload());
  return host;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  pdf.opens.length = 0;
  pdf.pages.length = 0;
});

describe('גזירי הטקסט של מופע הרקע', () => {
  it('מחלץ קטע מהעמוד שאותר, דרך חבילה שנטענה בעצלתיים', async () => {
    const host = await startBackgroundInstance();

    host.emit('search.external.requested', {
      requestId: 'xs-1',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      offset: 0,
      limit: 20,
    });

    await vi.waitFor(() =>
      expect(
        host.payloadsOf('reader.respondExternalSearch').some((payload) => payload?.done === undefined),
      ).toBe(true),
    );
    const final = host.payloadsOf('reader.respondExternalSearch').at(-1);
    const result = (final?.results as Array<Record<string, unknown>>)[0];

    // הטקסט עצמו, לא רק נוכחות השדה: זו העדות שהחילוץ באמת רץ כאן.
    expect(result?.snippet).toContain('ברכת המזון');
    expect(pdf.opens).toEqual(['http://127.0.0.1:8080/pdf/43558']);
    // תוצאה ברמת ספר מגיעה בלי עמוד ההתאמה, ולכן הוא אותר קודם ב-/inbook.
    expect(pdf.pages).toEqual([9]);
  });
});
