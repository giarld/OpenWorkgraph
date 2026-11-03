import { installVisualizeActivityController } from './visualize-activity';

/** Keep scripts in an opaque origin: never add allow-same-origin here. */
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';
export const HTML_PREVIEW_PERMISSIONS = [
  'camera', 'microphone', 'geolocation', 'clipboard-read', 'clipboard-write',
  'display-capture', 'fullscreen', 'payment', 'usb', 'serial',
].map(feature => feature + " 'none'").join('; ');
export const HTML_PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'",
  "worker-src 'none'", "frame-src 'none'", "object-src 'none'",
  "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  'media-src data: blob:', "form-action 'none'", "base-uri 'none'",
].join('; ');

/** Scripts may update their own document, but receive no host capabilities.
 * CSP controls resource/API loads; sandbox controls origin and browser actions.
 * This is not a CPU quota or a general network firewall (self-navigation is a
 * browser limitation). No postMessage bridge grants runtime or storage access.
 */
function installFileContextMenu(config: { hostOrigin: string; sessionId: string }) {
  let enabled = false;
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source === window.parent && event.origin === config.hostOrigin && data?.channel === 'openworkgraph.file.contextmenu.enable' && data.sessionId === config.sessionId) enabled = data.enabled === true;
  });
  window.addEventListener('contextmenu', event => {
    if (!enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage({ channel: 'openworkgraph.file.contextmenu', sessionId: config.sessionId, x: event.clientX, y: event.clientY }, config.hostOrigin);
  }, true);
}

export function buildHtmlPreviewDocument(text: string, activity?: { hostOrigin: string; sessionId: string; nodeId: string }): string {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('iframe,frame,object,embed,base,meta,link').forEach(node => node.remove());
  doc.querySelectorAll('*').forEach(node => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (['action','formaction','target','srcdoc','ping'].includes(name) ||
        (name === 'href' && !attribute.value.startsWith('#'))) node.removeAttribute(attribute.name);
    }
  });
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = HTML_PREVIEW_CSP;
  if (activity) {
    const controller = doc.createElement('script');
    controller.textContent = '(' + installVisualizeActivityController.toString() + ')(' + JSON.stringify(activity).replaceAll('<', '\\u003c') + ');';
    doc.head.prepend(controller);
    const menu = doc.createElement('script');
    menu.textContent = '(' + installFileContextMenu.toString() + ')(' + JSON.stringify(activity).replaceAll('<', '\\u003c') + ');';
    doc.head.prepend(menu);
  }
  doc.head.prepend(policy);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
