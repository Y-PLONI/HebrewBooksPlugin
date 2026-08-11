import { describe, expect, it } from 'vitest';
import manifestJson from '../manifest.json';

type JsonObject = Record<string, unknown>;

const manifest = manifestJson as JsonObject;
const contributes = objectAt(manifest, 'contributes');
const startup = objectAt(contributes, 'startup');
const program = objectArrayAt(startup, 'programs')[0]!;
const toolbarItems = objectArrayAt(startup, 'toolbarItems');

describe('parallel edition manifest contributions', () => {
  it('declares the static toolbar permission and a single bidirectional program', () => {
    expect(stringArrayAt(manifest, 'permissions')).toContain('reader.toolbar');
    expect(objectArrayAt(startup, 'programs')).toHaveLength(1);
    expect(program.id).toBe('find-parallel-editions');

    const commands = objectArrayAt(program, 'commands');
    expect(commands.map((command) => command.type)).toContain('data.choose');
    expect(commands.at(-1)).toMatchObject({
      id: 'defaultEdition',
      type: 'data.first',
      args: { items: { '$result': 'editions' } },
    });
  });

  it('contributes exactly a default button and a separate editions menu', () => {
    expect(toolbarItems).toHaveLength(2);
    expect(toolbarItems.map((item) => item.type)).toEqual(['button', 'menu']);
    expect(toolbarItems.every((item) =>
      objectAt(item, 'binding').program === 'find-parallel-editions'
    )).toBe(true);

    expect(toolbarItems[0]).toMatchObject({
      id: 'open-default-parallel-edition',
      contexts: ['reader-text', 'reader-pdf'],
      binding: { visibleOutput: 'defaultEdition' },
      action: {
        type: 'reader.openBook',
        args: { identity: { '$output': 'defaultEdition.identity' } },
      },
    });
    expect(toolbarItems[1]).toMatchObject({
      id: 'open-parallel-editions-menu',
      contexts: ['reader-text', 'reader-pdf'],
      binding: { visibleOutput: 'editions' },
      childrenBinding: {
        itemsOutput: 'editions',
        maxItems: 20,
        itemTemplate: {
          action: {
            type: 'reader.openBook',
            args: { identity: { '$item': 'identity' } },
          },
        },
      },
    });
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
