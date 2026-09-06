import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, loadThemePrefs } from './cockpit/theme.js';
import './styles.css';
// TECHDEBT: the console's own sheet, loaded here rather than from `console/`. A `.css`
// import inside those modules would be invisible to Vite's bundle graph in
// exactly one place that matters — `test/console.test.ts` imports them through
// `tsx`, which has no CSS loader and would throw on the import.
import './console/console.css';
import './theme.css';

// → docs/spec/17-cockpit.md

applyTheme(loadThemePrefs(), document.documentElement);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
