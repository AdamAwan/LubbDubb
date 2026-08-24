import { createRequire } from 'node:module';

/**
 * What build this fleet is running, as the pool's envelope reports it.
 *
 * **Reported, never acted on.** Nothing compares two fleets' harness versions and
 * nothing is skipped because of one — that job belongs to `POOL_SCHEMA_VERSION`,
 * which is a number this build either understands or does not. This is the human
 * half of the same question: an operator looking at a fleet that has stopped
 * publishing wants to know what it is running, and a page that could only say
 * "ahead" would be answering a narrower question than the one they have.
 *
 * Read from `package.json` through `createRequire` — the shape `src/pty/backend.ts`
 * already uses — rather than a constant here, which would be a second statement of
 * the version free to drift from the one every release bumps.
 */
export function harnessVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    // A build served from somewhere the manifest did not come along to is a build
    // that still publishes. `unknown` is the honest answer, and it is drawn as one.
    return 'unknown';
  }
}
