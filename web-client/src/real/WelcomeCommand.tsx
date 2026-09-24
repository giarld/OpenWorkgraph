import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

export function WelcomeCommand({ command, label, copyLabel }: { command: string; label?: string; copyLabel: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'copied' | 'failed'>();
  const container = useRef<HTMLDivElement>(null);
  function copyFallback(): boolean {
    const host = container.current;
    if (!host) return false;
    const focused = document.activeElement;
    const selection = document.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const input = document.createElement('textarea');
    input.value = command;
    input.readOnly = true;
    input.tabIndex = -1;
    input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    // Keep the temporary selection inside the modal: elements in document.body are inert.
    host.append(input);
    try {
      input.focus({ preventScroll: true });
      input.select();
      return document.execCommand('copy');
    } catch { return false; }
    finally {
      input.remove();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
      selection?.removeAllRanges();
      for (const range of ranges) selection?.addRange(range);
    }
  }
  async function copy() {
    setStatus(undefined);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        setStatus('copied');
        return;
      }
    } catch { /* Try the selection-based path when the Clipboard API is denied. */ }
    setStatus(copyFallback() ? 'copied' : 'failed');
  }
  return <div ref={container} className="welcome-command">
    <div className="welcome-command-row">
      <pre className="welcome-install-command" aria-label={label}><code>{command}</code></pre>
      <button type="button" className="icon-button welcome-command-copy" aria-label={copyLabel} title={copyLabel} onClick={() => void copy()}>
        {status === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
    </div>
    <span className={status === 'failed' ? 'welcome-command-error' : 'welcome-command-status'} role="status">
      {status === 'copied' ? t('Command copied.') : status === 'failed' ? t('Select the command and copy it manually.') : ''}
    </span>
  </div>;
}
