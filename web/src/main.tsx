import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { languagePref, setLanguage } from './i18n';
import './styles.css';

// The language loads before the first paint, so nobody sees English flash first.
setLanguage(languagePref(), false).then(() => createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>));

// Installable app: register the shell cache in production builds only (dev uses Vite's live reload).
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
