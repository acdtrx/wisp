import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Offline shell (see public/sw.js). Prod only — in dev vite serves the bundle and
// a worker caching it would shadow every edit. `navigator.serviceWorker` is
// undefined outside a secure context, so a plain-HTTP install skips this and
// simply runs without the offline shell.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration is best-effort — the app is fully functional online without it.
    });
  });
}
