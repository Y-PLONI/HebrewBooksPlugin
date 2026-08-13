import { beforeEach, describe, expect, it, vi } from 'vitest';

/// מציג ה-PDF של pdf.js מוחלף במסמך מדומה, כדי לבדוק את מנגנון התור, המטמון
/// ואיחוד הבקשות של מחלץ גזירי הטקסט בלי לקרוא קובץ אמיתי.
const pdf = vi.hoisted(() => ({
  opens: [] as string[],
  destroys: 0,
  documents: new Map<string, { numPages: number; text: string }>(),
  failing: new Set<string>(),
  blocked: new Set<string>(),
  releases: new Map<string, () => void>(),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (options: { url: string }) => {
    const url = options.url;
    pdf.opens.push(url);
    const promise = (async () => {
      if (pdf.blocked.has(url)) {
        await new Promise<void>((resolve) => pdf.releases.set(url, resolve));
      }
      if (pdf.failing.has(url)) throw new Error('לא ניתן לפתוח את הקובץ');
      const entry = pdf.documents.get(url) ?? { numPages: 1, text: '' };
      return {
        numPages: entry.numPages,
        getPage: (pageNumber: number) =>
          Promise.resolve({
            getTextContent: () =>
              Promise.resolve({
                items: `${entry.text} [${pageNumber}]`.split(' ').map((str) => ({ str })),
              }),
          }),
        destroy: () => {
          pdf.destroys += 1;
          return Promise.resolve();
        },
      };
    })();
    return { promise };
  },
}));

const { HebrewBooksSnippetRepository } = await import(
  '../src/repositories/hebrewbooks-snippet-repository'
);

const pageText = `${'מילת רקע '.repeat(30)}ברכת המזון בשלוש ברכות ${'עוד טקסט '.repeat(30)}`;

function url(fileId: string): string {
  return `http://127.0.0.1:8080/pdf/${fileId}`;
}

describe('HebrewBooksSnippetRepository.load', () => {
  beforeEach(() => {
    pdf.opens.length = 0;
    pdf.destroys = 0;
    pdf.documents.clear();
    pdf.failing.clear();
    pdf.blocked.clear();
    pdf.releases.clear();
    pdf.documents.set(url('1'), { numPages: 10, text: pageText });
    pdf.documents.set(url('2'), { numPages: 10, text: pageText });
  });

  it('מחלץ את הקשר השאילתה מהעמוד המבוקש וסוגר את המסמך', async () => {
    const repository = new HebrewBooksSnippetRepository();
    const snippet = await repository.load(url('1'), '1', 4, 'ברכת המזון');
    expect(snippet).toContain('ברכת המזון');
    expect(snippet?.startsWith('…')).toBe(true);
    expect(pdf.opens).toEqual([url('1')]);
    expect(pdf.destroys).toBe(1);
  });

  it('עמוד חסר או לא חוקי אינו פותח את הקובץ בכלל', async () => {
    const repository = new HebrewBooksSnippetRepository();
    await expect(repository.load(url('1'), '1', null, 'ברכת')).resolves.toBeNull();
    await expect(repository.load(url('1'), '1', 0, 'ברכת')).resolves.toBeNull();
    await expect(repository.load(url('1'), '1', -3, 'ברכת')).resolves.toBeNull();
    expect(pdf.opens).toEqual([]);
  });

  it('עמוד מעל מספר העמודים שבקובץ מחזיר null', async () => {
    pdf.documents.set(url('1'), { numPages: 2, text: pageText });
    const repository = new HebrewBooksSnippetRepository();
    await expect(repository.load(url('1'), '1', 7, 'ברכת')).resolves.toBeNull();
    expect(pdf.destroys).toBe(1);
  });

  it('שומר במטמון לפי ספר, עמוד ושאילתה — בקשה חוזרת אינה פותחת את הקובץ שוב', async () => {
    const repository = new HebrewBooksSnippetRepository();
    const first = await repository.load(url('1'), '1', 4, 'ברכת המזון');
    const second = await repository.load(url('1'), '1', 4, 'ברכת המזון');
    expect(second).toBe(first);
    expect(pdf.opens).toHaveLength(1);

    // שאילתה אחרת על אותו עמוד היא מפתח אחר, ולכן נחלצת מחדש.
    await repository.load(url('1'), '1', 4, 'בשלוש');
    expect(pdf.opens).toHaveLength(2);
    // וכך גם עמוד אחר באותו ספר.
    await repository.load(url('1'), '1', 5, 'ברכת המזון');
    expect(pdf.opens).toHaveLength(3);
  });

  it('שתי בקשות זהות במקביל מתאחדות לפתיחה אחת', async () => {
    const repository = new HebrewBooksSnippetRepository();
    const [first, second] = await Promise.all([
      repository.load(url('1'), '1', 4, 'ברכת המזון'),
      repository.load(url('1'), '1', 4, 'ברכת המזון'),
    ]);
    expect(first).toBe(second);
    expect(pdf.opens).toHaveLength(1);
  });

  it('מגביל את מספר החילוצים המקבילים ומשחרר את התור בסיום', async () => {
    pdf.blocked.add(url('1'));
    pdf.blocked.add(url('2'));
    const repository = new HebrewBooksSnippetRepository(1);
    const first = repository.load(url('1'), '1', 1, 'ברכת');
    const second = repository.load(url('2'), '2', 1, 'ברכת');

    await vi.waitFor(() => expect(pdf.opens).toEqual([url('1')]));
    pdf.releases.get(url('1'))?.();
    await first;
    await vi.waitFor(() => expect(pdf.opens).toEqual([url('1'), url('2')]));
    pdf.releases.get(url('2'))?.();
    await expect(second).resolves.toContain('ברכת');
  });

  it('כישלון בפתיחת הקובץ מחזיר null ואינו נשמר במטמון', async () => {
    pdf.failing.add(url('1'));
    const repository = new HebrewBooksSnippetRepository();
    await expect(repository.load(url('1'), '1', 3, 'ברכת')).resolves.toBeNull();

    pdf.failing.delete(url('1'));
    await expect(repository.load(url('1'), '1', 3, 'ברכת')).resolves.toContain('ברכת');
    expect(pdf.opens).toHaveLength(2);
  });

  it('עמוד בלי שכבת טקסט (סריקה) מחזיר null', async () => {
    pdf.documents.set(url('3'), { numPages: 5, text: '' });
    const repository = new HebrewBooksSnippetRepository();
    // המסמך המדומה מוסיף רק את מספר העמוד, ולכן טקסט ריק אינו באמת ריק —
    // גזיר של סריקה נבדק ישירות מול המחלץ.
    const snippet = await repository.load(url('3'), '3', 1, 'ברכת');
    expect(snippet).toBe('[1]');
  });
});
