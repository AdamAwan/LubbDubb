import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, loadThemePrefs } from './cockpit/theme.js';
import './styles.css';
// The console's own sheet, loaded here rather than from `console/`. A `.css`
// import inside those modules would be invisible to Vite's bundle graph in
// exactly one place that matters — `test/console.test.ts` imports them through
// `tsx`, which has no CSS loader and would throw on the import.
import './console/console.css';
// The presets. Overriding both token families at once, so it belongs to neither
// sheet — and it must load whichever way the styles arrive, which differs between
// dev (injected through JS) and production (an extracted bundle).
import './theme.css';

// Applied at module scope rather than from a hook. `<StrictMode>` double-invokes
// effects in dev, so a mount effect with a cleanup would apply, revert and apply
// again; module scope has no cleanup to get wrong. The inline script in
// `index.html` has already done the bare version of this before the first paint —
// this is the pass that filters against the token registry.
applyTheme(loadThemePrefs(), document.documentElement);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
