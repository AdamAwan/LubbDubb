import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
// Every skin's stylesheet, loaded here rather than from the skin's own module.
// A `.css` import inside a skin would be invisible to Vite's bundle graph in
// exactly one place that matters — `test/cockpitSkins.test.ts` imports the skin
// modules through `tsx`, which has no CSS loader and would throw on the import.
// Each sheet is scoped to its own `[data-skin]` selector, so loading them all
// costs a few kilobytes and collides with nothing.
import './skins/factory/skin.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
