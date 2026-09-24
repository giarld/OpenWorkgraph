import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from './i18n/I18nProvider';
import './i18n/catalogs';
const RealApp = lazy(() =>
  import("./real/RealApp").then((module) => ({ default: module.RealApp })),
);
import "./styles.css";
function LoadingWorkspace() {
  const { t } = useI18n();
  return <p role="status">{t('Loading workspace…')}</p>;
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Suspense fallback={<LoadingWorkspace />}>
      <RealApp />
    </Suspense>
  </I18nProvider>,
);
