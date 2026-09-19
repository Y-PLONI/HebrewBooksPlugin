import { AppController } from './app-controller';
import type { HostBridge } from './bridge';
import { OtzariaSearchRepository } from './repositories/otzaria-search-repository';

/// אוצריא מריצה מופע רקע (app.run_on_startup + contributes.startup) נוסף על
/// הלשונית הנראית, ושולחת לכל אחד plugin.boot משלו. מארח ותיק אינו שולח את
/// השדה — ואז זו ריצה קדמית רגילה.
export function isBackgroundBoot(payload: OtzariaBootPayload): boolean {
  return payload?.app?.runMode === 'background';
}

/// אתחול מופע הרקע: רק רישום ספקי החיפוש, כדי שהאירועים הממוקדים יגיעו
/// אליו. אין מסך, ולכן אין ערכת נושא, קריאת הגדרות ובדיקת /health.
export async function bootBackgroundInstance(bridge: HostBridge): Promise<void> {
  const repository = new OtzariaSearchRepository(bridge);
  await repository.registerInBookSearchProvider().catch(() => undefined);
  await repository.registerExternalSearchProvider().catch(() => undefined);
}

/// ה-AppController נבנה עוד לפני ה-boot כי המאזינים שבבנאי הם שמגישים את
/// אירועי החיפוש הממוקדים — גם אלה שמעירים את מופע הרקע.
export function installBoot(bridge: HostBridge, shell: HTMLElement): void {
  const controller = new AppController(bridge, shell);
  bridge.on('plugin.boot', ((payload: OtzariaBootPayload) => {
    if (isBackgroundBoot(payload)) {
      void bootBackgroundInstance(bridge);
      return;
    }
    void controller.boot(payload);
  }) as (payload: never) => void);
}
