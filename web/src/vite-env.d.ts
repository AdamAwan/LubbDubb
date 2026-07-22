// Vite injects these on `import.meta.env`. We only declare what the app reads;
// the demo build sets VITE_DEMO=1 (see web/.env.demo) to swap in the fake backend.
interface ImportMetaEnv {
  readonly VITE_DEMO?: string;
  readonly BASE_URL: string;
  readonly MODE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
