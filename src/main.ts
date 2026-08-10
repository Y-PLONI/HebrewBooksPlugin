import { AppController } from './app-controller';
import { getHostBridge } from './bridge';

const bridge = getHostBridge();

if (bridge) {
  const controller = new AppController(bridge);
  bridge.on('plugin.boot', ((payload: OtzariaBootPayload) => {
    void controller.boot(payload);
  }) as (payload: never) => void);
} else {
  document.body.replaceChildren();
  const message = document.createElement('p');
  message.className = 'browser-notice';
  message.textContent = 'יש לפתוח את התוסף מתוך אוצריא כדי להשתמש ב־SDK ובשירות החיפוש.';
  document.body.append(message);
}
