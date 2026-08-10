import { AppController } from './app-controller';
import { getHostBridge } from './bridge';

const bridge = getHostBridge();
const shell = document.getElementById('app-shell');

if (!shell) {
  throw new Error('חסר מיכל האפליקציה (#app-shell)');
}

if (bridge) {
  const controller = new AppController(bridge, shell);
  bridge.on('plugin.boot', ((payload: OtzariaBootPayload) => {
    void controller.boot(payload);
  }) as (payload: never) => void);
} else {
  const message = document.createElement('p');
  message.className = 'browser-notice';
  message.textContent = 'יש לפתוח את התוסף מתוך אוצריא כדי להשתמש ב־SDK ובשירות החיפוש.';
  shell.replaceChildren(message);
}
