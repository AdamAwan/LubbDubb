import type { ConfigField } from './configFields.js';

export const DEPLOYMENT_FIELDS: readonly ConfigField[] = [
  {
    path: 'repoRoot',
    type: 'string',
    access: 'advanced',
    env: 'LUBBDUBB_REPO_ROOT',
    why: 'The git repository worktrees are cut from.',
  },
  {
    path: 'defaultBranch',
    type: 'string',
    access: 'advanced',
    why: 'The integration branch. Not auto-detected.',
  },
  { path: 'worktreeRoot', type: 'string', access: 'advanced', why: 'Root for the pool of worktree slot directories.' },
  {
    path: 'prewarmWorktrees',
    type: 'boolean',
    access: 'advanced',
    why: 'Ready one pool slot between cycles, so a dispatch finds it already wiped and checked out instead of paying for that on the serial executor loop. Off means every dispatch prepares its own slot.',
  },
  { path: 'deskRoot', type: 'string', access: 'advanced', why: 'Scratch root for desk agents.' },
  { path: 'attachmentRoot', type: 'string', access: 'advanced', why: 'Where brief attachments are written.' },
  { path: 'validationRoot', type: 'string', access: 'advanced', why: 'Where validation resources are written.' },
  {
    path: 'localRunRoot',
    type: 'string',
    access: 'advanced',
    why: 'The local run’s own checkout. Must not be under worktreeRoot — the pool would claim it as a slot.',
  },
  { path: 'promptTemplatesDir', type: 'string', access: 'advanced', why: 'Where prompt-book overrides are read from.' },
  {
    path: 'docsFolderPrefix',
    type: 'json',
    access: 'advanced',
    why: 'Path prefixes an agent’s artifacts may be read from.',
  },
  {
    path: 'dbPath',
    type: 'string',
    access: 'advanced',
    env: 'LUBBDUBB_DB',
    why: 'SQLite file.',
  },

  { path: 'port', type: 'number', access: 'advanced', env: 'PORT', why: 'HTTP/WS port.' },
  {
    path: 'host',
    type: 'string',
    access: 'advanced',
    env: 'LUBBDUBB_HOST',
    why: 'Bind address. Anything off-loopback requires auth.enabled.',
  },
  {
    path: 'auth.enabled',
    type: 'boolean',
    access: 'advanced',
    why: 'Require a bearer token on /api/* and /ws.',
  },
  {
    path: 'auth.tokenFile',
    type: 'string',
    access: 'advanced',
    why: 'Where a minted token is persisted. Ignored when LUBBDUBB_TOKEN is set.',
  },
  {
    path: 'ingress.debounceMs',
    type: 'number',
    ms: true,
    access: 'advanced',
    why: 'How long a burst of webhook deliveries settles before one cycle fires.',
  },
  {
    path: 'ingress.minCycleGapMs',
    type: 'number',
    ms: true,
    access: 'advanced',
    why: 'Floor between two cycles a delivery may cause. The one lever on what an inbound flood can spend of this fleet’s provider budget.',
  },
  {
    path: 'ingress.requestsPerMinute',
    type: 'number',
    access: 'advanced',
    why: 'Deliveries accepted per minute across the whole endpoint before a 429. Keyed to the endpoint, not the caller: a webhook arrives from a whole address range.',
  },
  {
    path: 'ingress.maxBodyBytes',
    type: 'number',
    access: 'advanced',
    why: 'Largest delivery body read before a 413. Bounds the work an unverified caller can buy.',
  },
];
