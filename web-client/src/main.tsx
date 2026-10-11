import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from './i18n/I18nProvider';
import './i18n/catalogs';
const RealApp = lazy(() =>
  import("./real/RealApp").then((module) => ({ default: module.RealApp })),
);
const VisualizeStandalone = lazy(() => import('./real/VisualizeStandalone').then(module => ({ default: module.VisualizeStandalone })));
import "./styles.css";
if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#workgraphs');
function LoadingWorkspace() {
  const { t } = useI18n();
  return <p role="status">{t('Loading workspace…')}</p>;
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Suspense fallback={<LoadingWorkspace />}>
      {new URLSearchParams(location.search).get('view') === 'visualize' ? <VisualizeStandalone /> : <RealApp />}
    </Suspense>
  </I18nProvider>,
);
