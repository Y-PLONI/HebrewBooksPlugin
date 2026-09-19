// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBoot } from '../src/boot';
import { bootPayload, createMockHost, type MockHost } from './helpers/mock-host';

/// מנת boot עם (או בלי) runMode, כפי שאוצריא שולחת לכל מופע.
function payloadFor(runMode?: 'background' | 'foreground'): OtzariaBootPayload {
  const base = bootPayload();
  return { ...base, app: { ...base.app, ...(runMode ? { runMode } : {}) } };
}

function boot(payload: OtzariaBootPayload): { host: MockHost; shell: HTMLElement } {
  const host = createMockHost();
  const shell = document.createElement('div');
  document.body.replaceChildren(shell);
  installBoot(host.bridge, shell);
  host.emit('plugin.boot', payload);
  return { host, shell };
}

describe('פיצול plugin.boot לפי runMode', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('מופע רקע רושם את ספקי החיפוש בלבד, בלי לבנות ממשק', async () => {
    const { host, shell } = boot(payloadFor('background'));

    await vi.waitFor(() => expect(host.countOf('reader.registerExternalSearchProvider')).toBe(1));
    expect(host.countOf('reader.registerInBookSearchProvider')).toBe(1);
    // האירועים הממוקדים מוגשים מהבנאי, ולכן מופע הרקע מסוגל לענות עליהם.
    expect(host.hasListener('search.external.requested')).toBe(true);
    expect(host.hasListener('reader.inBookSearch.requested')).toBe(true);
    // אין בדיקת /health ואין ערכת נושא — עבודת האתחול של הלשונית הנראית.
    expect(host.countOf('network.fetchStream')).toBe(0);
    expect(host.hasListener('theme.changed')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--font-book')).toBe('');
    expect(shell.querySelector('.library-body')?.childElementCount).toBe(0);
  });

  it('מופע קדמי עובר אתחול מלא', async () => {
    const { host, shell } = boot(payloadFor('foreground'));

    await vi.waitFor(() => expect(host.countOf('reader.registerExternalSearchProvider')).toBe(1));
    expect(host.countOf('reader.registerInBookSearchProvider')).toBe(1);
    expect(host.countOf('network.fetchStream')).toBeGreaterThan(0);
    expect(host.hasListener('theme.changed')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--font-book')).not.toBe('');
    expect(shell.querySelector('.library-body')?.childElementCount).toBeGreaterThan(0);
  });

  it('מארח שאינו שולח runMode נחשב קדמי', async () => {
    const { host, shell } = boot(payloadFor());

    await vi.waitFor(() => expect(host.countOf('reader.registerExternalSearchProvider')).toBe(1));
    expect(host.countOf('network.fetchStream')).toBeGreaterThan(0);
    expect(host.hasListener('theme.changed')).toBe(true);
    expect(shell.querySelector('.library-body')?.childElementCount).toBeGreaterThan(0);
  });
});
