import { HebrewBooksSnippetRepository } from './repositories/hebrewbooks-snippet-repository';
import { snippetSourceGlobalKey } from './services/lazy-snippet-source';

/// נקודת הכניסה של assets/snippets.js — pdf.js ומחלץ הטקסט שנטענים רק
/// כשמופע הרקע נזקק לגזיר ראשון (ראו lazy-snippet-source).
(globalThis as Record<string, unknown>)[snippetSourceGlobalKey] =
  new HebrewBooksSnippetRepository();
