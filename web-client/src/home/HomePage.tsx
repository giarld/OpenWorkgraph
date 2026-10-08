import { useEffect, useLayoutEffect, useState } from 'react';
import { ArrowDown, ArrowRight, Code2, FileText, GitBranch, Moon, Sparkles, Sun } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import webClientPackage from '../../package.json';
import './catalog';
import './home.css';

export function HomePage() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('openworkgraph:theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  const [hidden, setHidden] = useState(document.hidden);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#181715' : '#f4f2ed');
    try { localStorage.setItem('openworkgraph:theme', theme); } catch { /* Keep in-memory preference. */ }
  }, [theme]);
  useEffect(() => { document.title = t('OpenWorkgraph · Home'); }, [t]);
  useEffect(() => {
    const sync = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return <div className="home-page">
    <header className="home-header">
      <a className="home-brand" href="./index.html" aria-label="OpenWorkgraph"><img src="/brand/openworkgraph-mark.svg" width="38" height="38" alt=""/><span>OpenWorkgraph</span></a>
      <nav className="home-tools" aria-label={t('Page settings')}>
        <span className="home-version" title={`OpenWorkgraph v${webClientPackage.version}`}>v{webClientPackage.version}</span>
        <a className="icon-button panel" href="https://github.com/giarld/OpenWorkgraph" target="_blank" rel="noopener noreferrer" aria-label={t('Open GitHub repository (opens in a new tab)')} title={t('Open GitHub repository (opens in a new tab)')}><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.467-1.332-5.467-5.93 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.523.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.653.243 2.873.12 3.176.77.84 1.235 1.911 1.235 3.221 0 4.61-2.807 5.625-5.479 5.922.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg></a>
        <LanguageSwitcher/>
        <button className="icon-button panel" aria-label={t('Toggle theme')} title={t('Toggle theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={19}/> : <Moon size={19}/>}</button>
      </nav>
    </header>
    <main>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-copy">
          <p className="home-eyebrow"><span/>{t('An open space for your workflow')}</p>
          <h1 id="home-title">{t('Connect ideas.')}<br/><span>{t('Move work forward.')}</span></h1>
          <p className="home-intro">{t('Spread out your ideas and connect your thoughts. Organize creativity and development freely in a Work Graph, bringing clarity and structure to complex work. Add your favorite skills, explore new possibilities, and make your Work Graph more than just work.')}</p>
          <a className="home-cta" href="./workgraphs.html#workgraphs">{t('Open Work Graph')}<ArrowRight size={19}/></a>
          <a className="home-explore" href="#examples">{t('Explore the possibilities')}<ArrowDown size={14}/></a>
        </div>
        <div className="home-visual" data-paused={hidden}>
          <div className="home-graph" aria-hidden="true">
            <svg className="home-wires" viewBox="0 0 600 480" fill="none">
              <path d="M140 130 C240 130 190 242 294 242 M140 350 C240 350 190 242 294 242 M294 242 C415 242 370 130 478 130 M294 242 C415 242 370 350 478 350"/>
              <path className="home-flow" d="M140 130 C240 130 190 242 294 242 M140 350 C240 350 190 242 294 242 M294 242 C415 242 370 130 478 130 M294 242 C415 242 370 350 478 350"/>
              <circle cx="294" cy="242" r="105" className="home-orbit"/>
            </svg>
            <div className="home-node home-node-idea"><span className="home-node-icon"><FileText size={21}/></span><strong>{t('An idea')}</strong><span className="home-node-lines"/></div>
            <div className="home-node home-node-plan"><span className="home-node-icon"><GitBranch size={21}/></span><strong>{t('A clear plan')}</strong><span className="home-node-lines"/></div>
            <div className="home-node home-node-code"><span className="home-node-icon"><Code2 size={21}/></span><strong>{t('Build together')}</strong><span className="home-node-lines"/></div>
            <div className="home-node home-node-result"><span className="home-node-icon"><Sparkles size={21}/></span><strong>{t('Something real')}</strong><span className="home-node-lines"/></div>
            <div className="home-hub"><img src="/brand/openworkgraph-mark.svg" width="76" height="76" alt=""/></div>
          </div>
        </div>
      </section>
      <section className="home-examples" id="examples" aria-labelledby="examples-title">
        <div className="home-section-heading"><div><p className="home-eyebrow">{t('A little inspiration')}</p><h2 id="examples-title">{t('Start with a possibility.')}</h2></div><span className="home-coming">{t('Examples coming soon')}</span></div>
        <div className="home-example-grid">
          {([['01', Code2, 'From a brief to a build', 'Turn a software idea into connected, actionable steps.'], ['02', FileText, 'From research to clarity', 'Bring your materials, thinking, and conclusions together.'], ['03', GitBranch, 'A workflow of your own', 'Give your next project a shape that works for you.']] as const).map(([number, Icon, title, description]) => <article className="home-example" key={number}><div className="home-example-top"><Icon size={22}/><span>{number}</span></div><h3>{t(title)}</h3><p>{t(description)}</p></article>)}
        </div>
      </section>
    </main>
    <footer className="home-footer"><span>OpenWorkgraph</span><span>{t('Ideas connected. Work in motion.')}</span></footer>
  </div>;
}
