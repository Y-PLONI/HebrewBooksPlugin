import { getHostBridge } from './bridge';
import { CatalogMappingRepository } from './repositories/catalog-mapping-repository';
import { HebrewBooksRepository } from './repositories/hebrewbooks-repository';
import { OtzariaSearchRepository } from './repositories/otzaria-search-repository';
import { ExternalSearchServer } from './services/external-search-server';

/// מופע הרקע של התוסף (contributes.background.entrypoint). אוצריא משגרת אליו
/// לבדו את search.external.requested ו-reader.inBookSearch.requested כשהוא
/// קיים, ולכן הוא זה שחייב לענות עליהם — אין כאן מסך, ערכת נושא או pdf.js.
const bridge = getHostBridge();

if (bridge) {
  const server = new ExternalSearchServer({
    repository: new HebrewBooksRepository(bridge),
    otzaria: new OtzariaSearchRepository(bridge),
    catalogMapping: new CatalogMappingRepository(bridge),
  });
  // המאזינים נרשמים מיד: האירוע שמעיר את מופע הרקע עשוי להגיע לפני plugin.boot.
  server.listen(bridge);
  bridge.on('plugin.boot', (() => {
    void server.registerProviders();
  }) as (payload: never) => void);
}
