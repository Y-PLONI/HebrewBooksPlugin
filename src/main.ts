import { installBoot } from './boot';
import { getHostBridge } from './bridge';

const bridge = getHostBridge();
const shell = document.getElementById('app-shell');

if (!shell) {
  throw new Error('חסר מיכל האפליקציה (#app-shell)');
}

if (bridge) {
  installBoot(bridge, shell);
} else {
  const message = document.createElement('p');
  message.className = 'browser-notice';
  message.textContent = 'יש לפתוח את התוסף מתוך אוצריא כדי להשתמש ב־SDK ובשירות החיפוש.';
  shell.replaceChildren(message);
}
