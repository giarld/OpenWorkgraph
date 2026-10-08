import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n/I18nProvider';
import './i18n/catalogs';
import { HomePage } from './home/HomePage';
import './styles.css';

// Preserve bookmarks from the former single-page entry.
if (['#workgraphs', '#editor'].includes(location.hash)) {
  location.replace('./workgraphs.html' + location.search + location.hash);
} else {
  createRoot(document.getElementById('root')!).render(<I18nProvider><HomePage /></I18nProvider>);
}
