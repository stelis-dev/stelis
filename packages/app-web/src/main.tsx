import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AppConfigProvider } from './AppConfigContext';
import App from './App';
import './globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppConfigProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </AppConfigProvider>
  </StrictMode>,
);
