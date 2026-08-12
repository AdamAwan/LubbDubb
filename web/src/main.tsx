import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
// The floor's own sheet, loaded here rather than from `factory/`. A `.css` import
// inside those modules would be invisible to Vite's bundle graph in exactly one
// place that matters — `test/factoryFloor.test.ts` imports them through `tsx`,
// which has no CSS loader and would throw on the import.
import './factory/factory.css';
// The console's own sheet, for the same reason: `test/console.test.ts` imports
// its modules through `tsx`, which has no CSS loader and would throw if the
// import lived under `console/` instead.
import './console/console.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
