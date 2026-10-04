import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolved through node's lookup, not a fixed path: an agent worktree borrows the parent checkout's node_modules.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('typescript7/package.json'));
await import(pathToFileURL(join(root, 'bin', 'tsc')).href);
