import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * The directories the bundle is cut along, on top of `node_modules`. Named rather
 * than globbed: a group rolldown decides to fold back in is a silent no-op, so
 * the list says which cuts are actually load-bearing and `web:build`'s own
 * per-chunk sizes are what settles whether a new one is.
 *
 * Only `.ts`/`.tsx` are matched. `main.tsx` imports `styles.css`, `console.css`
 * and `theme.css` in that order and the last is written to override the first
 * two — but a CSS module pulled into a chunk takes that chunk's place in the
 * emitted sheet rather than its import position, which reorders the cascade with
 * nothing red and a symptom only on whichever surface the two sheets tie on.
 */
const CHUNK_DIRS = ['cockpit', 'components', 'console', 'view'];

// The SPA lives in web/ and builds to web/dist, which the Fastify server serves
// in production. In dev, `npm run web:dev` proxies /api and /ws to the server.
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4300',
      '/ws': { target: 'ws://localhost:4300', ws: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Eager chunks, never lazy ones: every chunk below is a static import of
        // the entry, so the browser fetches the whole graph on load exactly as it
        // did when this was one 635 kB file. A chunk fetched later — on a panel
        // opening — would instead fail *mid-session* against a `web/dist` rebuilt
        // underneath it, where a whole-graph fetch fails at load and one reload
        // fixes it. That is the staleness story the SPA fallback already tells
        // (docs/spec/16-http-api.md#the-spa-fallback), and it is worth keeping to
        // one.
        //
        // What the cut buys is a cache that survives an upgrade — a cockpit change
        // rehashes the one chunk it touched, not all of it — and per-chunk sizes
        // that sit under Vite's 500 kB warning honestly, so the warning still
        // means something when a directory really does outgrow it.
        codeSplitting: {
          groups: [
            { name: 'vendor', test: /node_modules/ },
            // Both separators: module ids are native paths, so a Windows build
            // sees backslashes and a rule anchored on `/` matches nothing there —
            // quietly, since the only symptom is a chunk that is never emitted.
            ...CHUNK_DIRS.map((dir) => ({
              name: dir,
              test: new RegExp(`[\\\\/]web[\\\\/]src[\\\\/]${dir}[\\\\/][^?]*\\.tsx?$`),
            })),
          ],
        },
      },
    },
  },
});
