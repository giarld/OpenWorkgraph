import { Check, Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LanguagePreference } from './core';
import { useI18n } from './I18nProvider';

export function LanguageSwitcher() {
  const { preference, setPreference, t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const options: Array<{ value: LanguagePreference; label: string }> = [
    { value: 'system', label: t('Follow system') },
    { value: 'zh-CN', label: t('Simplified Chinese') },
    { value: 'en', label: t('English') },
  ];
  const focusTrigger = () => root.current?.querySelector<HTMLButtonElement>('.language-trigger')?.focus();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        focusTrigger();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <div className="language-switcher" ref={root}>
    <button
      type="button"
      className="icon-button panel language-trigger"
      aria-label={t('Change language')}
      title={t('Change language')}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
    ><Languages size={18} /></button>
    {open && <div className="language-menu panel" role="menu" aria-label={t('Language')}>
      {options.map(option => <button
        type="button"
        role="menuitemradio"
        aria-checked={preference === option.value}
        key={option.value}
        onClick={() => { setPreference(option.value); setOpen(false); requestAnimationFrame(focusTrigger); }}
      >
        <span>{option.label}</span>
        {preference === option.value && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>;
}
