import { describe, expect, it } from 'vitest';
import manifestJson from '../manifest.json';

type JsonObject = Record<string, unknown>;

const manifest = manifestJson as JsonObject;
const contributes = objectAt(manifest, 'contributes');
const startup = objectAt(contributes, 'startup');
const program = objectArrayAt(startup, 'programs')[0]!;
const toolbarItems = objectArrayAt(startup, 'toolbarItems');

describe('parallel edition manifest contributions', () => {
  it('declares the static toolbar permission and a single host-computed program', () => {
    expect(stringArrayAt(manifest, 'permissions')).toContain('reader.toolbar');
    expect(objectArrayAt(startup, 'programs')).toHaveLength(1);
    expect(program.id).toBe('find-parallel-editions');

    // המהדורות (מובנית + היברובוקס מקומיות) מחושבות במנוע המובנה של אוצריא —
    // אותה רשימה בדיוק כמו הלחצן המובנה בסרגל.
    const commands = objectArrayAt(program, 'commands');
    expect(commands.map((command) => command.type)).toEqual([
      'library.parallelEditions',
      'data.first',
    ]);
    expect(commands.at(-1)).toMatchObject({
      id: 'defaultEdition',
      type: 'data.first',
      args: { items: { '$result': 'editions' } },
    });
  });

  it('contributes a single show-beside split button inside the overflow menu', () => {
    expect(toolbarItems).toHaveLength(1);

    // לחצן "פתח מהדורה מקבילה" הוסר — הוא מובנה באוצריא עצמה; התוסף תורם
    // רק את "הצג בצד", בתפריט שלוש הנקודות ולא בסרגל הראשי.
    expect(toolbarItems[0]).toMatchObject({
      id: 'show-parallel-edition-beside',
      type: 'split',
      placement: 'overflow',
      // משקל 55 — מיד לפני "הדפסה" (60) בתפריט שלוש הנקודות בשני המסכים.
      order: 55,
      contexts: ['reader-text', 'reader-pdf'],
      binding: {
        program: 'find-parallel-editions',
        visibleOutput: 'defaultEdition',
      },
      action: {
        type: 'reader.openBookInSidePane',
        args: { identity: { '$output': 'defaultEdition.identity' } },
      },
      childrenBinding: {
        itemsOutput: 'editions',
        maxItems: 20,
        itemTemplate: {
          title: { '$item': 'title' },
          action: {
            type: 'reader.openBookInSidePane',
            args: { identity: { '$item': 'identity' } },
          },
        },
      },
    });
  });

  it('שורת ההיברובוקס בדיאלוג החיפוש מפנה לתוצאות בטאב המובנה ולא לתוסף', () => {
    const items = objectArrayAt(startup, 'searchDialogItems');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'include-hebrewbooks',
      resultsProvider: 'hebrewbooks',
      resultsTitle: 'היברובוקס',
    });
    // openPluginOnSubmit הוסר — הסימון פותח טאב חיפוש רגיל עם מדור היברובוקס.
    expect(items[0]).not.toHaveProperty('openPluginOnSubmit');
  });

  it('keeps computation and clicks declarative without background activation', () => {
    expect(stringArrayAt(manifest, 'permissions')).not.toContain('app.run_on_startup');
    expect(manifest).not.toHaveProperty('background');
    expect(toolbarItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ openPlugin: true })]),
    );
  });
});

function objectAt(value: JsonObject, key: string): JsonObject {
  const child = value[key];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) {
    throw new Error(`${key} must be an object`);
  }
  return child as JsonObject;
}

function objectArrayAt(value: JsonObject, key: string): JsonObject[] {
  const child = value[key];
  if (!Array.isArray(child)) throw new Error(`${key} must be an array`);
  return child.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${key} must contain objects`);
    }
    return item as JsonObject;
  });
}

function stringArrayAt(value: JsonObject, key: string): string[] {
  const child = value[key];
  if (!Array.isArray(child) || !child.every((item) => typeof item === 'string')) {
    throw new Error(`${key} must contain strings`);
  }
  return child;
}
