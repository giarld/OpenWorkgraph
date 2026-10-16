import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bot, Box, ChartNoAxesCombined, Code2, Database, FileText, Film, GitBranch, Globe, Image, Moon, Music2, Palette, Presentation, Sun } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import webClientPackage from '../../package.json';
import './catalog';
import './home.css';

// Shared SVG coordinates keep every connection attached at all viewport sizes.
const resourcePath = (x: number, y: number) => `M 136 240 C 214 240 ${x - 128} ${y} ${x - 30} ${y}`;

const creationResources = [
  { id: 'code', Icon: Code2, x: 278, y: 62, tone: 'blue' },
  { id: 'document', Icon: FileText, x: 314, y: 174, tone: 'green' },
  { id: 'image', Icon: Image, x: 414, y: 116, tone: 'violet' },
  { id: 'website', Icon: Globe, x: 538, y: 52, tone: 'blue' },
  { id: 'video', Icon: Film, x: 552, y: 166, tone: 'rose' },
  { id: 'presentation', Icon: Presentation, x: 432, y: 240, tone: 'amber' },
  { id: 'design', Icon: Palette, x: 560, y: 278, tone: 'violet' },
  { id: 'audio', Icon: Music2, x: 416, y: 364, tone: 'rose' },
  { id: 'data', Icon: Database, x: 314, y: 306, tone: 'blue' },
  { id: 'chart', Icon: ChartNoAxesCombined, x: 540, y: 396, tone: 'green' },
  { id: 'model', Icon: Box, x: 278, y: 418, tone: 'amber' },
  { id: 'workflow', Icon: GitBranch, x: 428, y: 458, tone: 'green' },
].map((resource, index) => ({
  ...resource,
  path: resourcePath(resource.x, resource.y),
  period: 18 + (index % 5) * 2,
  phase: index * 2.4,
}));

export function HomePage() {
  const { t, language } = useI18n();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('openworkgraph:theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  const [hidden, setHidden] = useState(document.hidden);
  const creationRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#181715' : '#f4f2ed');
    try { localStorage.setItem('openworkgraph:theme', theme); } catch { /* Keep in-memory preference. */ }
  }, [theme]);
  useEffect(() => { document.title = t('OpenWorkgraph · Visual Agent Workbench'); }, [t]);
  useEffect(() => {
    const svg = creationRef.current;
    if (!svg) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const nodes = svg.querySelectorAll<SVGGElement>('.home-resource');
    const wires = svg.querySelectorAll<SVGPathElement>('.home-wires path');
    const signals = svg.querySelectorAll<SVGPathElement>('.home-signal');
    let frame = 0;
    let elapsed = 0;
    let previousTime: number | null = null;

    const positionResources = (moving: boolean) => {
      creationResources.forEach((resource, index) => {
        const angle = elapsed / resource.period * Math.PI * 2 + resource.phase;
        const x = resource.x + (moving ? Math.cos(angle) * 6 : 0);
        const y = resource.y + (moving ? Math.sin(angle) * 8 : 0);
        const path = resourcePath(x, y);
        nodes[index].setAttribute('transform', `translate(${x} ${y})`);
        wires[index].setAttribute('d', path);
        signals[index].setAttribute('d', path);
      });
    };
    const animate = (time: number) => {
      if (previousTime !== null) elapsed += (time - previousTime) / 1000;
      previousTime = time;
      // Update nodes and both wire layers together without rerendering the page.
      positionResources(true);
      frame = requestAnimationFrame(animate);
    };
    const sync = () => {
      setHidden(document.hidden);
      cancelAnimationFrame(frame);
      previousTime = null;
      if (reducedMotion.matches) positionResources(false);
      else if (!document.hidden) frame = requestAnimationFrame(animate);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
    };
  }, []);
  return <div className="home-page">
    <header className="home-header">
      <a className="home-brand" href="./index.html" aria-label={t('OpenWorkgraph')}><img src="/brand/openworkgraph-mark.svg" width="38" height="38" alt=""/><span>{t('OpenWorkgraph')}</span></a>
      <nav className="home-tools" aria-label={t('Page settings')}>
        <span className="home-version" title={`${t('OpenWorkgraph')} v${webClientPackage.version}`}>v{webClientPackage.version}</span>
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
          <h1 id="home-title"><span className="home-title-visual">{t('Visual')}</span>{language === 'en' ? ' ' : ''}<span className="home-title-workbench">{t('Agent Workbench')}</span></h1>
          {language === 'zh-CN' && <p className="home-title-english" lang="en">Visual Agent Workbench</p>}
          <p className="home-intro">{t('Customize your workflows. Make agents easier to use, ')}<strong>{t('work more efficiently')}</strong>{t(', and bring ideas to life faster.')}</p>
          <a className="home-cta" href="./workgraphs.html#workgraphs">{t('Get started')}<ArrowRight size={19}/></a>
          <a className="home-explore" href="#examples">{t('Explore the possibilities')}<ArrowDown size={14}/></a>
        </div>
        <div className="home-visual" data-paused={hidden}>
          <div className="home-graph" aria-hidden="true">
            <svg ref={creationRef} className="home-creation" viewBox="0 0 600 510" fill="none" focusable="false">
              <g className="home-wires">
                {creationResources.map(resource => <path key={resource.id} d={resource.path}/>)}
              </g>
              <g className="home-flow">
                {creationResources.map((resource, index) => <path
                  key={resource.id}
                  className={`home-signal home-tone-${resource.tone}`}
                  d={resource.path}
                  pathLength={100}
                  style={{ animationDelay: `${index * -.65}s` }}
                />)}
              </g>
              {creationResources.map(({ id, Icon, x, y, tone }) => <g key={id} className={`home-resource home-tone-${tone}`} transform={`translate(${x} ${y})`}>
                <rect className="home-resource-card" x={-30} y={-30} width={60} height={60} rx={16}/>
                <circle className="home-resource-port" cx={-30} cy={0} r={3}/>
                <Icon x={-13} y={-13} size={26} strokeWidth={1.65}/>
              </g>)}
              <g className="home-agent" transform="translate(88 240)">
                <rect className="home-agent-halo" x={-61} y={-61} width={122} height={122} rx={36}/>
                <rect className="home-agent-card" x={-48} y={-48} width={96} height={96} rx={27}/>
                <Bot x={-26} y={-26} size={52} strokeWidth={1.5}/>
                <circle className="home-agent-port" cx={48} cy={0} r={4}/>
              </g>
            </svg>
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
    <footer className="home-footer"><span>{t('OpenWorkgraph')}</span><span>{t('AI creates all things. All things converge in the forge.')}</span></footer>
  </div>;
}
