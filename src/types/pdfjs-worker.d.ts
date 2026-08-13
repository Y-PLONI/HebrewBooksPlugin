// מודול ה-worker של pdf.js מגיע בלי הצהרות טיפוסים; אנחנו רק מציבים אותו
// ב-globalThis.pdfjsWorker כדי ש-pdf.js ירוץ על ה-main thread (ראו
// hebrewbooks-snippet-repository.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown;
}
