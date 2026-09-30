// → docs/spec/37-bot-prs.md#what-the-agent-is-given

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'packages.lock.json',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
  'gradle.lockfile',
]);

/** Most of a dependency bot's diff and none of its meaning: its contents are never read or shown. */
export function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1));
}
