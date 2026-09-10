import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.testbuild');
const SOURCES = ['src', 'test', 'scripts', join('web', 'src')];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = SOURCES.flatMap((dir) => walk(join(ROOT, dir)));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

execFileSync(
  join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    ...files.filter((p) => p.endsWith('.ts') || p.endsWith('.tsx')).map((p) => relative(ROOT, p)),
    `--outdir=${relative(ROOT, OUT)}`,
    '--outbase=.',
    '--format=esm',
    '--platform=node',
    '--target=node20',
    '--jsx=automatic',
    '--sourcemap',
    '--log-level=warning',
  ],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
);

for (const asset of files.filter((p) => !p.endsWith('.ts') && !p.endsWith('.tsx'))) {
  const dest = join(OUT, relative(ROOT, asset));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(asset, dest);
}
